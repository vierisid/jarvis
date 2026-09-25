import type { ToolDefinition, ToolGate } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import { TOOL_ACTION_MAP, severityRank } from '../../authority/tool-action-map';
import { autoTargetForCapability, findSidecar, getSidecarManager } from '../../actions/tools/sidecar-route';
import { getDefaultCwd } from '../../actions/tools/local-tools-guard';
import type { SidecarCapability } from '../../sidecar/types';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getMachineScope } from '../../actions/machine-scope';

/**
 * Tools whose effect is bounded enough to describe a review target (a sidecar
 * and an absolute path) on an approval card. Names only: the Authority action
 * for each comes from the daemon's single source of truth, `TOOL_ACTION_MAP`,
 * so the two can never drift. `bounded-tools.test.ts` fails if a name here
 * stops resolving there.
 */
const BOUNDED_TOOLS = new Set<string>([
  'read_file', 'list_directory', 'write_file',
  'get_clipboard', 'set_clipboard', 'get_system_info', 'capture_screen',
  'browser_snapshot', 'browser_screenshot',
  'desktop_list_windows', 'desktop_snapshot', 'desktop_find_element', 'desktop_screenshot',
]);

/**
 * Tools whose effect is a script or a click sequence. A category label cannot
 * describe what they will do, so they need a typed adapter rather than an
 * approval that purports to understand raw code or arbitrary UI semantics.
 */
const OPAQUE_TOOLS = new Set(['run_command', 'browser_evaluate', 'browser_navigate', 'browser_click',
  'browser_type', 'browser_upload_file', 'browser_press_key', 'browser_hover', 'browser_scroll',
  'desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app', 'desktop_focus_window',
  // Recording installs input hooks behind a click the person makes; listing
  // and deleting skills is chat-side housekeeping. Neither belongs in a flow.
  'record_skill', 'manage_skills']);

/**
 * Tools whose effect is decided per call by their own `authorityGate`, not by
 * a name. `run_skill` replays whatever the named skill holds, so its category
 * is the worst case across the stored steps (a click on Send in a mail app is
 * send_email), its card names what will happen with the resolved values, and
 * its target carries the skill's name and version, so an approval reviewed
 * against one version cannot dispatch another. This is the typed adapter the
 * boundary asks for: the classification lives in `src/skills/effects.ts` and
 * is the same one the chat path uses.
 */
const GATED_TOOLS = new Set(['run_skill']);

/** Target keys the boundary owns; a tool's gate subject cannot set them. */
const RESERVED_TARGET_KEYS = new Set(['tool', 'capability', 'sidecarId', 'selection', 'machineBinding', 'intent']);

export const BOUNDED_TOOL_NAMES: ReadonlySet<string> = BOUNDED_TOOLS;
export const OPAQUE_TOOL_NAMES: ReadonlySet<string> = OPAQUE_TOOLS;
export const GATED_TOOL_NAMES: ReadonlySet<string> = GATED_TOOLS;

function pinnedSidecar(capability: SidecarCapability, requested: unknown): { sidecarId: string | null; selection: string; machineBinding?: unknown } {
  const scope = getMachineScope();
  const selector = scope ? scope.resolveTarget(requested, capability)
    : typeof requested === 'string' && requested.trim() ? requested : autoTargetForCapability(capability);
  const sidecar = selector ? findSidecar(selector, getSidecarManager()?.listSidecars() ?? []) : null;
  if (selector && !sidecar && !scope) throw new Error(`Workflow target unavailable: ${selector}`);
  return { sidecarId: scope ? selector : sidecar?.id ?? null, selection: selector ? 'pinned-sidecar' : 'local-host',
    ...(scope ? { machineBinding: scope.binding() } : {}) };
}

/**
 * Capability for a gated tool. The gate runs at review time with the frozen
 * arguments; what it returns is what the effect record, the approval card and
 * the dispatch check are all built from.
 */
function gatedCapability(tool: ToolDefinition, params: Record<string, unknown>) {
  const gate = tool.authorityGate?.(params);
  if (!gate) {
    throw new Error(`Unsupported direct workflow capability: ${tool.name} cannot resolve what it would do for ${JSON.stringify(params).slice(0, 120)} (unknown skill?)`);
  }
  const floor = TOOL_ACTION_MAP[tool.name] ?? 'execute_command';
  const known = (c: ActionCategory) => Object.hasOwn(AUTHORITY_REQUIREMENTS, c);
  const categories = [...new Set([floor, gate.actionCategory, ...(gate.actionCategories ?? [])].filter(known))]
    .sort((a, b) => severityRank(b) - severityRank(a));
  const surface = gate.subject?.surface;
  // A browser-only skill is pinned through the browser capability; anything
  // that touches a native window needs the desktop one.
  const capability: SidecarCapability = surface === 'browser' ? 'browser' : 'desktop';
  // `sidecarId`, `capability` and `machineBinding` in this record are what
  // validateTarget digests and what the machine-binding fence reads before
  // dispatch, so the boundary owns those keys outright: a subject key that
  // names one is dropped rather than allowed to shadow it. Spread order alone
  // is not enough, because `machineBinding` is only written when a scope
  // exists and a subject could otherwise supply one where none does.
  const subject = Object.fromEntries(Object.entries(gate.subject ?? {})
    .filter(([key]) => !RESERVED_TARGET_KEYS.has(key)));
  const target = (args: Record<string, unknown>): Record<string, unknown> => ({
    ...subject,
    tool: tool.name,
    ...pinnedSidecar(capability, args.target),
    capability,
    intent: gate.intent,
  });
  return {
    category: categories[0]!,
    categories,
    target,
    prepareArguments: (args: Record<string, unknown>) => {
      const pinned = pinnedSidecar(capability, args.target);
      return { ...args, ...(pinned.sidecarId ? { target: pinned.sidecarId } : {}) };
    },
  };
}

function boundedTarget(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const capability: SidecarCapability = tool.includes('file') || tool === 'list_directory' ? 'filesystem'
    : tool.includes('clipboard') ? 'clipboard' : tool === 'get_system_info' ? 'system_info'
    : tool === 'capture_screen' || tool === 'desktop_screenshot' ? 'screenshot'
    : tool.startsWith('browser_') ? 'browser' : 'desktop';
  const scope = getMachineScope();
  const selector = scope ? scope.resolveTarget(params.target, capability)
    : typeof params.target === 'string' && params.target.trim() ? params.target : autoTargetForCapability(capability);
  const sidecar = selector ? findSidecar(selector, getSidecarManager()?.listSidecars() ?? []) : null;
  if (selector && !sidecar && !scope) throw new Error(`Workflow target unavailable: ${selector}`);
  const path = params.path == null ? null : selector ? params.path : resolve(getDefaultCwd() || homedir(), String(params.path));
  return { tool, sidecarId: scope ? selector : sidecar?.id ?? null, path, selection: selector ? 'pinned-sidecar' : 'local-host',
    ...(scope ? { machineBinding: scope.binding(), capability } : {}) };
}

/**
 * Worst-case Authority action for a capability we are about to refuse. Used for
 * the audit row only: a refusal is still a governance decision and has to be
 * recorded. An opaque tool audits under its real category; a tool with no
 * declared action at all audits as the most severe one, never as `read_data`.
 */
export function refusedEffectCategory(tool: ToolDefinition): ActionCategory {
  // `Object.hasOwn`, not a raw index with `??`: `TOOL_ACTION_MAP['constructor']`
  // is a Function, which is not nullish, so `??` would not fire and the audit
  // row would carry a Function as its action_category.
  //
  // Note the map entry is a FLOOR and can sit deliberately below the tool's
  // worst case -- `manage_workflow` is write_data with its `delete` raised per
  // call by an authorityGate (#503). So this can under-state a refusal; it
  // never over-states one, and an unmapped tool still audits as the most
  // severe category rather than as a read.
  if (tool.workflowEffect?.category) return tool.workflowEffect.category;
  return Object.hasOwn(TOOL_ACTION_MAP, tool.name) ? TOOL_ACTION_MAP[tool.name]! : 'execute_command';
}

/**
 * A bounded tool's own per-call gate, or null. write_file is bounded AND
 * gated: a write to a shell startup file or a git hook is `execute_command`
 * (#522), and the agent path learns that from resolveToolGate. A gate that
 * throws counts as none here; the call site's resolveToolGate turns the same
 * throw into a mandatory review.
 */
function boundedGate(tool: ToolDefinition, params: Record<string, unknown>): ToolGate | null {
  if (tool.workflowEffect) return null;
  try { return tool.authorityGate?.(params) ?? null; } catch { return null; }
}

export function toolEffectCapability(tool: ToolDefinition, params: Record<string, unknown> = {}) {
  if (OPAQUE_TOOLS.has(tool.name)) throw new Error(`Unsupported direct workflow capability: ${tool.name} has opaque code/UI effects; use a typed governed adapter`);
  if (GATED_TOOLS.has(tool.name) && !tool.workflowEffect) return gatedCapability(tool, params);
  const floor = tool.workflowEffect?.category
    ?? (BOUNDED_TOOLS.has(tool.name) ? TOOL_ACTION_MAP[tool.name] : undefined);
  if (!floor || !Object.hasOwn(AUTHORITY_REQUIREMENTS, floor)) {
    throw new Error(`Unsupported direct workflow capability: ${tool.name} has no declared Authority action`);
  }
  const prepareArguments = (params: Record<string, unknown>) => {
    if (tool.workflowEffect) return params;
    const target = boundedTarget(tool.name, params);
    return { ...params, ...(target.sidecarId ? { target: target.sidecarId } : {}),
      ...(target.path !== null ? { path: target.path } : {}) };
  };
  // The floor, raised by the tool's gate. write_file's gate judges a
  // relative path against both the cwd and home, and coerces a non-string
  // the way prepareArguments will, so the arguments as given are enough.
  const gate = boundedGate(tool, params);
  const known = (c: ActionCategory) => Object.hasOwn(AUTHORITY_REQUIREMENTS, c);
  const raised = gate ? [gate.actionCategory, ...(gate.actionCategories ?? [])].filter(known) : [];
  const categories = [...new Set([floor, ...raised])].sort((a, b) => severityRank(b) - severityRank(a));
  // A raised call carries the gate's sentence in its target, so the card
  // shows it. At dispatch two checks catch a file that changed kind since
  // review: a changed CATEGORY no longer matches the recorded effect (the
  // boundary refuses it as changed), and a changed kind within the same
  // category changes this sentence, which validateTarget's digest catches.
  const target = tool.workflowEffect?.target ?? ((args: Record<string, unknown>) => {
    const bounded = boundedTarget(tool.name, args);
    const intent = boundedGate(tool, args)?.intent;
    return intent ? { ...bounded, intent } : bounded;
  });
  return { category: categories[0]!, categories, target, prepareArguments };
}
