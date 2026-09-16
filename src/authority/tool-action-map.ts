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
  browser_hover: 'access_browser',
  browser_press_key: 'access_browser',
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

  // Structural runtime. ui_snapshot only reads the accessibility tree, so it
  // is a read. ui_act dispatches to click_element / browser_ax_click /
  // browser_ax_set_value -- it clicks, types and toggles real controls on the
  // user's machine -- so it carries the same category as desktop_click. These
  // are spelled out per tool on purpose: a CATEGORY_ACTION_MAP entry for 'ui'
  // would have to pick one category for both and would hand the read-only
  // snapshot write authority.
  //
  // One tool drives both surfaces, and an action category cannot vary per
  // call, so ui_act is control_app even when it is acting on a browser page
  // -- stricter than browser_click's access_browser. Deliberate: the strict
  // side is the safe side, and control_app is the only one of the two that
  // the background-agent and taint-gating profiles govern. Do not "correct"
  // this to access_browser.
  ui_snapshot: 'read_data',
  ui_act: 'control_app',

  // Lists connected sidecars. Reached read_data only via the default at the
  // bottom of getActionForTool; spelled out so builtin-tool-coverage.test.ts
  // stays at zero unmapped tools.
  list_sidecars: 'read_data',

  // Reads whose tool category is 'general', so they reached read_data only via
  // the default at the bottom of getActionForTool. Spelled out because the
  // workflow effect boundary refuses any tool without an explicit action.
  get_clipboard: 'read_data',
  get_system_info: 'read_data',
  capture_screen: 'read_data',

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
