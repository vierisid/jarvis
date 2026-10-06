import type { ToolDefinition, ToolGate } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import { TOOL_ACTION_MAP, severityRank } from '../../authority/tool-action-map';
import { autoTargetForCapability, findSidecar, getSidecarManager } from '../../actions/tools/sidecar-route';
import { getDefaultCwd } from '../../actions/tools/local-tools-guard';
import type { SidecarCapability } from '../../sidecar/types';
import { resolve } from 'node:path';
import { policyHome } from '../../actions/tools/file-path-policy';
import { getMachineScope } from '../../actions/machine-scope';
import { rawUiGate, REVIEWED_UI_TOOLS } from '../../authority/ui-intent';

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

/**
 * Why this call cannot be approved through the boundary at all, or null.
 *
 * #638, and DEFENCE IN DEPTH rather than a plugged hole -- stated plainly
 * because the issue reads as the latter and the distinction is the whole value
 * of this function.
 *
 * WHAT IS REAL. An approval that acts on a live SURFACE is bound, on the
 * interactive path, by `captureApprovalGuard`: a closure holding the CDP
 * connection, the approval epoch and -- for an element-addressed tool -- the
 * document and the generation of the id map (#602). The boundary cannot hold
 * one. It is durable by design: a record parks on a MANUAL waitpoint for hours
 * and is rechecked on resume through `validateTarget`, which gets the frozen
 * arguments and the recorded target and nothing else. A closure does not cross
 * that gap, and what it closes over does not survive a restart --
 * `ApprovalManager.reconcileAfterRestart` clears `uiExecutions` outright, which
 * is why the chat path refuses a UI card whose binding is gone. So the boundary
 * must never be the thing that approves a surface-bound call.
 *
 * AND THE BINDING CANNOT BE MADE DURABLE, which is why this refuses instead of
 * persisting one. #638 reads as "price the guard against what `requestDigest`
 * already persists", so here is the price. That digest and `record.target`
 * persist NAMES -- a canonical sidecar id, an absolute path, a skill name and
 * version -- and a name still denotes the same thing after a restart, which is
 * what makes `validateTarget` able to recheck it hours later. A surface binding
 * has no name to persist. Measured on `ui_act`, the one tool at issue:
 * `actions/tools/ui.ts` addresses elements out of a process-local `Map` keyed by
 * a `nextId` that starts at 1, and it remembers `MAX_REMEMBERED_SNAPSHOTS = 4`
 * captures -- shared with chat, so four snapshots anywhere in the daemon evict
 * the entry. Over a waitpoint measured in hours the recorded id is simply gone,
 * and `uiActTool.authorityGate` then returns null, so the recomputed category
 * is LOWER; `validateTarget` on the delegated route compares
 * `severityRank(now) > severityRank(reviewed)` and is therefore blind in
 * exactly that direction. Persisting a generation counter that restarts at 1
 * would make the comparison PASS on a different surface -- a check that is
 * worse than no check, because it reads as one.
 *
 * So the durable answer is not a persisted binding; it is a typed adapter whose
 * target carries the reviewed SUBJECT and re-resolves it at dispatch, which is
 * what `run_skill` does (`skills/runtime.ts` re-captures the surface and
 * resolves each step's durable ref against the fresh capture). That is a
 * feature, not a fix, and nothing in a flow needs it today.
 *
 * WHAT WAS NOT REACHABLE, and why this is not a vulnerability fix. The two
 * routes into the boundary refuse these calls already, by different means, and
 * neither means is stated anywhere near the other:
 *
 *   - `toolsInvoke` calls `toolEffectCapability`, which throws for every
 *     browser/desktop action name (OPAQUE) and for `ui_act` (no declared
 *     Authority action).
 *   - the delegated sub-agent route gates on set membership and calls
 *     `toolEffectCapability` not at all -- so `ui_act`, which sits in
 *     `REVIEWED_UI_TOOLS` and in NONE of bounded/opaque/gated, passes both of
 *     its checks. It is nonetheless refused, three files away, by
 *     `sub-agent-runner.ts`: "a call the person must confirm cannot be made by
 *     a sub-agent at all" fires for `gate.confirm === 'always'`, and
 *     `rawUiGate` returns exactly that for every member of
 *     `REVIEWED_UI_TOOLS` (measured, all 14).
 *
 * So the delegate route's protection against the one name the sets disagree on
 * is incidental -- it depends on a gate in another subsystem, keyed on a
 * different property, for a reason that has nothing to do with binding. That is
 * the fragility worth closing: this makes the refusal local, explicit, and
 * independent of all three.
 *
 * TWO SIGNALS, covering the two drift directions:
 *
 *   - `rawUiGate(toolName, params)` -- the authoritative judgement of "this is
 *     a raw UI action requiring mandatory review". Used rather than
 *     `REVIEWED_UI_TOOLS.has(name)` so its carve-out comes along for free:
 *     `ui_act` with `action: 'get_value'` is a READ, is not reviewed, and must
 *     not be refused here either.
 *   - a declared `captureApprovalGuard` on a tool that is in NEITHER
 *     `REVIEWED_UI_TOOLS` nor `BOUNDED_TOOLS` -- a tool saying for itself that
 *     reviewing it is not enough, which nobody registered and whose effect the
 *     boundary cannot describe either. The only signal that would survive
 *     someone adding a guarded tool and forgetting `ui-intent.ts`.
 *
 *     BOTH exclusions carry their weight, and the second was found missing by
 *     review. `REVIEWED_UI_TOOLS` is what keeps the `get_value` read above from
 *     being re-refused. `BOUNDED_TOOLS` is what keeps a guarded READ from being
 *     refused at all: `createBrowserTools` (builtin.ts) ends with an
 *     unconditional loop that assigns `captureApprovalGuard` to EVERY tool it
 *     builds, `browser_snapshot` and `browser_screenshot` included, and neither
 *     is in `REVIEWED_UI_TOOLS`. Measured on that factory: all 9 tools carry a
 *     guard and those 2 were refused. It is latent -- the delegated route is
 *     handed `createScopedToolRegistry(BUILTIN_TOOLS)` and only a test supplies
 *     `agentScopedRegistry` -- but "empty today, measured", which this docblock
 *     used to assert, was simply false for that registry.
 *
 *     And excluding bounded names is right on the merits, not just convenient.
 *     A guard on a BOUNDED tool is about the connection and the epoch, not about
 *     actuating a reviewed surface: a bounded tool's review target is SERIALISED
 *     into the effect record and rechecked at dispatch by `validateTarget`, so it
 *     is bound by the durable mechanism rather than by a closure, which is the
 *     whole thing this function refuses the absence of.
 *
 * NOT the same refusal as `OPAQUE_TOOLS`. Opaque means "a category cannot
 * describe what this will do"; this means "what this acts on cannot be bound
 * across a waitpoint". `ui_act` is only ever the second.
 */
export function surfaceBoundRefusal(
  tool: ToolDefinition | undefined,
  toolName: string,
  params: Record<string, unknown>,
): string | null {
  const reviewedRawUi = rawUiGate(toolName, params) !== null;
  const declaresUnregisteredGuard = typeof tool?.captureApprovalGuard === 'function'
    && !REVIEWED_UI_TOOLS.has(toolName) && !BOUNDED_TOOLS.has(toolName);
  if (!reviewedRawUi && !declaresUnregisteredGuard) return null;
  return `Unsupported workflow capability: ${toolName} acts on a live UI surface, and an approval that waits on a `
    + `workflow waitpoint cannot stay bound to the screen it was reviewed against -- the browser can reconnect, `
    + `navigate or be a different machine by the time it resumes. Use a typed governed adapter whose target carries `
    + `the reviewed subject, or run it from chat where the approval is answered against the screen it names.`;
}

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

/** The capability a bounded tool needs on the machine it runs on; dispatch checks it. */
export function boundedToolCapability(tool: string): SidecarCapability {
  return tool.includes('file') || tool === 'list_directory' ? 'filesystem'
    : tool.includes('clipboard') ? 'clipboard' : tool === 'get_system_info' ? 'system_info'
    : tool === 'capture_screen' || tool === 'desktop_screenshot' ? 'screenshot'
    : tool.startsWith('browser_') ? 'browser' : 'desktop';
}

function boundedTarget(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const capability = boundedToolCapability(tool);
  const scope = getMachineScope();
  const selector = scope ? scope.resolveTarget(params.target, capability)
    : typeof params.target === 'string' && params.target.trim() ? params.target : autoTargetForCapability(capability);
  const sidecar = selector ? findSidecar(selector, getSidecarManager()?.listSidecars() ?? []) : null;
  if (selector && !sidecar && !scope) throw new Error(`Workflow target unavailable: ${selector}`);
  const path = params.path == null ? null : selector ? params.path : resolve(getDefaultCwd() || policyHome(), String(params.path));
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
