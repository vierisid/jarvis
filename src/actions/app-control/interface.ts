import { ActionOutcomeError } from '../action-outcome.ts';

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
   * same pid, and a walk that can land on a different window of that pid (as
   * the legacy desktop bridge's "largest window" walk could, before #799
   * removed it) has to say which one it read. Controllers that cannot say
   * omit it.
   */
  getWindowTreeContext?(pid: number): Promise<{ elements: UIElement[]; context?: string }>;

  // Optional extended operations
  launchApp?(executable: string, args?: string): Promise<object>;
  closeWindow?(pid: number): Promise<void>;
  dragElement?(from: UIElement, to: UIElement): Promise<void>;
}

/**
 * Why there is no local controller under WSL (#799). The legacy
 * desktop-bridge.exe that filled this slot is no longer built anywhere, so it
 * already failed on a stock install, and its unauthenticated port was the
 * hole #747 and #799 were about.
 *
 * Not LinuxAppController for WSLg either: WSLg's X server holds only the
 * distro's own GUI windows, never the Windows desktop the user is looking at
 * (measured under WSLg 1.0.73: with Windows apps open, `xprop -root` reports
 * `_NET_ACTIVE_WINDOW` 0x0 and no `_NET_CLIENT_LIST`). The X11 tools would
 * list, click, type into and capture an empty Linux display, and say they
 * had. The working path is the Go sidecar on Windows, which desktop.ts routes
 * to whenever one with the `desktop` capability is connected.
 */
export const WSL_NO_LOCAL_DESKTOP =
  'Local desktop control is not available under WSL: the Windows desktop cannot be reached from inside ' +
  'the distro. Run the JARVIS sidecar on Windows and enroll it; desktop tools then route to it ' +
  'automatically, or pass its name as "target". Nothing was done.';

// Cached per process. Nothing on the controllers needs it any more (the
// sidecar probe that kept a connection here went in #799); it saves building
// one per tool call.
let cachedController: AppController | null = null;

export function getAppController(): AppController {
  if (cachedController) return cachedController;
  cachedController = createAppController();
  return cachedController;
}

/** @internal Test only: forget the cached controller. */
export function __resetAppControllerForTests(): void {
  cachedController = null;
}

function createAppController(): AppController {
  const platform = process.platform;

  switch (platform) {
    case 'linux': {
      const { WSLBridge } = require('../terminal/wsl-bridge.ts');
      if (WSLBridge.isWSL()) {
        // Typed as not_started: nothing was attempted, so the caller must not
        // report an action that may have happened.
        throw new ActionOutcomeError({
          status: 'blocked', code: 'LOCAL_DESKTOP_UNAVAILABLE', effect: 'not_started',
          message: `Error: ${WSL_NO_LOCAL_DESKTOP}`,
        });
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
