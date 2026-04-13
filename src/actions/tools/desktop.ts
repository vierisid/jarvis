/**
 * Desktop Tools — Desktop Automation via Sidecar RPC
 *
 * 9 tools for controlling desktop applications. Each tool accepts an optional
 * `target` parameter to route to a specific sidecar. Without `target`, the
 * tool auto-resolves to the single connected sidecar that has the required
 * capability (desktop or screenshot). When the choice is ambiguous or no
 * sidecar is available, a clear error guides the user.
 *
 * The same tools work on all platforms (Windows, macOS, Linux). The sidecar
 * handles platform-specific implementation details internally.
 */

import type { ToolDefinition, ToolResult } from './registry.ts';
import { routeToSidecarOrDefault } from './sidecar-route.ts';

// --- Tool definitions ---

export const desktopListWindowsTool: ToolDefinition = {
  name: 'desktop_list_windows',
  description: 'List all visible windows on the desktop. Returns window titles, PIDs, class names, and positions. Use the PID with other desktop tools to target a specific window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    return routeToSidecarOrDefault(target, 'list_windows', params, 'desktop');
  },
};

export const desktopSnapshotTool: ToolDefinition = {
  name: 'desktop_snapshot',
  description: 'Get the UI element tree of a window (like browser_snapshot but for desktop apps). Each element has an [id] you can use with desktop_click and desktop_type. If no pid is given, snapshots the active (focused) window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'get_window_tree', params, 'desktop');
  },
};

export const desktopClickTool: ToolDefinition = {
  name: 'desktop_click',
  description: 'Click or interact with a UI element by its [id] from the last desktop_snapshot or desktop_find_element. Default action is "click". Use the action parameter for richer interactions like double_click, right_click, invoke, toggle, set_value, expand, etc. Available actions vary by platform.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'click_element', params, 'desktop');
  },
};

export const desktopTypeTool: ToolDefinition = {
  name: 'desktop_type',
  description: 'Type text into a UI element. Optionally provide an element_id to click and focus it first. Without element_id, types into whatever is currently focused.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'type_text', params, 'desktop');
  },
};

export const desktopPressKeysTool: ToolDefinition = {
  name: 'desktop_press_keys',
  description: 'Press a keyboard shortcut or key combination. Keys are pressed simultaneously (e.g., "ctrl,s" for save, "alt,f4" to close). Single keys also work: "enter", "tab", "escape".',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'press_keys', params, 'desktop');
  },
};

export const desktopLaunchAppTool: ToolDefinition = {
  name: 'desktop_launch_app',
  description: 'Launch an application by executable path or name (e.g., "notepad.exe", "calc.exe"). Returns the PID of the launched process.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'launch_app', params, 'desktop');
  },
};

export const desktopScreenshotTool: ToolDefinition = {
  name: 'desktop_screenshot',
  description: 'Take a screenshot of the entire desktop or a specific window. The image is sent directly to the AI for visual analysis. Useful for complex UIs, graphics apps, or when the element tree is insufficient.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'capture_screen', params, 'screenshot');
  },
};

export const desktopFocusWindowTool: ToolDefinition = {
  name: 'desktop_focus_window',
  description: 'Bring a window to the foreground by its PID (from desktop_list_windows). Use this before interacting with a background window.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'focus_window', params, 'desktop');
  },
};

export const desktopFindElementTool: ToolDefinition = {
  name: 'desktop_find_element',
  description: 'Search for UI elements by property (name, control type, class name, automation ID). Returns matching elements with [id] for use with desktop_click and desktop_type. Useful when you know what you are looking for without scanning the full tree.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit to auto-select an available sidecar)',
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
    return routeToSidecarOrDefault(target, 'find_element', params, 'desktop');
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
