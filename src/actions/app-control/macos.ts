import { join } from 'node:path';
import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { captureViaPrivateFileAsync } from './capture-file.ts';
import { defaultExec, runNative, type NativeExec } from './native-exec.ts';

/**
 * macOS App Controller.
 *
 * AppleScript / screencapture: window listing, focus, screenshots, and input
 * simulation through a fixed helper script (scripts/desktop.applescript).
 * There is no local element tree; the Go sidecar provides one (Accessibility)
 * when it is connected, and desktop.ts routes there. The probe for a legacy
 * desktop-bridge.exe that used to sit in front of this went in #799: it looked
 * for a Windows executable that cannot run on macOS, so all it ever did was
 * offer an unauthenticated localhost port a chance to answer.
 *
 * This never assembles AppleScript source from user input: the helper
 * script ships as an asset with an `on run argv` dispatcher, and all dynamic
 * values travel as osascript arguments, so arbitrary text cannot escape into
 * script code. The fallback paths require the Accessibility and Screen
 * Recording permissions for the process running the daemon.
 */

const SCRIPT_PATH = join(import.meta.dir, 'scripts', 'desktop.applescript');

const MAC_MODIFIERS: Record<string, string> = {
  command: 'command',
  cmd: 'command',
  meta: 'command',
  super: 'command',
  win: 'command',
  option: 'option',
  alt: 'option',
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
};

/** macOS virtual key codes for keys `keystroke` cannot express. */
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export type MacKeyChord = {
  /** Subset of command/option/control/shift, deduplicated, in input order. */
  modifiers: string[];
  /** "code" = numeric virtual key code, "char" = literal keystroke character. */
  kind: 'code' | 'char';
  value: string;
};

/**
 * Map a key chord like ["Command", "Shift", "S"] to the arguments the
 * AppleScript helper's press-keys command expects.
 */
export function mapMacKeys(keys: string[]): MacKeyChord {
  const modifiers: string[] = [];
  let key: string | null = null;

  for (const raw of keys) {
    const lower = raw.toLowerCase();
    const modifier = MAC_MODIFIERS[lower];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== null) {
      throw new Error(`Key combination [${keys.join('+')}] has more than one non-modifier key`);
    }
    key = raw;
  }

  if (key === null) {
    throw new Error(`Key combination [${keys.join('+')}] has no non-modifier key to press`);
  }
  const code = MAC_KEY_CODES[key.toLowerCase()];
  if (code !== undefined) return { modifiers, kind: 'code', value: String(code) };
  if ([...key].length === 1) return { modifiers, kind: 'char', value: key.toLowerCase() };
  throw new Error(`Unsupported key "${key}" for the AppleScript fallback`);
}

// Tab-separated fields emitted by the helper script (title last).
function parseWindowLine(line: string): WindowInfo | null {
  const parts = line.split('\t');
  if (parts.length < 8) return null;
  return {
    pid: parseInt(parts[0]!, 10) || 0,
    title: parts.slice(7).join('\t') || 'Unknown',
    className: parts[6] || 'Unknown',
    bounds: {
      x: parseInt(parts[2]!, 10) || 0,
      y: parseInt(parts[3]!, 10) || 0,
      width: parseInt(parts[4]!, 10) || 0,
      height: parseInt(parts[5]!, 10) || 0,
    },
    focused: parts[1] === '1',
  };
}

/** What a macOS caller is told to use for what only the Go sidecar can do. */
const MAC_SIDECAR_HINT =
  'Run the JARVIS sidecar on this Mac and enroll it; desktop tools route to it automatically.';

export class MacAppController implements AppController {
  private exec: NativeExec;

  constructor(opts: { exec?: NativeExec } = {}) {
    this.exec = opts.exec ?? defaultExec;
  }

  /**
   * Run a command of the fixed helper script. Dynamic values travel as
   * osascript arguments — never interpolated into script text.
   */
  private async runScript(command: string, args: string[] = []): Promise<string> {
    const stdout = await runNative(
      this.exec,
      ['osascript', SCRIPT_PATH, command, ...args],
      '',
      `desktop.applescript ${command}`,
    );
    return stdout.replace(/\n$/, '');
  }

  async getActiveWindow(): Promise<WindowInfo> {
    const line = await this.runScript('get-active-window');
    const info = parseWindowLine(line);
    if (!info) throw new Error(`Could not parse active window info: ${line.slice(0, 200)}`);
    return info;
  }

  async getWindowTree(_pid: number): Promise<UIElement[]> {
    throw new Error(`UI element traversal is not available locally on macOS. ${MAC_SIDECAR_HINT}`);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const out = await this.runScript('list-windows');
    const windows: WindowInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const info = parseWindowLine(line);
      if (info) windows.push(info);
    }
    return windows;
  }

  async clickElement(element: UIElement): Promise<void> {
    const x = Math.round(element.bounds.x + element.bounds.width / 2);
    const y = Math.round(element.bounds.y + element.bounds.height / 2);
    await this.runScript('click-at', [String(x), String(y)]);
  }

  async typeText(text: string): Promise<void> {
    await this.runScript('type-text', [text]);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const chord = mapMacKeys(keys);
    await this.runScript('press-keys', [chord.modifiers.join(',') || '-', chord.kind, chord.value]);
  }

  async captureScreen(): Promise<Buffer> {
    return this.captureToBuffer(['-x', '-t', 'png']);
  }

  async captureWindow(pid: number): Promise<Buffer> {
    const windows = await this.listWindows();
    const win = windows.find((w) => w.pid === pid);
    if (!win) throw new Error(`No window found for PID ${pid}`);
    const { x, y, width, height } = win.bounds;
    return this.captureToBuffer(['-x', '-R', `${x},${y},${width},${height}`, '-t', 'png']);
  }

  /** Through a private, unpredictable file (#746): see capture-file.ts. */
  private captureToBuffer(captureArgs: string[]): Promise<Buffer> {
    return captureViaPrivateFileAsync(async (file) => {
      await runNative(this.exec, ['screencapture', ...captureArgs, file], '', 'screencapture');
    });
  }

  async focusWindow(pid: number): Promise<void> {
    await this.runScript('focus-window', [String(pid)]);
  }

  async launchApp(executable: string, args?: string): Promise<object> {
    if (!executable.trim()) throw new Error('Executable is required');

    // `open -a` resolves app names and .app bundles; fall back to opening the
    // argument as a path. Arguments are passed as an argv array — no shell —
    // and survive the fallback attempt.
    const extraArgs = parseCommandArgs(args);
    const argsTail = extraArgs.length > 0 ? ['--args', ...extraArgs] : [];
    try {
      await runNative(this.exec, ['open', '-a', executable, ...argsTail], '', `open -a ${executable}`);
    } catch (appError) {
      try {
        await runNative(this.exec, ['open', executable, ...argsTail], '', `open ${executable}`);
      } catch {
        throw appError;
      }
    }
    return { executable, args: args ?? '' };
  }

  async closeWindow(_pid: number): Promise<void> {
    throw new Error(
      'closeWindow is not available locally on macOS. ' +
      'Use focusWindow + pressKeys(["Command", "W"]) instead.',
    );
  }
}

// Naive splitter (same as linux.ts): whole-token quotes only. Tokens like
// --flag="a b" are not un-quoted mid-token; acceptable for launch arguments.
function parseCommandArgs(args?: string): string[] {
  if (!args?.trim()) return [];
  const parts = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
}
