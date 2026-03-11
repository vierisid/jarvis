/**
 * Desktop Tools — Desktop Automation via Sidecar RPC or Local Execution
 *
 * 8 tools for controlling desktop applications. Each tool accepts a `target`
 * parameter to route to a specific sidecar. Without `target`, attempts local
 * execution (currently stub — TODO: implement per-platform AppController).
 * Respects --no-local-tools flag.
 */

import type { ToolDefinition, ToolResult } from './registry.ts';
import { routeToSidecar } from './sidecar-route.ts';
import { isNoLocalTools } from './local-tools-guard.ts';

const LOCAL_NOT_IMPLEMENTED = 'Error: Local desktop tool execution is not yet implemented. Specify a "target" sidecar to route this command to a remote machine, or use list_sidecars to see available sidecars.';
const LOCAL_DISABLED_MSG = 'Error: Local tool execution is disabled (--no-local-tools). Specify a "target" sidecar to route this command to a remote machine. Use list_sidecars to see available sidecars.';

function localGuard(): string {
  if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
  return LOCAL_NOT_IMPLEMENTED;
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
    return localGuard();
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
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'get_window_tree', params, 'desktop');
    }
    return localGuard();
  },
};

export const desktopClickTool: ToolDefinition = {
  name: 'desktop_click',
  description: 'Click a UI element by its [id] from the last desktop_snapshot. After clicking, use desktop_snapshot to see the updated state.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    element_id: {
      type: 'number',
      description: 'The [id] of the element to click (from desktop_snapshot)',
      required: true,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'click_element', params, 'desktop');
    }
    return localGuard();
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
    return localGuard();
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
    return localGuard();
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
    return localGuard();
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
    return localGuard();
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
    return localGuard();
  },
};

// --- FlaUI Tools (Windows-only, richer automation) ---

export const flauiInspectTool: ToolDefinition = {
  name: 'flaui_inspect',
  description: 'Inspect the UI element tree of a window using FlaUI (Windows only). Returns rich element info including AutomationId, ClassName, ControlType, supported patterns (Invoke, Value, Toggle, etc.), and bounding rectangles. Each element gets an [id] for use with flaui_action. More detailed than desktop_snapshot — use this when you need pattern info or deep tree walks.',
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
    depth: {
      type: 'number',
      description: 'Max tree depth to walk (default: 3). Increase for deeply nested UIs.',
      required: false,
    },
    include_invisible: {
      type: 'boolean',
      description: 'Include zero-size/invisible elements (default: false)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'flaui_inspect', params, 'desktop');
    }
    return localGuard();
  },
};

export const flauiFindTool: ToolDefinition = {
  name: 'flaui_find',
  description: 'Search for UI elements by property using FlaUI (Windows only). Finds elements matching one or more criteria: AutomationId, Name, ClassName, ControlType. Returns matching elements with [id] for use with flaui_action. Faster than inspecting the full tree when you know what you\'re looking for.',
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
    automation_id: {
      type: 'string',
      description: 'AutomationId to search for (exact match)',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Element name to search for (exact match)',
      required: false,
    },
    class_name: {
      type: 'string',
      description: 'CSS-like class name to search for',
      required: false,
    },
    control_type: {
      type: 'string',
      description: 'Control type to filter by (e.g., Button, Edit, Text, ComboBox, ListItem, TreeItem, MenuItem, Tab)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    if (target) {
      return routeToSidecar(target, 'flaui_find', params, 'desktop');
    }
    return localGuard();
  },
};

export const flauiActionTool: ToolDefinition = {
  name: 'flaui_action',
  description: 'Perform a rich UI action on an element using FlaUI (Windows only). Use element [id] from flaui_inspect or flaui_find. Actions: click, double_click, right_click, invoke (for buttons), toggle (for checkboxes), select (for list items), set_value (for text fields), get_value, get_text, expand, collapse, scroll_into_view, focus.',
  category: 'desktop',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to route this command to (omit for local execution)',
      required: false,
    },
    element_id: {
      type: 'number',
      description: 'The [id] of the element (from flaui_inspect or flaui_find)',
      required: true,
    },
    action: {
      type: 'string',
      description: 'Action to perform: click, double_click, right_click, invoke, toggle, select, set_value, get_value, get_text, expand, collapse, scroll_into_view, focus',
      required: true,
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
      return routeToSidecar(target, 'flaui_action', params, 'desktop');
    }
    return localGuard();
  },
};

/**
 * All desktop tools in a single array.
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
  flauiInspectTool,
  flauiFindTool,
  flauiActionTool,
];
