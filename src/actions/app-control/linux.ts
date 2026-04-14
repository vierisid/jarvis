import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { $ } from 'bun';

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

  async getWindowTree(pid: number): Promise<UIElement[]> {
    const window = await this.getWindowByPid(pid);
    return [this.toWindowElement(window)];
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
      await $`xdotool type --clearmodifiers ${text}`;
    } catch (error) {
      throw new Error(`Failed to type text: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async pressKeys(keys: string[]): Promise<void> {
    await this.ensureTool('xdotool');

    try {
      const keyString = keys.join('+');
      await $`xdotool key --clearmodifiers ${keyString}`;
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

  private async getWindowByPid(pid: number): Promise<WindowInfo> {
    const windows = await this.listWindows();
    const match = windows.find((window) => window.pid === pid);
    if (!match) {
      throw new Error(`No window found for PID ${pid}`);
    }
    return match;
  }

  private toWindowElement(window: WindowInfo): UIElement {
    return {
      id: '1',
      role: 'window',
      name: window.title,
      value: null,
      bounds: window.bounds,
      children: [],
      properties: {
        pid: window.pid,
        className: window.className,
        focused: window.focused,
      },
    };
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
