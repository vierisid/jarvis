/**
 * Maps tool names and categories to ActionCategory for authority checks.
 */

import type { ActionCategory } from '../roles/authority.ts';

/**
 * Explicit mapping from tool name -> ActionCategory
 */
export const TOOL_ACTION_MAP: Record<string, ActionCategory> = {
  // Terminal
  run_command: 'execute_command',

  // File ops
  read_file: 'read_data',
  write_file: 'write_data',
  list_directory: 'read_data',

  // Browser
  browser_navigate: 'access_browser',
  browser_snapshot: 'access_browser',
  browser_click: 'access_browser',
  browser_type: 'access_browser',
  browser_scroll: 'access_browser',
  // Arbitrary JavaScript in the page is code execution, not browsing.
  browser_evaluate: 'execute_command',
  browser_screenshot: 'access_browser',
  // Sends a local file out: a write to the outside world.
  browser_upload_file: 'write_data',

  // Desktop. Reads are reads; only tools that act on the desktop are
  // control_app, so a read cannot make its own follow-up steps gated.
  desktop_list_windows: 'read_data',
  desktop_focus_window: 'control_app',
  desktop_snapshot: 'read_data',
  desktop_find_element: 'read_data',
  desktop_click: 'control_app',
  desktop_type: 'control_app',
  desktop_press_keys: 'control_app',
  desktop_launch_app: 'control_app',
  desktop_screenshot: 'read_data',

  // Small writes that used to fall through to read_data.
  set_clipboard: 'write_data',
  create_document: 'write_data',
  manage_goals: 'write_data',

  // Delegation
  delegate_task: 'spawn_agent',
  manage_agents: 'spawn_agent',

  // Content / tasks
  content_pipeline: 'write_data',
  commitments: 'write_data',
  research_queue: 'read_data',

  // Authority
  // request_approval is the intent-gate tool; the orchestrator bypasses its
  // authority check (it IS the authority mechanism). Mapped here anyway for
  // audit trail completeness — it's effectively a read of the user's will.
  request_approval: 'read_data',
};

/**
 * Fallback mapping from tool category -> ActionCategory
 */
export const CATEGORY_ACTION_MAP: Record<string, ActionCategory> = {
  terminal: 'execute_command',
  'file-ops': 'write_data',
  browser: 'access_browser',
  desktop: 'control_app',
  delegation: 'spawn_agent',
  content: 'write_data',
  tasks: 'write_data',
  productivity: 'read_data',
};

/**
 * Resolve the ActionCategory for a given tool.
 * Checks explicit tool name map first, then falls back to category map, then defaults to read_data.
 */
export function getActionForTool(toolName: string, toolCategory: string): ActionCategory {
  if (TOOL_ACTION_MAP[toolName]) {
    return TOOL_ACTION_MAP[toolName];
  }
  if (CATEGORY_ACTION_MAP[toolCategory]) {
    return CATEGORY_ACTION_MAP[toolCategory];
  }
  return 'read_data';
}
