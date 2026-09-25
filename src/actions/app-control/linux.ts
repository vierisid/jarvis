import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { $ } from 'bun';

/**
 * Key names xdotool can press: X keysym names (Return, minus, F5, XF86AudioPlay,
 * U20AC) and xdotool's aliases (ctrl, alt, super, enter). Anything else is
 * ignored or rejected by xdotool itself, so refusing it loses no working key,
 * and it keeps a leading "-" from ever reaching xdotool.
 *
 * This, the command checks and MAX_CHORD_KEYS are mirrored by the sidecar's
 * checkXdotoolKeySequence (sidecar/desktop_linux.go); keep them in sync.
 */
const KEYSYM_NAME = /^[A-Za-z0-9_]+$/;

/**
 * xdotool's commands (its dispatch table). `xdotool key` stops at the first
 * argument that names one and runs it as a chained command, `--` or not, so a
 * lone key spelled like a command ("exec", "selectwindow") would run that
 * command instead of being pressed. pressKeys also ends the argument with "+"
 * (see there), which no command name contains; refusing these as well keeps a
 * later edit to that argument from reopening the hole.
 */
const XDOTOOL_COMMANDS = new Set([
  'behave', 'behave_screen_edge', 'click', 'exec', 'get_desktop',
  'get_desktop_for_window', 'get_desktop_viewport', 'get_num_desktops',
  'getactivewindow', 'getdisplaygeometry', 'getmouselocation', 'getwindowclassname',
  'getwindowfocus', 'getwindowgeometry', 'getwindowname', 'getwindowpid', 'help',
  'key', 'keydown', 'keyup', 'mousedown', 'mousemove', 'mousemove_relative', 'mouseup',
  'search', 'selectwindow', 'set_desktop', 'set_desktop_for_window',
  'set_desktop_viewport', 'set_num_desktops', 'set_window', 'sleep', 'type', 'version',
  'windowactivate', 'windowclose', 'windowfocus', 'windowkill', 'windowlower',
  'windowmap', 'windowminimize', 'windowmove', 'windowquit', 'windowraise',
  'windowreparent', 'windowsize', 'windowstate', 'windowunmap',
]);

/**
 * libxdo grows its key array with the wrong element size once a sequence
 * reaches 10 keys (xdo.c `realloc(*keys, keys_size * sizeof(KeyCode))`) and
 * then writes past it. No real chord comes close, so stay well below.
 */
const MAX_CHORD_KEYS = 8;

/**
 * Real keysyms that share a name with a command. Help (the "help" command) is
 * the only one. The trailing "+" in pressKeys is what lets it be pressed; were
 * that ever lost, xdotool would merely print its help text.
 */
const KEYSYMS_NAMED_LIKE_COMMANDS = new Set(['Help']);

/** A refused chord never reaches xdotool: the caller should fix the key names, not check what happened. */
function invalidKeys(message: string): ActionOutcomeError {
  return new ActionOutcomeError({ status: 'error', code: 'DESKTOP_INVALID_KEYS', effect: 'not_started',
    message: `Error: ${message}. Nothing was pressed.` });
}

/**
 * Join a chord like ["ctrl", "shift", "t"] into xdotool's "ctrl+shift+t",
 * refusing anything that xdotool would read as other than a key sequence.
 * Each "+"-separated name is checked, so a key given as "ctrl+s" still works;
 * empty names are skipped, as xdotool skips them. The checks run in the same
 * order as the sidecar's: names, then empty, then count, then command names.
 */
export function toXdotoolKeySequence(keys: string[]): string {
  const sequence = keys.join('+');
  const names = sequence.split('+').filter(Boolean);
  for (const name of names) {
    if (!KEYSYM_NAME.test(name)) {
      throw invalidKeys(`Invalid key name ${JSON.stringify(name)}: use X keysym names such as Return, Tab, minus, slash or F5`);
    }
  }
  if (names.length === 0) {
    throw invalidKeys('No keys given');
  }
  if (names.length > MAX_CHORD_KEYS) {
    throw invalidKeys(`Too many keys in one chord (${names.length}); press at most ${MAX_CHORD_KEYS} at once`);
  }
  if (XDOTOOL_COMMANDS.has(sequence.toLowerCase()) && !KEYSYMS_NAMED_LIKE_COMMANDS.has(sequence)) {
    const hint = sequence.toLowerCase() === 'help' ? ' (the Help key is spelled "Help")' : '';
    throw invalidKeys(`"${sequence}" is an xdotool command name and cannot be pressed as a key${hint}`);
  }
  return sequence;
}

export class LinuxAppController implements AppController {
  private async checkTool(tool: string): Promise<boolean> {
    try {
      await $`which ${tool}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureTool(tool: string): Promise<void> {
    if (!(await this.checkTool(tool))) {
      throw new Error(
        `Required tool '${tool}' not found. Please install it:\n` +
        `  Ubuntu/Debian: sudo apt install ${tool}\n` +
        `  Fedora: sudo dnf install ${tool}\n` +
        `  Arch: sudo pacman -S ${tool}`
      );
    }
  }

  async getActiveWindow(): Promise<WindowInfo> {
    await this.ensureTool('xdotool');
    await this.ensureTool('xprop');

    try {
      const windowId = (await $`xdotool getactivewindow`.text()).trim();

      const xpropOutput = await $`xprop -id ${windowId}`.text();

      const title = this.extractXpropValue(xpropOutput, 'WM_NAME') || 'Unknown';
      const className = this.extractXpropValue(xpropOutput, 'WM_CLASS') || 'Unknown';

      const geometryOutput = await $`xdotool getwindowgeometry ${windowId}`.text();
      const bounds = this.parseGeometry(geometryOutput);

      const pid = parseInt(this.extractXpropValue(xpropOutput, '_NET_WM_PID') || '0', 10);

      return {
        pid,
        title,
        className,
        bounds,
        focused: true,
      };
    } catch (error) {
      throw new Error(`Failed to get active window: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getWindowTree(_pid: number): Promise<UIElement[]> {
    throw new Error(
      'UI element traversal is not implemented on Linux yet (requires AT-SPI2). ' +
      'Use desktop_list_windows for window-level info, or pass a "target" sidecar that supports the desktop capability.',
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    await this.ensureTool('xdotool');
    await this.ensureTool('xprop');

    try {
      const hasWmctrl = await this.checkTool('wmctrl');

      let windowIds: string[];

      if (hasWmctrl) {
        const wmctrlOutput = await $`wmctrl -l -p`.text();
        windowIds = wmctrlOutput
          .split('\n')
          .filter(line => line.trim())
          .map(line => line.split(/\s+/)[0] || '');
      } else {
        const xdotoolOutput = await $`xdotool search --name "."`.text();
        windowIds = xdotoolOutput.split('\n').filter(id => id.trim());
      }

      const windows: WindowInfo[] = [];
      const activeWindowId = (await $`xdotool getactivewindow`.text()).trim();

      for (const windowId of windowIds) {
        if (!windowId) continue;

        try {
          const xpropOutput = await $`xprop -id ${windowId}`.text();
          const title = this.extractXpropValue(xpropOutput, 'WM_NAME') || 'Unknown';
          const className = this.extractXpropValue(xpropOutput, 'WM_CLASS') || 'Unknown';
          const pid = parseInt(this.extractXpropValue(xpropOutput, '_NET_WM_PID') || '0', 10);

          const geometryOutput = await $`xdotool getwindowgeometry ${windowId}`.text();
          const bounds = this.parseGeometry(geometryOutput);

          windows.push({
            pid,
            title,
            className,
            bounds,
            focused: windowId === activeWindowId,
          });
        } catch {
          // Skip windows that can't be queried
          continue;
        }
      }

      return windows;
    } catch (error) {
      throw new Error(`Failed to list windows: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async clickElement(element: UIElement): Promise<void> {
    await this.ensureTool('xdotool');

    try {
      const action = typeof element.properties.action === 'string' ? element.properties.action : 'click';
      const pid = typeof element.properties.pid === 'number' ? element.properties.pid : null;

      if (action === 'focus') {
        if (pid === null) {
          throw new Error('Element is missing a PID, cannot focus window');
        }
        await this.focusWindow(pid);
        return;
      }

      const centerX = element.bounds.x + element.bounds.width / 2;
      const centerY = element.bounds.y + element.bounds.height / 2;

      await $`xdotool mousemove ${Math.round(centerX)} ${Math.round(centerY)}`;
      if (action === 'double_click') {
        await $`xdotool click --repeat 2 1`;
        return;
      }
      if (action === 'right_click') {
        await $`xdotool click 3`;
        return;
      }
      await $`xdotool click 1`;
    } catch (error) {
      throw new Error(`Failed to click element: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async typeText(text: string): Promise<void> {
    await this.ensureTool('xdotool');

    try {
      // `--` ends xdotool's option parsing, so text such as "-h" or
      // "--file=/home/me/.ssh/id_ed25519" is typed literally instead of
      // being read as an option (--file would type out the named file).
      await $`xdotool type --clearmodifiers -- ${text}`;
    } catch (error) {
      throw new Error(`Failed to type text: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async pressKeys(keys: string[]): Promise<void> {
    // Outside the try below, so a refusal stays a not-started outcome.
    const keyString = toXdotoolKeySequence(keys);
    await this.ensureTool('xdotool');

    try {
      // The trailing "+" is an empty last key, which libxdo skips. It keeps
      // the argument from equalling any xdotool command name, so `xdotool key`
      // cannot chain into a command, whatever commands a later xdotool adds.
      await $`xdotool key --clearmodifiers -- ${keyString}+`;
    } catch (error) {
      throw new Error(`Failed to press keys: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async captureScreen(): Promise<Buffer> {
    const hasImport = await this.checkTool('import');
    const hasScrot = await this.checkTool('scrot');

    if (!hasImport && !hasScrot) {
      throw new Error(
        `No screenshot tool found. Please install one:\n` +
        `  ImageMagick: sudo apt install imagemagick\n` +
        `  Scrot: sudo apt install scrot`
      );
    }

    try {
      const tmpFile = `/tmp/jarvis-screen-${Date.now()}.png`;

      if (hasImport) {
        await $`import -window root ${tmpFile}`;
      } else {
        await $`scrot ${tmpFile}`;
      }

      const buffer = await Bun.file(tmpFile).arrayBuffer();
      await $`rm ${tmpFile}`;

      return Buffer.from(buffer);
    } catch (error) {
      throw new Error(`Failed to capture screen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async captureWindow(pid: number): Promise<Buffer> {
    await this.ensureTool('xdotool');
    const hasImport = await this.checkTool('import');

    if (!hasImport) {
      throw new Error(
        `ImageMagick not found. Please install:\n` +
        `  sudo apt install imagemagick`
      );
    }

    try {
      const windowId = await this.findWindowByPid(pid);

      const tmpFile = `/tmp/jarvis-window-${pid}-${Date.now()}.png`;
      await $`import -window ${windowId} ${tmpFile}`;

      const buffer = await Bun.file(tmpFile).arrayBuffer();
      await $`rm ${tmpFile}`;

      return Buffer.from(buffer);
    } catch (error) {
      throw new Error(`Failed to capture window: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async focusWindow(pid: number): Promise<void> {
    await this.ensureTool('xdotool');

    try {
      const windowId = await this.findWindowByPid(pid);
      await $`xdotool windowactivate ${windowId}`;
    } catch (error) {
      throw new Error(`Failed to focus window: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async launchApp(executable: string, args?: string): Promise<object> {
    if (!executable.trim()) {
      throw new Error('Executable is required');
    }

    try {
      const proc = Bun.spawn(
        [executable, ...this.parseCommandArgs(args)],
        {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );

      return {
        pid: proc.pid,
        executable,
        args: args ?? '',
      };
    } catch (error) {
      throw new Error(`Failed to launch app: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async findWindowByPid(pid: number): Promise<string> {
    const windowIds = (await $`xdotool search --name "."`.text())
      .split('\n')
      .filter(id => id.trim());

    for (const windowId of windowIds) {
      try {
        const xpropOutput = await $`xprop -id ${windowId}`.text();
        const windowPid = parseInt(this.extractXpropValue(xpropOutput, '_NET_WM_PID') || '0', 10);

        if (windowPid === pid) {
          return windowId;
        }
      } catch {
        continue;
      }
    }

    throw new Error(`No window found for PID ${pid}`);
  }

  private parseCommandArgs(args?: string): string[] {
    if (!args?.trim()) {
      return [];
    }

    const parts = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
  }

  private extractXpropValue(output: string, property: string): string | null {
    const regex = new RegExp(`^${property}\\(.*?\\)\\s*=\\s*(.+)$`, 'm');
    const match = output.match(regex);

    if (!match || !match[1]) {
      return null;
    }

    let value = match[1].trim();

    value = value.replace(/^"(.*)"$/, '$1');
    value = value.replace(/^{([^}]*)}.*$/, '$1');
    value = value.replace(/^"([^"]*)".*$/, '$1');

    return value;
  }

  private parseGeometry(geometryOutput: string): { x: number; y: number; width: number; height: number } {
    const positionMatch = geometryOutput.match(/Position:\s*(\d+),(\d+)/);
    const geometryMatch = geometryOutput.match(/Geometry:\s*(\d+)x(\d+)/);

    const x = positionMatch?.[1] ? parseInt(positionMatch[1], 10) : 0;
    const y = positionMatch?.[2] ? parseInt(positionMatch[2], 10) : 0;
    const width = geometryMatch?.[1] ? parseInt(geometryMatch[1], 10) : 0;
    const height = geometryMatch?.[2] ? parseInt(geometryMatch[2], 10) : 0;

    return { x, y, width, height };
  }
}
