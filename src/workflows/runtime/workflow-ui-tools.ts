import type { ToolDefinition } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { desktopRefusal, isDesktopEnabled, isScreenCaptureEnabled, SCREEN_READ_TOOLS, toolAlwaysUsesDesktop } from '../../actions/tools/desktop-guard';
import { BOUNDED_TOOLS } from './tool-capability';
import { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview } from '../../authority/ui-intent';
export { WORKFLOW_REVIEWED_UI_TOOLS, workflowUiReview };

export const UNSUPPORTED_WORKFLOW_TOOLS: ReadonlySet<string> = new Set([
  'run_command', 'browser_evaluate', 'browser_upload_file', 'desktop_type', 'desktop_press_keys',
  'desktop_pointer', 'record_skill', 'manage_skills', 'ui_act',
]);

export function workflowToolRefusal(name: string): string | null {
  if (!UNSUPPORTED_WORKFLOW_TOOLS.has(name)) return null;
  if (name === 'browser_upload_file') return 'browser_upload_file has no computer-bound workflow adapter or sidecar route. Use a supported file-upload connector instead.';
  if (name === 'desktop_type' || name === 'desktop_press_keys') {
    return `${name} cannot run in a workflow because it can send input to whichever window has focus. Use a desktop agent to open the app, inspect its current editor, set that element's value with desktop_click (action set_value), and read it back with action get_value. If the editor does not support setting its value, report the limitation.`;
  }
  if (name === 'desktop_pointer') {
    return 'desktop_pointer cannot run in a workflow because it acts on whatever is at a place on the screen at that moment, which a saved flow cannot know. Use a desktop agent that looks at the screen first.';
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

/**
 * A workflow key press runs only in this computer's own browser (#1314). It
 * is bound to the reviewed document, and only the local controller can hold
 * that binding: the sidecar's key handler checks no document. Composition,
 * activation and dispatch all refuse a key press bound for another computer.
 */
export const REMOTE_KEY_PRESS_REFUSAL = 'browser_press_key runs in a workflow only in the browser on the Jarvis computer itself: '
  + 'on another computer the key cannot be bound to the page you reviewed. To press Enter in a field there, use browser_type with submit set to true.';

/** The refusal for a workflow key press that would reach another computer, or null. */
export function remoteKeyPressRefusal(toolName: string, params: Record<string, unknown>,
  pin: { sidecarId: string | null } | undefined): string | null {
  if (toolName !== 'browser_press_key') return null;
  // Decided from what the step names and the flow's pin, never by resolving a
  // computer (#1314 review): resolving would bind the run before the pin check,
  // and a refusal of the binding would read as this one. A target always names
  // an enrolled computer (the Jarvis host has no name); with none, the pin
  // decides; an unpinned step is refused by the pin check instead.
  if (typeof params.target === 'string' && params.target.trim()) return REMOTE_KEY_PRESS_REFUSAL;
  return pin && pin.sidecarId !== null ? REMOTE_KEY_PRESS_REFUSAL : null;
}

/** What a machine inventory says, for the static checks below. */
export type WorkflowMachineView = { id: string; name: string; capabilities?: readonly string[] };

const isTemplate = (value: unknown): boolean => typeof value === 'string' && value.includes('{{');

/** A step's params as the graph states them: an object, or null when run data decides them whole. */
export function statedStepParams(raw: unknown): Record<string, unknown> | null {
  let value = raw ?? {};
  if (typeof value === 'string') {
    if (value.trim().startsWith('{{')) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Why a direct reviewed-UI step cannot run as composed, keyed by the input
 * path it is about. Static: composition, activation and the composer's own
 * validation all ask it, so a refusal arrives before anything runs.
 */
export function workflowUiStepRefusals(toolName: string, rawParams: unknown,
  machines?: readonly WorkflowMachineView[]): Array<{ path: string; message: string; code?: 'TOOL_BINDING' }> {
  if (!WORKFLOW_REVIEWED_UI_TOOLS.has(toolName)) return [];
  const out: Array<{ path: string; message: string; code?: 'TOOL_BINDING' }> = [];
  const params = statedStepParams(rawParams);
  // The computer is never run data's to choose (#1314 M2), nor are the
  // params as a whole, which would choose it too.
  if (!params) out.push({ path: 'settings.input.params', code: 'TOOL_BINDING',
    message: 'Write this step\'s params out one by one: a template for all of them would let run data choose the computer and every value.' });
  else if (isTemplate(params.target)) out.push({ path: 'settings.input.params.target', code: 'TOOL_BINDING',
    message: 'Name the computer directly, or leave it out to use the computer the workflow is enabled with: a template would let run data choose which computer this action runs on.' });
  if (toolName === 'desktop_click' && params) {
    if (params.element_id !== undefined && !isTemplate(params.element_id)) {
      out.push({ path: 'settings.input.params.element_id', message: DESKTOP_ELEMENT_ID_REFUSAL });
    }
    if (params.action === 'get_value') {
      out.push({ path: 'settings.input.params.action', message: 'desktop_click with action get_value is a read a desktop agent makes after its own desktop_snapshot; it is not a workflow step. Use jarvis-agent:delegate with a desktop role.' });
    }
  }
  if (toolName === 'browser_press_key' && params && !isTemplate(params.target)) {
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    // No target: the computer pinned at enable is the most recent one that
    // serves the browser, so any enrolled browser computer means a remote key.
    if (target || machines?.some(m => m.capabilities?.includes('browser'))) {
      out.push({ path: 'settings.input.params.target', message: REMOTE_KEY_PRESS_REFUSAL });
    }
  }
  return out;
}

/**
 * A desktop element id is a number the sidecar handed out in one snapshot of
 * one window (#1314 m8): written into a workflow, it names whatever control
 * holds that number in some later run's snapshot, or nothing. So a direct
 * desktop_click must take its id from this run's data; the card then names
 * the element as this run's latest desktop snapshot did.
 */
export const DESKTOP_ELEMENT_ID_REFUSAL = 'A desktop element id written into a workflow names nothing: ids come from a desktop_snapshot taken in the same run, and change between runs. '
  + 'Use jarvis-agent:delegate with a desktop role (computer-operator), which observes the app and picks the element itself.';

/**
 * A tool turned off by a switch, read live (#1314 m6): composing or enabling a
 * flow around it would only fail at its first run, and a run admitted while it
 * is off says which switch, not that the action is unsupported.
 */
export function workflowToolSwitchRefusal(tool: ToolDefinition): { code: 'DESKTOP_DISABLED' | 'SCREEN_CAPTURE_DISABLED'; message: string } | null {
  if (!isDesktopEnabled() && toolAlwaysUsesDesktop(tool)) {
    return { code: 'DESKTOP_DISABLED', message: `${tool.name} is unavailable while desktop control is turned off (desktop.enabled: false). Turn it on in Settings > General > Desktop control first.` };
  }
  if (SCREEN_READ_TOOLS.has(tool.name) && !isScreenCaptureEnabled()) {
    return { code: 'SCREEN_CAPTURE_DISABLED', message: `${tool.name} reads the screen, so it is unavailable while screen awareness is turned off. Turn awareness on first.` };
  }
  return null;
}

/**
 * Which waiting cards a switch just turned off (#1314 m6): one whose tool,
 * with its recorded arguments, the switches now refuse. A tool the registry
 * no longer holds, or arguments that cannot be read, close the card too: it
 * could not be judged runnable, and closing only means asking again.
 */
export function switchedOffCard(registry: { get(name: string): ToolDefinition | undefined } | null | undefined) {
  return (request: { tool_name: string; tool_arguments: string | null }): boolean => {
    const tool = registry?.get(request.tool_name);
    if (!tool) return /^desktop_/.test(request.tool_name) || SCREEN_READ_TOOLS.has(request.tool_name)
      ? !isDesktopEnabled() || !isScreenCaptureEnabled() : false;
    let args: Record<string, unknown>;
    try { args = JSON.parse(request.tool_arguments ?? '{}'); } catch { return true; }
    return desktopRefusal(tool, args) !== null;
  };
}
