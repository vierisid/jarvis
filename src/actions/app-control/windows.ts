import { join } from 'node:path';
import type { AppController, WindowInfo, UIElement } from './interface.ts';
import type { DesktopController } from './desktop-controller.ts';
import { defaultExec, runNative, type NativeExec } from './native-exec.ts';

/**
 * Windows App Controller.
 *
 * Two-layer implementation:
 *   1. Desktop sidecar (desktop-bridge.exe) via TCP JSON-RPC — full Win32/UI
 *      Automation support when the sidecar is built and running.
 *   2. PowerShell fallback — window listing, focus, screenshots, and input
 *      simulation through a fixed helper script (scripts/desktop.ps1).
 *
 * The fallback never assembles PowerShell source from user input: the helper
 * script ships as an asset and all dynamic values travel as a JSON payload on
 * stdin, so arbitrary text cannot escape into script code.
 */

const SCRIPT_PATH = join(import.meta.dir, 'scripts', 'desktop.ps1');

// How long to wait before re-probing for a sidecar after a failed attempt.
const SIDECAR_RETRY_MS = 30_000;

/** SendKeys metacharacters, each escaped by wrapping in braces. */
const SENDKEYS_SPECIAL = /([+^%~(){}[\]])/g;

/**
 * Escape literal text for [System.Windows.Forms.SendKeys]::SendWait.
 * Newlines become {ENTER} and tabs {TAB}; everything else is typed verbatim.
 */
export function escapeSendKeysText(text: string): string {
  return text
    .replace(SENDKEYS_SPECIAL, '{$1}')
    .replace(/\r\n|\r|\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

const SENDKEYS_MODIFIERS: Record<string, string> = {
  control: '^',
  ctrl: '^',
  alt: '%',
  option: '%',
  shift: '+',
};

const SENDKEYS_KEYS: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}',
  esc: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  space: ' ',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
};

/**
 * Map a key chord like ["Control", "Shift", "S"] to a SendKeys string ("^+s").
 * Throws on keys SendKeys cannot synthesize (e.g. the Windows key).
 */
export function mapKeysToSendKeys(keys: string[]): string {
  let modifiers = '';
  const rest: string[] = [];

  for (const raw of keys) {
    const lower = raw.toLowerCase();
    const modifier = SENDKEYS_MODIFIERS[lower];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers += modifier;
      continue;
    }
    if (lower === 'win' || lower === 'meta' || lower === 'super' || lower === 'command' || lower === 'cmd') {
      throw new Error(`SendKeys cannot press the ${raw} key; Windows-key shortcuts need the desktop sidecar`);
    }
    const named = SENDKEYS_KEYS[lower];
    if (named) {
      rest.push(named);
      continue;
    }
    if ([...raw].length === 1) {
      rest.push(escapeSendKeysText(raw.toLowerCase()));
      continue;
    }
    throw new Error(`Unsupported key "${raw}" for the SendKeys fallback`);
  }

  if (rest.length === 0) {
    throw new Error(`Key combination [${keys.join('+')}] has no non-modifier key to press`);
  }
  const body = rest.join('');
  if (modifiers && rest.length > 1) return `${modifiers}(${body})`;
  return modifiers + body;
}

type ScriptWindow = {
  pid: number;
  focused: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  className: string;
  title: string;
};

function toWindowInfo(raw: ScriptWindow): WindowInfo {
  return {
    pid: raw.pid,
    title: raw.title || 'Unknown',
    className: raw.className || 'Unknown',
    bounds: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
    focused: raw.focused,
  };
}

export class WindowsAppController implements AppController {
  private exec: NativeExec;
  private useSidecar: boolean;
  private sidecar: DesktopController | null = null;
  private sidecarRetryAt = 0;

  constructor(opts: { exec?: NativeExec; useSidecar?: boolean } = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.useSidecar = opts.useSidecar ?? true;
  }

  private async getSidecar(): Promise<DesktopController | null> {
    if (!this.useSidecar) return null;
    if (this.sidecar?.connected) return this.sidecar;
    if (Date.now() < this.sidecarRetryAt) return null;
    try {
      const { DesktopController } = await import('./desktop-controller.ts');
      const sidecar = this.sidecar ?? new DesktopController();
      await sidecar.connect();
      this.sidecar = sidecar;
      return sidecar;
    } catch {
      this.sidecarRetryAt = Date.now() + SIDECAR_RETRY_MS;
      return null;
    }
  }

  /**
   * Run a command of the fixed helper script. The payload travels on stdin
   * as JSON — never on the command line, never interpolated into script text.
   */
  private runScript(command: string, payload?: Record<string, unknown>): string {
    const stdout = runNative(
      this.exec,
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, command],
      payload === undefined ? '' : JSON.stringify(payload),
      `desktop.ps1 ${command}`,
    );
    return stdout.trim();
  }

  private runScriptJson<T>(command: string, payload?: Record<string, unknown>): T {
    const out = this.runScript(command, payload);
    if (!out) throw new Error(`desktop.ps1 ${command} produced no output`);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(`desktop.ps1 ${command} returned invalid JSON: ${out.slice(0, 200)}`);
    }
  }

  async getActiveWindow(): Promise<WindowInfo> {
    const sc = await this.getSidecar();
    if (sc) return sc.getActiveWindow();
    return toWindowInfo(this.runScriptJson<ScriptWindow>('get-active-window'));
  }

  async getWindowTree(pid: number): Promise<UIElement[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.getWindowTree(pid);
    throw new Error(
      'UI element traversal on Windows requires the desktop-bridge sidecar. ' +
      'Build it with: bun run scripts/build-sidecar.ts',
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.listWindows();
    const result = this.runScriptJson<ScriptWindow[] | ScriptWindow>('list-windows');
    const windows = Array.isArray(result) ? result : [result];
    return windows.map(toWindowInfo);
  }

  async clickElement(element: UIElement): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.clickElement(element);
    const x = Math.round(element.bounds.x + element.bounds.width / 2);
    const y = Math.round(element.bounds.y + element.bounds.height / 2);
    this.runScript('click-at', { x, y });
  }

  async typeText(text: string): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.typeText(text);
    this.runScript('send-keys', { keys: escapeSendKeysText(text) });
  }

  async pressKeys(keys: string[]): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.pressKeys(keys);
    this.runScript('send-keys', { keys: mapKeysToSendKeys(keys) });
  }

  async captureScreen(): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureScreen();
    const base64 = this.runScript('capture-screen');
    if (!base64) throw new Error('capture-screen produced no image data');
    return Buffer.from(base64, 'base64');
  }

  async captureWindow(pid: number): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureWindow(pid);
    const base64 = this.runScript('capture-window', { pid });
    if (!base64) throw new Error(`capture-window produced no image data for PID ${pid}`);
    return Buffer.from(base64, 'base64');
  }

  async focusWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.focusWindow(pid);
    this.runScript('focus-window', { pid });
  }

  async launchApp(executable: string, args?: string): Promise<object> {
    if (!executable.trim()) throw new Error('Executable is required');
    const sc = await this.getSidecar();
    if (sc) return sc.launchApp(executable, args);
    const result = this.runScriptJson<{ pid: number }>('launch-app', { executable, args: args ?? '' });
    return { pid: result.pid, executable, args: args ?? '' };
  }

  async closeWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.closeWindow(pid);
    this.runScript('close-window', { pid });
  }
}
