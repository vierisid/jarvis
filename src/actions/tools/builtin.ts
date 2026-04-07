/**
 * Built-in Tools — The Hands
 *
 * Concrete tool implementations that the agent can call:
 * run_command, read_file, write_file, list_directory
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { hostname, platform, arch, cpus, version } from 'node:os';
import { TerminalExecutor } from '../terminal/executor.ts';
import { BrowserController, type PageSnapshot } from '../browser/session.ts';
import type { ToolDefinition, ToolResult } from './registry.ts';
import type { LLMTool } from '../../llm/provider.ts';
import type { BinaryDataInline } from '../../sidecar/protocol.ts';
import { routeToSidecar, routeToSidecarRaw } from './sidecar-route.ts';
import { listSidecarsTool } from './sidecar-list.ts';
import { DESKTOP_TOOLS } from './desktop.ts';

const terminal = new TerminalExecutor({ timeout: 30000 });

// Shared browser controller (lazy-connected on first browser tool use)
export const browser = new BrowserController();

import { isNoLocalTools, LOCAL_DISABLED_MSG, getDefaultCwd } from './local-tools-guard.ts';
// Re-export for convenience
export { setNoLocalTools, isNoLocalTools, setDefaultCwd } from './local-tools-guard.ts';


/**
 * Convert a ToolDefinition's parameters to JSON Schema for LLM tool use.
 */
export function toolDefToLLMTool(tool: ToolDefinition): LLMTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(tool.parameters)) {
    properties[name] = {
      type: param.type,
      description: param.description,
    };
    if (param.required) {
      required.push(name);
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties,
      required,
    },
  };
}

// --- Tool Implementations ---

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Execute a shell command and return the output. Use this to run terminal commands, scripts, or system utilities. Optionally specify a "target" sidecar name/ID to run the command on a remote machine instead of locally.',
  category: 'terminal',
  parameters: {
    command: {
      type: 'string',
      description: 'The shell command to execute',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to run on a remote machine (omit for local execution)',
      required: false,
    },
    cwd: {
      type: 'string',
      description: 'Working directory for the command (optional, defaults to home directory)',
      required: false,
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (optional, defaults to 30000)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'run_command', {
        command: params.command,
        cwd: params.cwd,
        timeout: params.timeout,
      }, 'terminal');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const command = params.command as string;
    const explicitCwd = params.cwd as string | undefined;
    const cwd = explicitCwd || getDefaultCwd() || homedir();
    const timeout = (params.timeout as number) || undefined;

    const result = await terminal.execute(command, { cwd, timeout });

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
    if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

    // Truncate very large outputs
    if (output.length > 10000) {
      output = output.slice(0, 10000) + '\n... [truncated, output was ' + output.length + ' chars]';
    }

    return output || '[no output]';
  },
};

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file from disk. Returns the file content as text. Optionally specify a "target" sidecar to read from a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the file to read',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to read from a remote machine (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'read_file', { path: params.path }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || homedir();
    const filePath = resolve(baseCwd, rawPath);

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return `Error: Path is a directory, not a file: ${filePath}`;
    }

    // Limit file size to 100KB
    if (stat.size > 100 * 1024) {
      const content = readFileSync(filePath, 'utf-8').slice(0, 100 * 1024);
      return content + '\n... [truncated, file is ' + stat.size + ' bytes]';
    }

    return readFileSync(filePath, 'utf-8');
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file on disk. Creates the file if it does not exist, overwrites if it does. Optionally specify a "target" sidecar to write on a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the file to write',
      required: true,
    },
    content: {
      type: 'string',
      description: 'The content to write to the file',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to write on a remote machine (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'write_file', { path: params.path, content: params.content }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || homedir();
    const filePath = resolve(baseCwd, rawPath);
    const content = params.content as string;

    writeFileSync(filePath, content, 'utf-8');
    return `File written successfully: ${filePath} (${content.length} bytes)`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: 'List the contents of a directory. Returns file and folder names with their types and sizes. Optionally specify a "target" sidecar to list on a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the directory to list',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to list on a remote machine (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'list_directory', { path: params.path }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || homedir();
    const dirPath = resolve(baseCwd, rawPath);

    if (!existsSync(dirPath)) {
      return `Error: Directory not found: ${dirPath}`;
    }

    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return `Error: Path is a file, not a directory: ${dirPath}`;
    }

    const entries = readdirSync(dirPath);
    const lines: string[] = [];

    for (const entry of entries) {
      try {
        const entryPath = `${dirPath}/${entry}`;
        const entryStat = statSync(entryPath);
        const type = entryStat.isDirectory() ? 'dir' : 'file';
        const size = entryStat.isDirectory() ? '' : ` (${entryStat.size} bytes)`;
        lines.push(`${type}  ${entry}${size}`);
      } catch {
        lines.push(`???  ${entry}`);
      }
    }

    if (lines.length === 0) {
      return `[empty directory: ${dirPath}]`;
    }

    return lines.join('\n');
  },
};

// --- Clipboard / Screenshot / System Info helpers ---

function localClipboardRead(): string {
  const os = platform();
  if (os === 'darwin') {
    return execSync('pbpaste', { encoding: 'utf-8' });
  } else if (os === 'win32') {
    return execSync('powershell -command Get-Clipboard', { encoding: 'utf-8' }).trimEnd();
  } else {
    try {
      return execSync('xclip -selection clipboard -o', { encoding: 'utf-8' });
    } catch {
      return execSync('xsel --clipboard --output', { encoding: 'utf-8' });
    }
  }
}

function localClipboardWrite(content: string): void {
  const os = platform();
  if (os === 'darwin') {
    execSync('pbcopy', { input: content, encoding: 'utf-8' });
  } else if (os === 'win32') {
    execSync('powershell -command Set-Clipboard', { input: content, encoding: 'utf-8' });
  } else {
    try {
      execSync('xclip -selection clipboard', { input: content, encoding: 'utf-8' });
    } catch {
      execSync('xsel --clipboard --input', { input: content, encoding: 'utf-8' });
    }
  }
}

function localCaptureScreen(): string {
  const os = platform();
  const tmp = `/tmp/jarvis-screenshot-${Date.now()}.png`;
  if (os === 'darwin') {
    execSync(`screencapture -x ${tmp}`);
  } else if (os === 'win32') {
    execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmp}') }"`);
  } else {
    try {
      execSync(`scrot ${tmp}`);
    } catch {
      execSync(`import -window root ${tmp}`);
    }
  }
  const data = readFileSync(tmp);
  unlinkSync(tmp);
  return data.toString('base64');
}

function localSystemInfo(): Record<string, unknown> {
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    cpus: cpus().length,
    node_version: version(),
  };
}

// --- Clipboard / Screenshot / System Info tools ---

export const getClipboardTool: ToolDefinition = {
  name: 'get_clipboard',
  description: 'Read the clipboard contents. Optionally specify a "target" sidecar name/ID to read from a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) return routeToSidecar(target, 'get_clipboard', {}, 'clipboard');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const content = localClipboardRead();
      return content || '[clipboard is empty]';
    } catch (err) {
      return `Error reading clipboard: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const setClipboardTool: ToolDefinition = {
  name: 'set_clipboard',
  description: 'Write text to the clipboard. Optionally specify a "target" sidecar name/ID to write to a remote machine instead of locally.',
  category: 'general',
  parameters: {
    content: {
      type: 'string',
      description: 'The text to write to the clipboard',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) return routeToSidecar(target, 'set_clipboard', { content: params.content }, 'clipboard');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      localClipboardWrite(params.content as string);
      return 'Clipboard updated.';
    } catch (err) {
      return `Error writing clipboard: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const captureScreenTool: ToolDefinition = {
  name: 'capture_screen',
  description: 'Take a screenshot of the screen. Optionally specify a "target" sidecar name/ID to capture a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) return routeToSidecar(target, 'capture_screen', {}, 'screenshot');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const base64 = localCaptureScreen();
      return JSON.stringify({ type: 'inline', mime_type: 'image/png', data: base64 });
    } catch (err) {
      return `Error capturing screen: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const getSystemInfoTool: ToolDefinition = {
  name: 'get_system_info',
  description: 'Get system information (hostname, OS, architecture, CPU count). Optionally specify a "target" sidecar name/ID to query a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) return routeToSidecar(target, 'get_system_info', {}, 'system_info');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    return JSON.stringify(localSystemInfo(), null, 2);
  },
};

// --- Browser Tool Helpers ---

const MAX_PAGE_TEXT = 2000;   // chars of visible page text
const MAX_ELEMENTS = 50;      // interactive elements shown to LLM

function formatSnapshot(snap: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`Page: ${snap.title}`);
  lines.push(`URL: ${snap.url}`);
  lines.push('');
  lines.push('--- Page Text ---');
  lines.push(snap.text.slice(0, MAX_PAGE_TEXT));
  if (snap.text.length > MAX_PAGE_TEXT) {
    lines.push(`... (${snap.text.length - MAX_PAGE_TEXT} chars truncated)`);
  }
  lines.push('');

  if (snap.elements.length > 0) {
    const shown = snap.elements.slice(0, MAX_ELEMENTS);
    lines.push(`--- Interactive Elements (${shown.length}/${snap.elements.length}) ---`);
    for (const el of shown) {
      const attrParts: string[] = [];
      if (el.attrs.name) attrParts.push(`name="${el.attrs.name}"`);
      if (el.attrs.placeholder) attrParts.push(`placeholder="${el.attrs.placeholder}"`);
      if (el.attrs.type) attrParts.push(`type="${el.attrs.type}"`);
      if (el.attrs.href) attrParts.push(`href="${el.attrs.href.slice(0, 80)}"`);
      if (el.attrs['aria-label']) attrParts.push(`aria-label="${el.attrs['aria-label']}"`);
      if (el.attrs.role) attrParts.push(`role="${el.attrs.role}"`);

      const textStr = el.text ? ` "${el.text.slice(0, 50)}"` : '';
      const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';
      lines.push(`[${el.id}] ${el.tag}${textStr}${attrStr}`);
    }
    if (snap.elements.length > MAX_ELEMENTS) {
      lines.push(`... (${snap.elements.length - MAX_ELEMENTS} more elements not shown)`);
    }
  } else {
    lines.push('(no interactive elements found)');
  }

  return lines.join('\n');
}

function toPageSnapshot(raw: unknown): PageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const source = data.snapshot && typeof data.snapshot === 'object'
    ? data.snapshot as Record<string, unknown>
    : data;

  const title = typeof source.title === 'string' ? source.title : '';
  const url = typeof source.url === 'string' ? source.url : '';
  const text = typeof source.text === 'string' ? source.text : '';
  const rawElements = Array.isArray(source.elements) ? source.elements : [];
  const elements = rawElements.flatMap((element): PageSnapshot['elements'] => {
    if (!element || typeof element !== 'object') return [];
    const el = element as Record<string, unknown>;
    const id = typeof el.id === 'number' ? el.id : Number(el.id);
    if (!Number.isFinite(id)) return [];

    const attrs: Record<string, string> = {};
    for (const key of ['type', 'href', 'name', 'role', 'placeholder', 'aria-label', 'title', 'id']) {
      if (typeof el[key] === 'string' && el[key]) {
        attrs[key] = el[key] as string;
      }
    }

    return [{
      id,
      tag: typeof el.tag === 'string' ? el.tag : 'unknown',
      text: typeof el.text === 'string' ? el.text : '',
      attrs,
    }];
  });

  if (!url && !text && elements.length === 0) return null;
  return { title, url, text, elements };
}

// --- Browser Tool Implementations ---

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate the browser to a URL. Returns page text content and a list of interactive elements with [id] numbers you can reference in browser_click and browser_type. Optionally specify a "target" sidecar to use a remote browser.',
  category: 'browser',
  parameters: {
    url: {
      type: 'string',
      description: 'The URL to navigate to',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      const remote = await routeToSidecarRaw(target, 'browser_navigate', { url: params.url }, 'browser');
      if (typeof remote === 'string') return remote;
      const snap = toPageSnapshot(remote);
      return snap ? formatSnapshot(snap) : JSON.stringify(remote, null, 2);
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.navigate(params.url as string);
      return formatSnapshot(snap);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description: 'Get the current page content and interactive elements. Each element has an [id] you can use with browser_click and browser_type. Use this after clicking or typing to see what changed.',
  category: 'browser',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      const remote = await routeToSidecarRaw(target, 'browser_snapshot', {}, 'browser');
      if (typeof remote === 'string') return remote;
      const snap = toPageSnapshot(remote);
      return snap ? formatSnapshot(snap) : JSON.stringify(remote, null, 2);
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.snapshot();
      return formatSnapshot(snap);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  description: 'Click an interactive element on the page by its [id] from the last browser_navigate or browser_snapshot.',
  category: 'browser',
  parameters: {
    element_id: {
      type: 'number',
      description: 'The [id] of the element to click (from browser_snapshot)',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'browser_click', { element_id: params.element_id }, 'browser');
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.click(params.element_id as number);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserTypeTool: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into an input element by its [id]. Set submit to true to press Enter after typing (useful for search forms).',
  category: 'browser',
  parameters: {
    element_id: {
      type: 'number',
      description: 'The [id] of the input element to type into (from browser_snapshot)',
      required: true,
    },
    text: {
      type: 'string',
      description: 'The text to type',
      required: true,
    },
    submit: {
      type: 'boolean',
      description: 'Press Enter after typing (default: false)',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'browser_type', {
        element_id: params.element_id,
        text: params.text,
        submit: params.submit,
      }, 'browser');
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.type(
        params.element_id as number,
        params.text as string,
        (params.submit as boolean) ?? false,
      );
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current browser page. The image is sent directly to the AI for visual analysis.',
  category: 'browser',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      const remote = await routeToSidecarRaw(target, 'browser_screenshot', {}, 'browser');
      if (typeof remote === 'string') return remote;
      const binary = (remote as { _binary?: BinaryDataInline })._binary;
      if (binary?.type === 'inline' && binary.mime_type && binary.data) {
        return {
          content: [
            { type: 'text' as const, text: 'Browser screenshot captured.' },
            { type: 'image' as const, source: { type: 'base64' as const, media_type: binary.mime_type, data: binary.data } },
          ],
        } satisfies ToolResult;
      }
      return JSON.stringify(remote, null, 2);
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const { base64, mimeType } = await browser.screenshotBuffer();
      return {
        content: [
          { type: 'text' as const, text: 'Browser screenshot captured.' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
        ],
      } satisfies ToolResult;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserScrollTool: ToolDefinition = {
  name: 'browser_scroll',
  description: 'Scroll the page up or down. Use this when you need to see content below the fold. After scrolling, use browser_snapshot to see the new content.',
  category: 'browser',
  parameters: {
    direction: {
      type: 'string',
      description: 'Scroll direction: "down" or "up" (default: "down")',
      required: false,
    },
    amount: {
      type: 'number',
      description: 'Pixels to scroll (default: one viewport height). Use larger values like 2000 to jump further.',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'browser_scroll', {
        direction: params.direction,
        amount: params.amount,
      }, 'browser');
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const direction = (params.direction as string) === 'up' ? 'up' : 'down';
      const amount = params.amount as number | undefined;
      return await browser.scroll(direction, amount);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserEvaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  description: 'Execute JavaScript in the browser page context. Use this for advanced interactions when the standard tools are not enough.',
  category: 'browser',
  parameters: {
    expression: {
      type: 'string',
      description: 'JavaScript expression to evaluate in the page. For complex operations, wrap in an IIFE: (() => { ... })()',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'browser_evaluate', { expression: params.expression }, 'browser');
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const result = await browser.evaluate(params.expression as string);
      if (result === undefined || result === null) return '(no return value)';
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * Non-browser tools (terminal, file operations).
 * Safe to share across multiple agent services — they are stateless.
 */
export const NON_BROWSER_TOOLS: ToolDefinition[] = [
  runCommandTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  getClipboardTool,
  setClipboardTool,
  captureScreenTool,
  getSystemInfoTool,
  listSidecarsTool,
];

/**
 * All built-in tools.
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  ...NON_BROWSER_TOOLS,
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserScrollTool,
  browserEvaluateTool,
  browserScreenshotTool,
  ...DESKTOP_TOOLS,
];

/**
 * Create browser tools bound to a specific BrowserController.
 * Used to give the background agent its own browser instance
 * while keeping tool definitions identical to the main agent's.
 */
export function createBrowserTools(ctrl: BrowserController): ToolDefinition[] {
  return [
    {
      name: 'browser_navigate',
      description: browserNavigateTool.description,
      category: 'browser',
      parameters: browserNavigateTool.parameters,
      execute: async (params) => {
        try {
          const snap = await ctrl.navigate(params.url as string);
          return formatSnapshot(snap);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_snapshot',
      description: browserSnapshotTool.description,
      category: 'browser',
      parameters: browserSnapshotTool.parameters,
      execute: async () => {
        try {
          const snap = await ctrl.snapshot();
          return formatSnapshot(snap);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_click',
      description: browserClickTool.description,
      category: 'browser',
      parameters: browserClickTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.click(params.element_id as number);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_type',
      description: browserTypeTool.description,
      category: 'browser',
      parameters: browserTypeTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.type(
            params.element_id as number,
            params.text as string,
            (params.submit as boolean) ?? false,
          );
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_scroll',
      description: browserScrollTool.description,
      category: 'browser',
      parameters: browserScrollTool.parameters,
      execute: async (params) => {
        try {
          const direction = (params.direction as string) === 'up' ? 'up' : 'down';
          const amount = params.amount as number | undefined;
          return await ctrl.scroll(direction, amount);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_evaluate',
      description: browserEvaluateTool.description,
      category: 'browser',
      parameters: browserEvaluateTool.parameters,
      execute: async (params) => {
        try {
          const result = await ctrl.evaluate(params.expression as string);
          if (result === undefined || result === null) return '(no return value)';
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_screenshot',
      description: browserScreenshotTool.description,
      category: 'browser',
      parameters: browserScreenshotTool.parameters,
      execute: async () => {
        try {
          const { base64, mimeType } = await ctrl.screenshotBuffer();
          return {
            content: [
              { type: 'text' as const, text: 'Browser screenshot captured.' },
              { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
            ],
          } satisfies ToolResult;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}
