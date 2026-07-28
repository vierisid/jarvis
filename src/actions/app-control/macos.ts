import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * macOS App Controller.
 *
 * Two-layer implementation:
 *   1. Desktop sidecar (desktop-bridge) via TCP JSON-RPC — full macOS
 *      Accessibility API (AXUIElement) support when the sidecar is running.
 *   2. AppleScript / CLI fallback — basic window listing, focus, screenshots,
 *      and input simulation via `osascript` and `screencapture`.
 *
 * The sidecar path is preferred for rich operations (UI tree, click by
 * element ID). The AppleScript path covers the basics without a running
 * sidecar.
 */
export class MacAppController implements AppController {
  private sidecar: import('./desktop-controller.ts').DesktopController | null = null;
  private sidecarConnected = false;

  private async getSidecar(): Promise<import('./desktop-controller.ts').DesktopController | null> {
    if (this.sidecarConnected && this.sidecar) return this.sidecar;
    try {
      const { DesktopController } = await import('./desktop-controller.ts');
      this.sidecar = new DesktopController();
      await this.sidecar.connect();
      this.sidecarConnected = true;
      return this.sidecar;
    } catch {
      return null;
    }
  }

  /**
   * Run an AppleScript and return its stdout.
   */
  private osa(script: string): string {
    try {
      const result = spawnSync('osascript', ['-e', script], {
        encoding: 'utf-8',
        timeout: 15_000,
      });
      return result.stdout?.trim() ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Run a shell command and return its stdout.
   */
  private sh(cmd: string): string {
    try {
      const result = spawnSync('sh', ['-c', cmd], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
      return result.stdout?.toString().trim() ?? '';
    } catch {
      return '';
    }
  }

  async getActiveWindow(): Promise<WindowInfo> {
    const sc = await this.getSidecar();
    if (sc) return sc.getActiveWindow();

    // AppleScript fallback: get frontmost app + active window
    const script = `
      tell application "System Events"
        set frontApp to first process whose frontmost is true
        set appName to name of frontApp
        set winList to every window of frontApp
        if (count of winList) > 0 then
          set win to item 1 of winList
          set winTitle to title of win
          set winPos to position of win
          set winSize to size of win
          set pid to unix id of frontApp
          return (pid as text) & "|||" & winTitle & "|||" & appName & "|||" & (item 1 of winPos as text) & "|||" & (item 2 of winPos as text) & "|||" & (item 1 of winSize as text) & "|||" & (item 2 of winSize as text)
        end if
      end tell
      return "0|||Unknown|||Unknown|||0|||0|||0|||0"
    `;
    const out = this.osa(script);
    if (!out) throw new Error('Could not get active window');

    const parts = out.split('|||');
    if (parts.length < 7) throw new Error('Could not parse window info');

    return {
      pid: parseInt(parts[0], 10) || 0,
      title: parts[1] || 'Unknown',
      className: parts[2] || 'Unknown',
      bounds: {
        x: parseInt(parts[3], 10) || 0,
        y: parseInt(parts[4], 10) || 0,
        width: parseInt(parts[5], 10) || 0,
        height: parseInt(parts[6], 10) || 0,
      },
      focused: true,
    };
  }

  async getWindowTree(_pid: number): Promise<UIElement[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.getWindowTree(_pid);

    throw new Error(
      'UI element traversal on macOS requires the desktop-bridge sidecar. ' +
      'Build the sidecar and ensure it is running.'
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.listWindows();

    // AppleScript fallback: enumerate visible windows
    const script = `
      set output to ""
      tell application "System Events"
        set frontPID to unix id of first process whose frontmost is true
        set allProcesses to every process
        repeat with proc in allProcesses
          try
            set procName to name of proc
            set procPID to unix id of proc
            set winList to every window of proc
            repeat with win in winList
              try
                set winTitle to title of win
                if winTitle is not "" then
                  set winPos to position of win
                  set winSize to size of win
                  set isFront to (procPID = frontPID) as text
                  set line to procPID & "|||" & winTitle & "|||" & procName & "|||" & (item 1 of winPos as text) & "|||" & (item 2 of winPos as text) & "|||" & (item 1 of winSize as text) & "|||" & (item 2 of winSize as text) & "|||" & isFront
                  set output to output & line & linefeed
                end if
              end try
            end repeat
          end try
        end repeat
      end tell
      return output
    `;
    const out = this.osa(script);
    if (!out) throw new Error('Could not list windows');

    const windows: WindowInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|||');
      if (parts.length < 8) continue;
      windows.push({
        pid: parseInt(parts[0], 10) || 0,
        title: parts[1] || 'Unknown',
        className: parts[2] || 'Unknown',
        bounds: {
          x: parseInt(parts[3], 10) || 0,
          y: parseInt(parts[4], 10) || 0,
          width: parseInt(parts[5], 10) || 0,
          height: parseInt(parts[6], 10) || 0,
        },
        focused: parts[7] === 'true',
      });
    }
    return windows;
  }

  async clickElement(element: UIElement): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.clickElement(element);

    // AppleScript: move mouse and click at element center
    const cx = Math.round(element.bounds.x + element.bounds.width / 2);
    const cy = Math.round(element.bounds.y + element.bounds.height / 2);
    this.osa(`
      tell application "System Events"
        set mousePosition to {${cx}, ${cy}}
        do shell script "mouseclick " & (${cx} as text) & " " & (${cy} as text)
      end tell
    `);
    // If cliclick is available, use it for reliable clicks
    this.sh(`cliclick c:${cx},${cy} 2>/dev/null || ` +
      `osascript -e 'tell application "System Events" to click at {${cx}, ${cy}}'`);
  }

  async typeText(text: string): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.typeText(text);

    // AppleScript keystroke (text must be safe)
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    this.osa(`
      tell application "System Events"
        keystroke "${escaped}"
      end tell
    `);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.pressKeys(keys);

    // Map common key names to AppleScript key codes / keystrokes
    const keyMap: Record<string, string> = {
      'Enter': 'return',
      'Return': 'return',
      'Tab': 'tab',
      'Escape': 'escape',
      'Backspace': 'delete',
      'Delete': 'delete',
      'Home': 'home',
      'End': 'end',
      'PageUp': 'page up',
      'PageDown': 'page down',
      'Up': 'up',
      'Down': 'down',
      'Left': 'left',
      'Right': 'right',
      'Space': 'space',
      'Control': 'control down',
      'Command': 'command down',
      'Cmd': 'command down',
      'Option': 'option down',
      'Alt': 'option down',
      'Shift': 'shift down',
    };

    // Build a keystroke expression for each key
    const parts: string[] = [];
    let modifiers = '';

    for (const key of keys) {
      const mapped = keyMap[key];
      if (!mapped) {
        parts.push(`keystroke "${key}"`);
        continue;
      }
      if (mapped.endsWith(' down')) {
        modifiers = mapped;
      } else {
        parts.push(`keystroke "${mapped}"`);
      }
    }

    if (parts.length === 0) return;
    this.osa(`
      tell application "System Events"
        ${modifiers}
        ${parts.join('\n')}
        ${modifiers ? 'key up ' + modifiers.replace(' down', '') : ''}
      end tell
    `);
  }

  async captureScreen(): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureScreen();

    // screencapture CLI fallback
    const tmpFile = `/tmp/jarvis-screen-${Date.now()}.png`;
    try {
      this.sh(`screencapture -x -t png "${tmpFile}" 2>/dev/null`);
      const buffer = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch {}
      return Buffer.from(buffer);
    } catch {
      throw new Error('Could not capture screen. Ensure screencapture is available.');
    }
  }

  async captureWindow(pid: number): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureWindow(pid);

    // Get window position via AppleScript, then screencapture the region
    const winInfo = (await this.listWindows()).find(w => w.pid === pid);
    if (!winInfo) throw new Error(`No window found for PID ${pid}`);

    const { x, y, width, height } = winInfo.bounds;
    const tmpFile = `/tmp/jarvis-window-${pid}-${Date.now()}.png`;
    try {
      this.sh(`screencapture -x -R ${x},${y},${width},${height} -t png "${tmpFile}" 2>/dev/null`);
      const buffer = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch {}
      return Buffer.from(buffer);
    } catch {
      throw new Error(`Could not capture window for PID ${pid}`);
    }
  }

  async focusWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.focusWindow(pid);

    // AppleScript: activate the app
    this.osa(`
      tell application "System Events"
        set targetProc to first process whose unix id is ${pid}
        set frontmost of targetProc to true
      end tell
    `);
    // Alternative: use "activate" on the application
    this.sh(`osascript -e 'tell application id (id of application "''") to activate' 2>/dev/null`);
  }

  /**
   * Launch an application.
   */
  async launchApp(executable: string, args?: string): Promise<object> {
    const sc = await this.getSidecar();
    if (sc && typeof sc.launchApp === 'function') {
      return sc.launchApp(executable, args);
    }
    // AppleScript: open the app
    this.sh(`open -a "${executable}" ${args ? args : ''} 2>/dev/null || ` +
      `open "${executable}" ${args ? args : ''} 2>/dev/null`);
    return { executable, args: args ?? '' };
  }

  /**
   * Close a window by PID.
   */
  async closeWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc && typeof sc.closeWindow === 'function') {
      return sc.closeWindow(pid);
    }
    // AppleScript: close all windows of the process
    this.osa(`
      tell application "System Events"
        set targetProc to first process whose unix id is ${pid}
        tell targetProc
          close (every window)
        end tell
      end tell
    `);
  }
}
