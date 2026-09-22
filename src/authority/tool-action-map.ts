/**
 * Maps tool names and categories to ActionCategory for authority checks.
 */

import type { ActionCategory } from '../roles/authority.ts';
import { AUTHORITY_REQUIREMENTS } from '../roles/authority.ts';
import type { ToolDefinition, ToolGate } from '../actions/tools/registry.ts';
import { rawUiGate } from './ui-intent';

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
  // This is only a floor. resolveToolGate adds control_app and mandatory
  // review to raw browser mutations; ui_act also adds business-effect hints
  // from the addressed surface. access_browser alone never grants mutation.
  ui_snapshot: 'read_data',
  ui_act: 'control_app',

  // Skills. These entries are the FLOOR, not the whole story: run_skill
  // replays whatever steps the named skill holds, so each tool also carries
  // an `authorityGate` (src/actions/tools/skills.ts) that the gate sites
  // consult per call through resolveToolGate below. run_skill is gated on
  // the worst case across the skill's steps (a click on Send in a mail app
  // is send_email); record_skill installs system-wide input hooks and always
  // needs the person's confirmation on a card; manage_skills is a read
  // except delete, which the gate raises to delete_data.
  run_skill: 'control_app',
  record_skill: 'control_app',
  manage_skills: 'read_data',

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

/**
 * Severity order for categories that share a required level, so "stricter"
 * is a total order and a worst case is deterministic. Higher index is
 * stricter.
 */
const SEVERITY_TIE_ORDER: readonly ActionCategory[] = [
  'read_data', 'spawn_agent', 'write_data', 'send_message', 'access_browser',
  'control_app', 'execute_command', 'install_software', 'send_email',
  'terminate_agent', 'modify_settings', 'delete_data', 'make_payment',
];

export function severityRank(category: ActionCategory): number {
  const level = AUTHORITY_REQUIREMENTS[category] ?? 0;
  const tie = SEVERITY_TIE_ORDER.indexOf(category);
  return level * 100 + (tie < 0 ? 0 : tie);
}

/** The stricter of two categories: higher required level, then SEVERITY_TIE_ORDER. */
export function stricterCategory(a: ActionCategory, b: ActionCategory): ActionCategory {
  return severityRank(b) > severityRank(a) ? b : a;
}

export type ResolvedToolGate = {
  /** The most severe category the call reaches; the audit row and the card carry it. */
  actionCategory: ActionCategory;
  /** Every category the call must clear, floor included, most severe first. */
  categories: ActionCategory[];
  /** The static entry for the tool; what an above_level substitution still requires. */
  floorCategory: ActionCategory;
  intent?: string;
  confirm?: ToolGate['confirm'];
};

/**
 * Resolve what a call must clear: the static entry for the tool, raised by
 * the tool's own per-call gate when it declares one. Raw UI actions always
 * need review. A broken classifier also needs review, never automatic
 * execution under the floor alone. All agent gate sites use this resolver.
 */
export function resolveToolGate(
  tool: Pick<ToolDefinition, 'category' | 'authorityGate'> | undefined,
  toolName: string,
  params: Record<string, unknown>,
): ResolvedToolGate {
  const floorCategory = getActionForTool(toolName, tool?.category ?? 'unknown');
  const uiGate = rawUiGate(toolName, params);
  let gate: ToolGate | null = null;
  try {
    gate = tool?.authorityGate?.(params) ?? null;
  } catch (err) {
    console.warn(`[Authority] ${toolName} authorityGate threw; requiring explicit review:`, err instanceof Error ? err.message : err);
    gate = { actionCategory: floorCategory, confirm: 'always',
      intent: `Review ${toolName}. Business effect unknown: its effect classifier failed; no automatic execution is permitted.` };
  }
  if (!gate && !uiGate) return { actionCategory: floorCategory, categories: [floorCategory], floorCategory };
  const known = (c: ActionCategory) => Object.hasOwn(AUTHORITY_REQUIREMENTS, c);
  const declared = [gate, uiGate].flatMap(g => g ? [g.actionCategory, ...(g.actionCategories ?? [])] : []).filter(known);
  const categories = [...new Set([floorCategory, ...declared])].sort((a, b) => severityRank(b) - severityRank(a));
  return {
    actionCategory: categories[0]!,
    categories,
    floorCategory,
    intent: gate?.intent ?? uiGate?.intent,
    confirm: uiGate?.confirm === 'always' ? 'always' : gate?.confirm,
  };
}

/**
 * The approval-request `context` for a gated call. JSON so the dashboard's
 * intent formatter can read the sentence and the voice path can see that a
 * click is required; the plain "Agent attempted" string stays for tools
 * without a gate.
 */
export function gateContext(gate: ResolvedToolGate, toolName: string, params: Record<string, unknown>): string {
  if (!gate.intent) return `Agent attempted: ${toolName}(${JSON.stringify(params).slice(0, 200)})`;
  return JSON.stringify({ intent: gate.intent, ...(gate.confirm === 'always' ? { confirm: 'always' } : {}) });
}
