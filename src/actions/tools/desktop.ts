/**
 * Desktop Tools — Desktop Automation via Sidecar RPC or Local Execution
 *
 * 9 tools for controlling desktop applications. Each tool accepts a `target`
 * parameter to route to a specific sidecar. Without `target`, executes locally
 * via the platform AppController when available. Respects --no-local-tools flag.
 *
 * The same tools work on all platforms (Windows, macOS, Linux). The sidecar
 * handles platform-specific implementation details internally.
 */

import type { AppController, UIElement, WindowInfo } from '../app-control/interface.ts';
import { getAppController } from '../app-control/interface.ts';
import type { ToolDefinition, ToolResult } from './registry.ts';
import { routeToSidecar } from './sidecar-route.ts';
import { isNoLocalTools, LOCAL_DISABLED_MSG } from './local-tools-guard.ts';

type FlatSnapshotElement = {
  id: number;
  role: string;
  name: string;
  value: string | null;
  depth: number;
  bounds: UIElement['bounds'] | null;
  properties: Record<string, unknown>;
};

type LocalSnapshot = {
  window: { pid: number; title: string; className: string };
  elements: FlatSnapshotElement[];
  totalElements: number;
};

type SnapshotCapableController = AppController & {
  snapshot?: (pid?: number, depth?: number) => Promise<{
    window: { pid: number; title: string; className: string };
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value: string | null;
      depth: number;
      isEnabled?: boolean;
      bounds?: UIElement['bounds'];
      properties?: Record<string, unknown>;
    }>;
    totalElements: number;
  }>;
  clickById?: (elementId: number) => Promise<string>;
  typeById?: (elementId: number | undefined, text: string) => Promise<string>;
  screenshotBase64?: (pid?: number) => Promise<{ base64: string; mimeType: string }>;
};

let localControllerFactory: () => AppController = () => getAppController();
let localElementCache = new Map<number, UIElement>();
let lastLocalSnapshot: LocalSnapshot | null = null;

export function __setLocalDesktopControllerFactoryForTests(factory: (() => AppController) | null): void {
  localControllerFactory = factory ?? (() => getAppController());
  __resetLocalDesktopStateForTests();
}

export function __resetLocalDesktopStateForTests(): void {
  localElementCache.clear();
  lastLocalSnapshot = null;
}

function isToolDisabled(): string | null {
  if (isNoLocalTools()) {
    return LOCAL_DISABLED_MSG;
  }
  return null;
}

function getLocalController(): SnapshotCapableController {
  return localControllerFactory() as SnapshotCapableController;
}

function formatBounds(bounds: WindowInfo['bounds']): string {
  return `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`;
}

function formatWindows(windows: WindowInfo[]): string {
  if (windows.length === 0) {
    return 'No visible windows found.';
  }

  return windows
    .map((window) => {
      const focused = window.focused ? ' [focused]' : '';
      return `PID ${window.pid}${focused} | ${window.title || '(untitled)'} | class=${window.className || 'unknown'} | bounds=${formatBounds(window.bounds)}`;
    })
    .join('\n');
}

function flattenElements(
  elements: UIElement[],
  depthLimit: number,
  depth: number,
  flattened: FlatSnapshotElement[],
): void {
  if (depth > depthLimit) {
    return;
  }

  for (const element of elements) {
    const numericId = flattened.length + 1;
    localElementCache.set(numericId, element);
    flattened.push({
      id: numericId,
      role: element.role,
      name: element.name,
      value: element.value,
      depth,
      bounds: element.bounds,
      properties: element.properties,
    });

    if (element.children.length > 0) {
      flattenElements(element.children, depthLimit, depth + 1, flattened);
    }
  }
}

async function buildLocalSnapshot(controller: SnapshotCapableController, pid?: number, depth: number = 8): Promise<LocalSnapshot> {
  localElementCache.clear();

  if (typeof controller.snapshot === 'function') {
    const snap = await controller.snapshot(pid, depth);
    lastLocalSnapshot = {
      window: snap.window,
      elements: snap.elements.map((element) => ({
        id: element.id,
        role: element.role,
        name: element.name,
        value: element.value,
        depth: element.depth,
        bounds: element.bounds ?? null,
        properties: {
          ...(element.properties ?? {}),
          isEnabled: element.isEnabled ?? true,
        },
      })),
      totalElements: snap.totalElements,
    };
    return lastLocalSnapshot;
  }

  const window = pid !== undefined
    ? (await controller.listWindows()).find((entry) => entry.pid === pid) ?? null
    : await controller.getActiveWindow();

  if (!window) {
    throw new Error(`No window found for PID ${pid}`);
  }

  const elements = await controller.getWindowTree(window.pid);
  const flattened: FlatSnapshotElement[] = [];
  flattenElements(elements, depth, 0, flattened);

  lastLocalSnapshot = {
    window: { pid: window.pid, title: window.title, className: window.className },
    elements: flattened,
    totalElements: flattened.length,
  };
  return lastLocalSnapshot;
}

function formatSnapshot(snapshot: LocalSnapshot): string {
  const lines = [
    `Window: ${snapshot.window.title || '(untitled)'}`,
    `PID: ${snapshot.window.pid}`,
    `Class: ${snapshot.window.className || 'unknown'}`,
    '',
  ];

  if (snapshot.elements.length === 0) {
    lines.push('(no UI elements found)');
    return lines.join('\n');
  }

  lines.push(`--- UI Elements (${snapshot.elements.length}/${snapshot.totalElements}) ---`);
  for (const element of snapshot.elements) {
    const details: string[] = [];
    if (element.name) details.push(`"${element.name}"`);
    if (element.value) details.push(`value="${element.value}"`);
    const className = typeof element.properties.className === 'string' ? element.properties.className : null;
    if (className) details.push(`class="${className}"`);
    if (element.bounds) details.push(`bounds=${formatBounds(element.bounds)}`);
    lines.push(`${'  '.repeat(element.depth)}[${element.id}] ${element.role || 'element'}${details.length > 0 ? ` ${details.join(' ')}` : ''}`);
  }

  return lines.join('\n');
}

function ensureCachedElement(elementId: number): UIElement {
  const element = localElementCache.get(elementId);
  if (!element) {
    throw new Error(`Element [${elementId}] not found. Run desktop_snapshot first.`);
  }
  return element;
}

function withAction(element: UIElement, action?: string): UIElement {
  if (!action || action === 'click') {
    return element;
  }

  return {
    ...element,
    properties: {
      ...element.properties,
      action,
    },
  };
}

function unsupportedAction(action: string): string {
  return `Error: Local desktop action "${action}" is not supported by this platform controller.`;
}

async function executeLocal<T>(fn: (controller: SnapshotCapableController) => Promise<T>): Promise<T | string> {
  const disabled = isToolDisabled();
  if (disabled) {
    return disabled;
  }

  try {
    return await fn(getLocalController());
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function normalizeKeys(keys: string): string[] {
  return keys
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function matchesElement(element: FlatSnapshotElement, params: Record<string, unknown>): boolean {
  const expectedName = typeof params.name === 'string' ? params.name : null;
  const expectedRole = typeof params.control_type === 'string' ? params.control_type.toLowerCase() : null;
  const expectedAutomationId = typeof params.automation_id === 'string' ? params.automation_id : null;
  const expectedClassName = typeof params.class_name === 'string' ? params.class_name : null;

  if (expectedName && element.name !== expectedName) return false;
  if (expectedRole && element.role.toLowerCase() !== expectedRole) return false;
  if (expectedAutomationId && element.properties.automationId !== expectedAutomationId) return false;
  if (expectedClassName && element.properties.className !== expectedClassName) return false;

  return true;
}

function formatElementMatches(matches: FlatSnapshotElement[]): string {
  if (matches.length === 0) {
    return 'No matching elements found.';
  }

  return matches
    .map((element) => `[${element.id}] ${element.role || 'element'} "${element.name || '(unnamed)'}"`)
    .join('\n');
}

// --- Tool definitions ---

export const desktopListWindowsTool: ToolDefinition = {
  name: 'desktop_list_windows',
  description: 'List all visible windows on the desktop. Returns window titles, PIDs, class names, and positions. Use the PID with other desktop tools to target a specific window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'list_windows', params, 'desktop');
    }
    return executeLocal(async (controller) => formatWindows(await controller.listWindows()));
  },
};

export const desktopSnapshotTool: ToolDefinition = {
  name: 'desktop_snapshot',
  description: 'Get the UI element tree of a window (like browser_snapshot but for desktop apps). Each element has an [id] you can use with desktop_click and desktop_type. If no pid is given, snapshots the active (focused) window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window (from desktop_list_windows). Omit for the active window.',
      required: false,
    },
    depth: {
      type: 'number',
      description: 'Max tree depth to walk (default: 8). Decrease for faster but shallower snapshots.',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'get_window_tree', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      const snapshot = await buildLocalSnapshot(controller, params.pid as number | undefined, (params.depth as number | undefined) ?? 8);
      return formatSnapshot(snapshot);
    });
  },
};

export const desktopClickTool: ToolDefinition = {
  name: 'desktop_click',
  description: 'Click or interact with a UI element by its [id] from the last desktop_snapshot or desktop_find_element. Default action is "click". Use the action parameter for richer interactions like double_click, right_click, invoke, toggle, set_value, expand, etc. Available actions vary by platform.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    element_id: {
      type: 'number',
      description: 'The [id] of the element to interact with (from desktop_snapshot or desktop_find_element)',
      required: true,
    },
    action: {
      type: 'string',
      description: 'Action to perform: click (default), double_click, right_click, invoke, toggle, select, set_value, get_value, get_text, expand, collapse, scroll_into_view, focus',
      required: false,
    },
    value: {
      type: 'string',
      description: 'Value to set (only for set_value action)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'click_element', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      const action = (params.action as string | undefined) ?? 'click';
      if (!['click', 'double_click', 'right_click', 'focus'].includes(action)) {
        return unsupportedAction(action);
      }
      if (typeof controller.clickById === 'function') {
        if (action !== 'click') {
          return unsupportedAction(action);
        }
        return controller.clickById(params.element_id as number);
      }
      const element = withAction(ensureCachedElement(params.element_id as number), action);
      await controller.clickElement(element);
      return `Clicked element [${params.element_id}] with action "${action}".`;
    });
  },
};

export const desktopTypeTool: ToolDefinition = {
  name: 'desktop_type',
  description: 'Type text into a UI element. Optionally provide an element_id to click and focus it first. Without element_id, types into whatever is currently focused.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    text: {
      type: 'string',
      description: 'The text to type',
      required: true,
    },
    element_id: {
      type: 'number',
      description: 'Optional [id] of element to click before typing (from desktop_snapshot)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'type_text', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      const elementId = params.element_id as number | undefined;
      if (typeof controller.typeById === 'function') {
        return controller.typeById(elementId, params.text as string);
      }
      if (elementId !== undefined) {
        await controller.clickElement(ensureCachedElement(elementId));
        await Bun.sleep(100);
      }
      await controller.typeText(params.text as string);
      return elementId !== undefined
        ? `Typed "${params.text as string}" into element [${elementId}].`
        : `Typed "${params.text as string}".`;
    });
  },
};

export const desktopPressKeysTool: ToolDefinition = {
  name: 'desktop_press_keys',
  description: 'Press a keyboard shortcut or key combination. Keys are pressed simultaneously (e.g., "ctrl,s" for save, "alt,f4" to close). Single keys also work: "enter", "tab", "escape".',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    keys: {
      type: 'string',
      description: 'Comma-separated key names (e.g., "ctrl,s" or "alt,f4" or "enter"). Modifiers: ctrl, alt, shift, win.',
      required: true,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'press_keys', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      const keys = normalizeKeys(params.keys as string);
      await controller.pressKeys(keys);
      return `Pressed keys: ${keys.join('+')}`;
    });
  },
};

export const desktopLaunchAppTool: ToolDefinition = {
  name: 'desktop_launch_app',
  description: 'Launch an application by executable path or name (e.g., "notepad.exe", "calc.exe"). Returns the PID of the launched process.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    executable: {
      type: 'string',
      description: 'Application executable path or name',
      required: true,
    },
    args: {
      type: 'string',
      description: 'Optional command-line arguments',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'launch_app', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      if (typeof controller.launchApp !== 'function') {
        throw new Error(`Local app launch is not supported on ${process.platform}`);
      }
      const result = await controller.launchApp(params.executable as string, params.args as string | undefined);
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    });
  },
};

export const desktopScreenshotTool: ToolDefinition = {
  name: 'desktop_screenshot',
  description: 'Take a screenshot of the entire desktop or a specific window. The image is sent directly to the AI for visual analysis. Useful for complex UIs, graphics apps, or when the element tree is insufficient.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of window to capture. Omit for full desktop screenshot.',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'capture_screen', params, 'screenshot');
    }
    return executeLocal(async (controller) => {
      let base64: string;
      let mimeType = 'image/png';

      if (typeof controller.screenshotBase64 === 'function') {
        const image = await controller.screenshotBase64(params.pid as number | undefined);
        base64 = image.base64;
        mimeType = image.mimeType;
      } else {
        const buffer = params.pid !== undefined
          ? await controller.captureWindow(params.pid as number)
          : await controller.captureScreen();
        base64 = buffer.toString('base64');
      }

      return {
        content: [
          { type: 'text' as const, text: 'Desktop screenshot captured.' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
        ],
      } satisfies ToolResult;
    });
  },
};

export const desktopFocusWindowTool: ToolDefinition = {
  name: 'desktop_focus_window',
  description: 'Bring a window to the foreground by its PID (from desktop_list_windows). Use this before interacting with a background window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window to focus',
      required: true,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'focus_window', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      await controller.focusWindow(params.pid as number);
      return `Focused window PID ${params.pid as number}.`;
    });
  },
};

export const desktopFindElementTool: ToolDefinition = {
  name: 'desktop_find_element',
  description: 'Search for UI elements by property (name, control type, class name, automation ID). Returns matching elements with [id] for use with desktop_click and desktop_type. Useful when you know what you are looking for without scanning the full tree.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    pid: {
      type: 'number',
      description: 'Process ID of the window. Omit for the foreground window.',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Element name to search for (exact match)',
      required: false,
    },
    control_type: {
      type: 'string',
      description: 'Control type to filter by (e.g., Button, Edit, Text, ComboBox, ListItem, TreeItem, MenuItem, Tab)',
      required: false,
    },
    automation_id: {
      type: 'string',
      description: 'AutomationId to search for (Windows only, ignored on other platforms)',
      required: false,
    },
    class_name: {
      type: 'string',
      description: 'Class name to search for',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'find_element', params, 'desktop');
    }
    return executeLocal(async (controller) => {
      if (!params.name && !params.control_type && !params.automation_id && !params.class_name) {
        throw new Error('At least one search filter is required.');
      }
      const snapshot = await buildLocalSnapshot(controller, params.pid as number | undefined);
      return formatElementMatches(snapshot.elements.filter((element) => matchesElement(element, params)));
    });
  },
};

/**
 * All desktop tools in a single array — platform-agnostic.
 */
export const DESKTOP_TOOLS: ToolDefinition[] = [
  desktopListWindowsTool,
  desktopSnapshotTool,
  desktopClickTool,
  desktopTypeTool,
  desktopPressKeysTool,
  desktopLaunchAppTool,
  desktopScreenshotTool,
  desktopFocusWindowTool,
  desktopFindElementTool,
];
