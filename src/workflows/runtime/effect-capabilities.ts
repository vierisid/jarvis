import type { ToolDefinition } from '../../actions/tools/registry';
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
  return tool.workflowEffect?.category ?? TOOL_ACTION_MAP[tool.name] ?? 'execute_command';
}

export function toolEffectCapability(tool: ToolDefinition, params: Record<string, unknown> = {}) {
  if (OPAQUE_TOOLS.has(tool.name)) throw new Error(`Unsupported direct workflow capability: ${tool.name} has opaque code/UI effects; use a typed governed adapter`);
  if (GATED_TOOLS.has(tool.name) && !tool.workflowEffect) return gatedCapability(tool, params);
  const category = tool.workflowEffect?.category
    ?? (BOUNDED_TOOLS.has(tool.name) ? TOOL_ACTION_MAP[tool.name] : undefined);
  if (!category || !Object.hasOwn(AUTHORITY_REQUIREMENTS, category)) {
    throw new Error(`Unsupported direct workflow capability: ${tool.name} has no declared Authority action`);
  }
  return { category, categories: [category], target: tool.workflowEffect?.target ?? ((params: Record<string, unknown>) => boundedTarget(tool.name, params)),
    prepareArguments: (params: Record<string, unknown>) => {
      if (tool.workflowEffect) return params;
      const target = boundedTarget(tool.name, params);
      return { ...params, ...(target.sidecarId ? { target: target.sidecarId } : {}),
        ...(target.path !== null ? { path: target.path } : {}) };
    } };
}
