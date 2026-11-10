import type { ToolDefinition } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { BOUNDED_TOOLS } from './tool-capability';
import { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview } from '../../authority/ui-intent';
export { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview };

export const UNSUPPORTED_WORKFLOW_TOOLS: ReadonlySet<string> = new Set([
  'run_command', 'browser_evaluate', 'browser_upload_file', 'desktop_type', 'desktop_press_keys',
  'record_skill', 'manage_skills', 'ui_act',
]);

export function workflowToolRefusal(name: string): string | null {
  if (!UNSUPPORTED_WORKFLOW_TOOLS.has(name)) return null;
  if (name === 'browser_upload_file') return 'browser_upload_file has no computer-bound workflow adapter or sidecar route. Use a supported file-upload connector instead.';
  if (name === 'desktop_type' || name === 'desktop_press_keys') {
    return `${name} cannot run in a workflow because it can send input to whichever window has focus. Use a desktop agent to open the app, inspect its current editor, set that element's value with desktop_click (action set_value), and read it back with action get_value. If the editor does not support setting its value, report the limitation.`;
  }
  return `${name} is not supported as a direct workflow action. Use a supported connector, a recorded run_skill step, or a reviewed browser/desktop agent for supported UI actions.`;
}

/** Static declaration only: never selects a computer or dispatches while composing. */
export function workflowToolDeclarationRefusal(tool: ToolDefinition): string | null {
  const refusal = workflowToolRefusal(tool.name);
  if (refusal) return refusal;
  if (WORKFLOW_REVIEWED_UI_TOOLS.has(tool.name)) return workflowUiReview(tool, tool.name) ? null
    : `${tool.name} is unavailable in workflows because its live approval guard is missing.`;
  if (BOUNDED_TOOLS.has(tool.name) || tool.name === 'run_skill' || tool.workflowEffect) return null;
  return `${tool.name} has no supported direct workflow adapter. Use its dedicated workflow piece or an allowed agent task.`;
}

/**
 * The floor a direct `jarvis-tool` step's above-level card asks from, or
 * undefined when a shortfall denies. One function for the runtime route and
 * the awareness prediction, so the two cannot disagree again (#1314 m7): a
 * reviewed UI action asks from read_data, any other gated call from its own
 * floor.
 */
export function directToolAboveLevelFloor(tool: ToolDefinition, params: Record<string, unknown>,
  gate: { confirm?: unknown; floorCategory: ActionCategory }): ActionCategory | undefined {
  if (!gate.confirm) return undefined;
  return workflowUiReview(tool, tool.name, params) ? 'read_data' : gate.floorCategory;
}

/**
 * How long a workflow card for an action that is not bound to the reviewed
 * element stays answerable (owner decision on #1314): navigate, scroll and a
 * key press act on whatever page is current when they run, so a card answered
 * long after it was raised approves a screen nobody looked at. Five minutes is
 * the wait an inline chat approval already gives (`waitForDecision`'s default)
 * and the reviewer looking at the card is looking at the screen now. Past it
 * the card expires, and an approval granted in time but not dispatched in time
 * is refused too: never executed, typed APPROVAL_EXPIRED.
 */
export const WORKFLOW_UI_CARD_TTL_MS = 5 * 60_000;
export const EXPIRING_WORKFLOW_UI_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_scroll', 'browser_press_key']);

/** The deadline a new card for this call carries, or undefined. */
export function workflowUiCardDeadline(toolName: string, now = Date.now()): number | undefined {
  return EXPIRING_WORKFLOW_UI_TOOLS.has(toolName) ? now + WORKFLOW_UI_CARD_TTL_MS : undefined;
}

/** Refuse dispatching an approved card whose deadline has passed. */
export function assertWorkflowUiCardCurrent(approval: { context?: string | null } | null | undefined, now = Date.now()): void {
  let deadline: unknown;
  try { deadline = JSON.parse(approval?.context ?? '{}').expiresAt; } catch { deadline = undefined; }
  if (typeof deadline === 'number' && now > deadline) {
    throw new ActionOutcomeError({ status: 'blocked', code: 'APPROVAL_EXPIRED', effect: 'not_started',
      message: 'This approval was for the screen as it was when the card was raised, and it expired before the action ran. Nothing was done. Start a new run and review the current screen.' });
  }
}
