/**
 * CLI Utilities for J.A.R.V.I.S.
 *
 * Shared helpers for the interactive CLI: prompts, colors, spinners.
 * Zero external dependencies — uses built-in readline and ANSI codes.
 */

import * as readline from 'node:readline';
import { createReadStream, openSync, closeSync, readFileSync, existsSync } from 'node:fs';

// ── ANSI Colors ──────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';

export const c = {
  bold: (s: string) => `${BOLD}${s}${RESET}`,
  dim: (s: string) => `${DIM}${s}${RESET}`,
  cyan: (s: string) => `${CYAN}${s}${RESET}`,
  green: (s: string) => `${GREEN}${s}${RESET}`,
  yellow: (s: string) => `${YELLOW}${s}${RESET}`,
  red: (s: string) => `${RED}${s}${RESET}`,
  magenta: (s: string) => `${MAGENTA}${s}${RESET}`,
  blue: (s: string) => `${BLUE}${s}${RESET}`,
};

// ── Readline Interface ───────────────────────────────────────────────

let rl: readline.Interface | null = null;
let ttyStream: ReturnType<typeof createReadStream> | null = null;

/**
 * Get a readline interface connected to the terminal.
 * When stdin is a pipe (e.g. `curl | bash`), falls back to /dev/tty.
 */
function getRL(): readline.Interface {
  if (!rl) {
    let input: NodeJS.ReadableStream = process.stdin;

    // When stdin is not a TTY (piped), open /dev/tty directly
    if (!process.stdin.isTTY) {
      try {
        // Test that /dev/tty is actually openable (fails in headless/CI)
        const fd = openSync('/dev/tty', 'r');
        closeSync(fd);
        ttyStream = createReadStream('/dev/tty');
        input = ttyStream;
      } catch {
        // No controlling terminal available — fall back to stdin
      }
    }

    rl = readline.createInterface({ input, output: process.stdout });

    // If the readline closes unexpectedly (EOF), null it so the next
    // call to getRL() creates a fresh one from /dev/tty.
    rl.on('close', () => { rl = null; });
  }
  return rl;
}

export function closeRL(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
  if (ttyStream) {
    ttyStream.close();
    ttyStream = null;
  }
}

// ── Prompt Helpers ───────────────────────────────────────────────────

/**
 * Ask a free-text question. Returns trimmed answer.
 */
export function ask(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` ${c.dim(`[${defaultValue}]`)}` : '';
    getRL().question(`${c.cyan('?')} ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Ask for a secret (API key, token). Masks input with asterisks.
 */
export function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return ask(question);
  }

  return new Promise((resolve) => {
    const r = getRL();
    process.stdout.write(`${c.cyan('?')} ${question}: `);

    // Temporarily disable echo
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    let input = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
    };

    const onData = (char: Buffer) => {
      try {
        const ch = char.toString();
        if (ch === '\n' || ch === '\r') {
          cleanup();
          process.stdout.write('\n');
          resolve(input.trim());
        } else if (ch === '\x7f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch === '\x03') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch.charCodeAt(0) >= 32) {
          input += ch;
          process.stdout.write('*');
        }
      } catch {
        cleanup();
        process.stdout.write('\n');
        resolve(input.trim());
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Ask a yes/no question. Returns boolean.
 */
export function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    getRL().question(`${c.cyan('?')} ${question} ${c.dim(`(${hint})`)}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

/**
 * Ask user to pick from a list of options.
 * Supports arrow keys (up/down) and number keys for selection.
 * Falls back to simple numbered input when raw mode is unavailable.
 */
export function askChoice<T extends string>(
  question: string,
  options: { label: string; value: T; description?: string }[],
  defaultValue?: T
): Promise<T> {
  let selected = 0;
  options.forEach((opt, i) => {
    if (opt.value === defaultValue) selected = i;
  });

  const stdin = process.stdin;

  // Fall back to simple numbered input if raw mode is unavailable
  if (!stdin.isTTY || !stdin.setRawMode) {
    return askChoiceFallback(question, options, selected);
  }

  return new Promise((resolve) => {
    // Pause readline so it doesn't compete for stdin
    if (rl) { rl.pause(); }

    console.log(`\n${c.cyan('?')} ${question} ${c.dim('(↑↓ to move, enter to select)')}`);

    function renderLine(i: number): string {
      const opt = options[i]!;
      const marker = i === selected ? c.cyan('❯') : ' ';
      const label = i === selected ? c.cyan(opt.label) : opt.label;
      const desc = opt.description ? ` ${c.dim(`- ${opt.description}`)}` : '';
      return `  ${marker} ${label}${desc}`;
    }

    function render() {
      // Move cursor up to overwrite previous render
      options.forEach(() => process.stdout.write('\x1b[A'));
      for (let i = 0; i < options.length; i++) {
        process.stdout.write(`\r\x1b[K${renderLine(i)}\n`);
      }
    }

    // Initial draw
    for (let i = 0; i < options.length; i++) {
      console.log(renderLine(i));
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw ?? false); } catch { /* already restored */ }
      if (rl) { rl.resume(); }
    };

    const onData = (data: Buffer) => {
      try {
        const key = data.toString();

        if (key === '\x1b[A' || key === 'k') {
          selected = (selected - 1 + options.length) % options.length;
          render();
        } else if (key === '\x1b[B' || key === 'j') {
          selected = (selected + 1) % options.length;
          render();
        } else if (key === '\r' || key === '\n') {
          cleanup();
          // Overwrite the list with final selection
          for (let i = 0; i < options.length; i++) process.stdout.write('\x1b[A');
          for (let i = 0; i < options.length; i++) {
            process.stdout.write(`\r\x1b[K`);
            if (i < options.length - 1) process.stdout.write('\n');
          }
          process.stdout.write(`\r\x1b[K  ${c.green('✓')} ${options[selected]!.label}\n`);
          resolve(options[selected]!.value);
        } else if (key === '\x03') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else {
          const num = parseInt(key, 10);
          if (num >= 1 && num <= options.length) {
            selected = num - 1;
            render();
          }
        }
      } catch {
        cleanup();
        resolve(options[selected]!.value);
      }
    };

    stdin.on('data', onData);
  });
}

/** Simple fallback for non-TTY environments. */
function askChoiceFallback<T extends string>(
  question: string,
  options: { label: string; value: T; description?: string }[],
  defaultIdx: number,
): Promise<T> {
  return new Promise((resolve) => {
    console.log(`\n${c.cyan('?')} ${question}`);
    options.forEach((opt, i) => {
      const marker = i === defaultIdx ? c.cyan('>') : ' ';
      const desc = opt.description ? ` ${c.dim(`- ${opt.description}`)}` : '';
      console.log(`  ${marker} ${c.bold(`${i + 1}.`)} ${opt.label}${desc}`);
    });

    getRL().question(`${c.dim(`Enter choice [1-${options.length}]`)}: `, (answer) => {
      const a = answer.trim();
      if (a === '') { resolve(options[defaultIdx]!.value); return; }
      const idx = parseInt(a, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!.value);
      } else {
        const match = options.find(o =>
          o.value.toLowerCase() === a.toLowerCase() ||
          o.label.toLowerCase() === a.toLowerCase()
        );
        resolve(match ? match.value : options[defaultIdx]!.value);
      }
    });
  });
}

// ── Display Helpers ──────────────────────────────────────────────────

/**
 * Print a step indicator: [2/9] Title
 */
export function printStep(current: number, total: number, title: string): void {
  console.log(`\n${c.cyan(`[${current}/${total}]`)} ${c.bold(title)}`);
  console.log(c.dim('─'.repeat(50)));
}

/**
 * Print the JARVIS ASCII banner.
 */
export function printBanner(): void {
  console.log(c.cyan(`
     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
     ██║███████║██████╔╝██║   ██║██║███████╗
██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝`));
  console.log(c.dim('  Just A Rather Very Intelligent System\n'));
}

/**
 * Print a success message with checkmark.
 */
export function printOk(message: string): void {
  console.log(`  ${c.green('✓')} ${message}`);
}

/**
 * Print a warning message.
 */
export function printWarn(message: string): void {
  console.log(`  ${c.yellow('!')} ${message}`);
}

/**
 * Print an error message.
 */
export function printErr(message: string): void {
  console.log(`  ${c.red('✗')} ${message}`);
}

/**
 * Print an info/skip message.
 */
export function printInfo(message: string): void {
  console.log(`  ${c.dim('○')} ${message}`);
}

// ── Spinner ──────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  stop: (message?: string) => void;
  update: (text: string) => void;
}

/**
 * Start a CLI spinner. Returns { stop(msg?), update(text) }.
 */
export function startSpinner(text: string): Spinner {
  let frame = 0;
  let currentText = text;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    process.stdout.write(`\r  ${c.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} ${currentText}`);
    frame++;
  }, 80);

  return {
    stop(message?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(currentText.length + 10) + '\r');
      if (message) printOk(message);
    },
    update(newText: string) {
      currentText = newText;
    },
  };
}

// ── Utility ──────────────────────────────────────────────────────────

/**
 * Detect platform context.
 */
export function detectPlatform(): 'macos' | 'linux' | 'wsl' {
  if (process.platform === 'darwin') return 'macos';

  try {
    if (existsSync('/proc/version')) {
      const text = readFileSync('/proc/version', 'utf-8').toLowerCase();
      if (text.includes('microsoft') || text.includes('wsl')) {
        return 'wsl';
      }
    }
  } catch {
    // Not Linux or can't read /proc
  }

  return 'linux';
}
