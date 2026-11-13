import type { ToolDefinition, ToolGate } from '../../actions/tools/registry';
import type { ActionCategory } from '../../roles/authority';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import { TOOL_ACTION_MAP, severityRank, resolveToolGate } from '../../authority/tool-action-map';
import { autoTargetForCapability, findSidecar, getSidecarManager } from '../../actions/tools/sidecar-route';
import { getDefaultCwd } from '../../actions/tools/local-tools-guard';
import type { SidecarCapability } from '../../sidecar/types';
import { resolve } from 'node:path';
import { policyHome } from '../../actions/tools/file-path-policy';
import { getMachineScope } from '../../actions/machine-scope';
import { rawUiGate, REVIEWED_UI_TOOLS } from '../../authority/ui-intent';
// Target keys the boundary owns; neither a tool's gate subject nor a governed
// piece's target props can set them (`piece-effects.ts`, #793).
import { RESERVED_TARGET_KEYS } from './piece-effects';
import { BOUNDED_TOOLS, boundedToolCapability } from './tool-capability';
import { workflowUiReview, workflowToolRefusal, WORKFLOW_REVIEWED_UI_TOOLS } from './workflow-ui-tools';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { forCard } from '../../util/card-text';

/** The capability a bounded tool needs on the machine it runs on; dispatch checks it. */
export { boundedToolCapability };

// The bounded tools and their capabilities live in `tool-capability.ts`, which
// the database layer reads too (Q-05 binding pins).

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

export const BOUNDED_TOOL_NAMES: ReadonlySet<string> = BOUNDED_TOOLS;
export const OPAQUE_TOOL_NAMES: ReadonlySet<string> = OPAQUE_TOOLS;
export const GATED_TOOL_NAMES: ReadonlySet<string> = GATED_TOOLS;

/**
 * Refuse surface-bound calls unless the caller explicitly uses the live UI
 * approval path. Both direct steps and delegated agents may use that path only
 * for WORKFLOW_REVIEWED_UI_TOOLS with their actual captureApprovalGuard.
 * The durable effect stores the request and receipt, never a substitute for
 * the live guard. A restart, disconnect or changed subject blocks dispatch.
 *
 * Why the binding is live and never persisted (#638, kept condensed). An
 * approval on a SURFACE is bound by `captureApprovalGuard`: a closure over the
 * CDP connection, the approval epoch and, for an element-addressed tool, the
 * document and the id-map generation (#602). A workflow record is durable and
 * is rechecked on resume by `validateTarget`, which sees only the frozen
 * arguments and target; a closure does not cross that gap or a restart
 * (`reconcileAfterRestart` clears `uiExecutions`). Nor can the binding be made
 * durable: a target persists NAMES (a sidecar id, a path, a skill version),
 * while an element id is a process-local counter that restarts at 1 and that
 * four snapshots anywhere evict (`ui.ts`, `MAX_REMEMBERED_SNAPSHOTS`).
 * Persisting it would let a comparison PASS on a different surface, which is
 * worse than no check. The durable alternative is an adapter whose target
 * carries the reviewed SUBJECT and re-resolves it at dispatch, as `run_skill`
 * does. So this path keeps the live guard in process and refuses when it is
 * gone (WORKFLOW_UI_REVIEW_STALE).
 *
 * Two signals cover both drift directions. `rawUiGate(name, params)` is the
 * authoritative "raw UI action needing review" (its `get_value` carve-out
 * comes with it). A declared `captureApprovalGuard` on a tool in neither
 * `REVIEWED_UI_TOOLS` nor `BOUNDED_TOOLS` is a tool saying reviewing it is not
 * enough, which nobody registered: the one signal that survives a guarded tool
 * added without `ui-intent.ts`. Both exclusions carry weight: `createBrowserTools`
 * gives EVERY tool a guard, `browser_snapshot` and `browser_screenshot`
 * included, and a guard on a BOUNDED read is about the connection, its target
 * being bound by the durable `validateTarget` mechanism instead.
 *
 * NOT the same refusal as `OPAQUE_TOOLS`: opaque means a category cannot
 * describe the effect; this means what it acts on cannot be bound across a
 * waitpoint without the live guard.
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
  if (workflowUiReview(tool, tool.name, params)) {
    const gate = resolveToolGate(tool, tool.name, params);
    const capability: SidecarCapability = tool.name.startsWith('browser_') ? 'browser' : 'desktop';
    return { category: gate.actionCategory, categories: gate.categories,
      // No intent here: the card sentence is the caller's (`ui-card.ts`),
      // built with the values, the computer and the screen (#1314).
      target: (args: Record<string, unknown>): Record<string, unknown> => ({ tool: tool.name, ...pinnedSidecar(capability, args.target), capability }),
      prepareArguments: (args: Record<string, unknown>) => {
        const pinned = pinnedSidecar(capability, args.target);
        return { ...args, ...(pinned.sidecarId ? { target: pinned.sidecarId } : {}) };
      },
    };
  }
  const refusal = workflowToolRefusal(tool.name);
  if (refusal || OPAQUE_TOOLS.has(tool.name)) throw new ActionOutcomeError({ status: 'blocked',
    code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started',
    message: `WORKFLOW_TOOL_UNSUPPORTED: ${refusal ?? `${tool.name} requires a live UI approval guard that is unavailable on this Jarvis.`}` });
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

/**
 * The computer a reviewed UI call would act on, by id and name, for its card
 * (#1314): resolved the way the call's target is, so the card names the
 * machine the record is pinned to.
 */
export function uiCallComputer(toolName: string, requested: unknown): { sidecarId: string | null; name: string } {
  const capability: SidecarCapability = toolName.startsWith('browser_') ? 'browser' : 'desktop';
  const { sidecarId } = pinnedSidecar(capability, requested);
  if (sidecarId === null) return { sidecarId, name: 'this computer (the Jarvis host)' };
  const sidecar = getSidecarManager()?.listSidecars().find(s => s.id === sidecarId);
  // The name is cut, never the id that tells two similar names apart (#1314 review).
  return { sidecarId, name: sidecar ? `${forCard(sidecar.name, 80) || 'unnamed'} (${sidecarId})` : sidecarId };
}

/**
 * Why a workflow step cannot run this tool, in plain words, or null when it
 * can. The same rule `toolEffectCapability` enforces when the step runs, asked
 * early so a step that can never run is not called ready. `params` is null when
 * run data decides them: what depends on them (which skill) is then left to the run.
 * Tools the workflow UI rules refuse by name (`workflowToolRefusal`) are reported
 * by readiness from that rule, so this covers what only the call itself decides.
 */
export function workflowStepToolRefusal(tool: ToolDefinition, params: Record<string, unknown> | null): string | null {
  if (GATED_TOOLS.has(tool.name) && !tool.workflowEffect && params === null) return null;
  try { toolEffectCapability(tool, params ?? {}); return null; } catch { /* described below */ }
  if (GATED_TOOLS.has(tool.name) && !tool.workflowEffect) {
    return `${tool.name} needs the name of a skill saved on this Jarvis, and that skill was not found. Check the skill name in the step's parameters.`;
  }
  const supported = [...BOUNDED_TOOLS, ...GATED_TOOLS, ...WORKFLOW_REVIEWED_UI_TOOLS];
  // A supported tool refused for what this call asks (desktop_click reading a
  // value, say): naming it in the list of supported tools would contradict the refusal.
  if (supported.includes(tool.name)) {
    return `A workflow step cannot run ${tool.name} with these parameters, because Jarvis cannot show you beforehand what it would do. Change the step's parameters, or let an agent step do it.`;
  }
  return `A workflow step cannot run ${tool.name}, because Jarvis cannot show you beforehand what it would do. Workflow steps can use these tools: ${supported.join(', ')}.`;
}
