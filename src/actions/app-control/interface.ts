export type WindowInfo = {
  pid: number;
  title: string;
  className: string;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
};

export type UIElement = {
  id: string;
  role: string;
  name: string;
  value: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  children: UIElement[];
  properties: Record<string, unknown>;
};

export interface AppController {
  getActiveWindow(): Promise<WindowInfo>;
  getWindowTree(pid: number): Promise<UIElement[]>;
  listWindows(): Promise<WindowInfo[]>;

  clickElement(element: UIElement): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;

  captureScreen(): Promise<Buffer>;
  captureWindow(pid: number): Promise<Buffer>;

  focusWindow(pid: number): Promise<void>;

  /**
   * getWindowTree plus which window it read, for a controller that can say
   * (#704 review): an element id is re-checked against a fresh walk of the
   * same pid, and a desktop bridge picks the pid's largest window, which can
   * be a different one by then. Controllers that cannot say omit it.
   */
  getWindowTreeContext?(pid: number): Promise<{ elements: UIElement[]; context?: string }>;

  // Optional extended operations
  launchApp?(executable: string, args?: string): Promise<object>;
  closeWindow?(pid: number): Promise<void>;
  dragElement?(from: UIElement, to: UIElement): Promise<void>;
}

// Cached per process: the Windows/macOS controllers keep sidecar probe
// backoff state and a live sidecar TCP connection on the instance, so a
// fresh controller per tool call would re-probe every time and leak sockets.
let cachedController: AppController | null = null;

export function getAppController(): AppController {
  if (cachedController) return cachedController;
  cachedController = createAppController();
  return cachedController;
}

function createAppController(): AppController {
  const platform = process.platform;

  switch (platform) {
    case 'linux': {
      // In WSL2, use DesktopController to control Windows desktop via sidecar
      const { WSLBridge } = require('../terminal/wsl-bridge.ts');
      if (WSLBridge.isWSL()) {
        const { DesktopController } = require('./desktop-controller.ts');
        return new DesktopController();
      }
      const { LinuxAppController } = require('./linux.ts');
      return new LinuxAppController();
    }
    case 'win32': {
      const { WindowsAppController } = require('./windows.ts');
      return new WindowsAppController();
    }
    case 'darwin': {
      const { MacAppController } = require('./macos.ts');
      return new MacAppController();
    }
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
