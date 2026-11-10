import { createHash } from 'node:crypto';
import { getWorkflowDb } from '../db';
import { getFlowRun, type RunExecutionConfig } from '../db/repos/flow-run';
import { getFlowVersion } from '../db/repos/flow-version';
import { walkFlowNodes } from '../db/flow-graph';
import { ActionOutcomeError } from '../../actions/action-outcome';

/** A pinned step input the graph templates: run data would pick it (#1152). */
export const STEP_INPUT_NOT_FIXED = 'WORKFLOW_STEP_INPUT_NOT_FIXED';

export type WorkflowEffectContext = {
  runId: string; projectId: string; sandboxId?: string;
  stepName?: string; executionPath?: Array<[string, number]>;
};
export type WorkflowApprovalPending = {
  effectId: string; approvalId: string; waitpointId: string;
  /**
   * Set when the step is held with no card: because Jarvis is paused (Q-08),
   * and Resume releases it; or, with `code`, because its flow's card budget is
   * full (#1039), and a place freeing releases it. Says why, for the run.
   */
  hold?: string;
  /** Why the step waits when it is not a pause: its flow's cards are at the budget (#1039). Never a failure. */
  code?: 'APPROVALS_WAITING';
};

/** Stable JSON identity, independent of object key insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * `pinned` names step inputs the call must match: the graph must state each
 * one literally, and the call must ask for exactly that (#1152). A
 * jarvis-tool step's `toolName` is one: piece and action alone would let a
 * call naming that step run any registered tool. A templated one (`{{...}}`)
 * would let run data, a webhook body say, pick it, so it is refused, typed
 * and before anything starts (owner, 2026-11-05); readiness refuses it too.
 * A step test reads the input the engine runs it with: the run's frozen
 * preview override for that step when it has one, as readiness does.
 */
/** The input a step runs with: a step test's frozen override replaces the saved one whole, as in the engine. */
function effectiveStepInput(runId: string, stepName: string, saved: unknown): unknown {
  const row = getWorkflowDb().query<{ execution_config: string | null }, [string]>(
    'SELECT execution_config FROM flow_run WHERE id = ?').get(runId);
  let overrides: RunExecutionConfig['sampleInputOverride'];
  try { overrides = row?.execution_config ? (JSON.parse(row.execution_config) as RunExecutionConfig).sampleInputOverride : undefined; }
  catch { overrides = undefined; }
  return overrides && Object.hasOwn(overrides, stepName) ? overrides[stepName] : saved;
}

export function resolveEffectContext(ctx: WorkflowEffectContext, piece: string, action: string,
  pinned?: Record<string, string>) {
  const run = getFlowRun(ctx.runId);
  if (!run || run.projectId !== ctx.projectId) throw new Error('Workflow effect identity does not match the run');
  if (run.status !== 'RUNNING') throw new Error(`Workflow effect blocked: run is ${run.status}`);
  const version = getFlowVersion(run.flowVersionId);
  if (!version || version.flowId !== run.flowId) throw new Error('Workflow version is unavailable');
  const nodes = walkFlowNodes(version.trigger);
  const matches = nodes.filter(node => node.name === ctx.stepName);
  const node = matches[0];
  if (!ctx.stepName || matches.length !== 1 || node?.settings?.pieceName !== piece
    || node.settings.actionName !== action) throw new Error('Workflow effect step does not match the pinned version');
  const input = pinned ? effectiveStepInput(ctx.runId, ctx.stepName, node.settings.input) : undefined;
  for (const [key, value] of Object.entries(pinned ?? {})) {
    const stated = (input as Record<string, unknown> | undefined)?.[key];
    if (typeof stated === 'string' && stated.includes('{{')) {
      throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_NOT_FIXED, effect: 'not_started',
        message: `This step's ${key} is a template, so run data would choose it. Name it directly in the workflow.` });
    }
    if (stated !== value) throw new Error(`Workflow effect does not match its step: the step's ${key} is not the one this call asks for`);
  }
  if (!Array.isArray(ctx.executionPath) || ctx.executionPath.length > 32
    || ctx.executionPath.some(part => !Array.isArray(part) || part.length !== 2
      || typeof part[0] !== 'string' || !Number.isSafeInteger(part[1]) || part[1] < 0
      || !nodes.some(n => n.name === part[0] && n.type === 'LOOP_ON_ITEMS'))) {
    throw new Error('Workflow effect requires a valid runtime execution path');
  }
  return { run, version, stepName: ctx.stepName, executionPath: ctx.executionPath,
    versionDigest: digest(version.trigger) };
}

/** A step's literal params differ from the call that names the step (#1314). */
export const STEP_INPUT_MISMATCH = 'WORKFLOW_STEP_INPUT_MISMATCH';

/**
 * Whether `value` is `stated` with each `{{...}}` replaced by some text: the
 * first literal a prefix, the last a suffix, the rest found in order. Linear,
 * with no regex built from either string.
 */
function keepsLiteralText(stated: string, value: string): boolean {
  const parts = stated.split(/\{\{[^]*?\}\}/);
  if (parts.length === 1) return value === stated;
  const first = parts[0]!, last = parts[parts.length - 1]!;
  if (!value.startsWith(first) || value.length < first.length + last.length || !value.endsWith(last)) return false;
  let at = first.length;
  const end = value.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = value.indexOf(middle, at);
    if (found < 0 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}

const templated = (value: unknown): boolean => typeof value === 'string' ? value.includes('{{')
  : Array.isArray(value) ? value.some(templated)
  : !!value && typeof value === 'object' && Object.values(value).some(templated);

/**
 * Hold a call to the params its step states (#1314). The tool route trusts
 * the step-name header, and anything holding the run's sandbox token can set
 * it, so a call naming a reviewed UI step could otherwise raise a card with
 * params of its own choosing. Each param the graph states literally must be
 * sent exactly; a param the graph does not name must not be sent at all; a
 * templated param is the run data's to choose and is returned, so the card
 * can mark it. Params templated as a whole, and any key in `fixed` that is
 * templated, are refused typed: run data would choose them.
 */
export function pinnedStepParams(ctx: WorkflowEffectContext, params: Record<string, unknown>,
  fixed: readonly string[] = []): Set<string> {
  const run = getFlowRun(ctx.runId);
  const version = run ? getFlowVersion(run.flowVersionId) : null;
  const node = version ? walkFlowNodes(version.trigger).filter(n => n.name === ctx.stepName) : [];
  if (!ctx.stepName || node.length !== 1) throw new Error('Workflow effect step does not match the pinned version');
  const input = effectiveStepInput(ctx.runId, ctx.stepName, node[0]!.settings?.input) as Record<string, unknown> | undefined;
  let stated: unknown = input?.params ?? {};
  if (typeof stated === 'string') {
    try { stated = JSON.parse(stated); } catch { stated = undefined; }
  }
  if (!stated || typeof stated !== 'object' || Array.isArray(stated)) {
    throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_NOT_FIXED, effect: 'not_started',
      message: "This step's params are a template as a whole, so run data would choose them. Name each param directly in the workflow." });
  }
  const graph = stated as Record<string, unknown>;
  const fromRunData = new Set<string>();
  for (const key of new Set([...Object.keys(graph), ...Object.keys(params)])) {
    if (!Object.hasOwn(graph, key)) {
      throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_MISMATCH, effect: 'not_started',
        message: `This call sends a param, ${JSON.stringify(key.slice(0, 64))}, that its step does not state. Nothing was done.` });
    }
    if (templated(graph[key])) {
      if (fixed.includes(key)) {
        throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_NOT_FIXED, effect: 'not_started',
          message: `This step's ${key} is a template, so run data would choose it. Name it directly in the workflow.` });
      }
      // The text the author wrote around a template is still theirs: a call
      // must keep it (#1314 review), so `https://intranet/?q={{x}}` cannot
      // arrive as `https://anywhere`.
      const written = graph[key];
      // A value that is one template and nothing else may resolve to any type.
      const literal = typeof written === 'string' ? written.split(/\{\{[^]*?\}\}/) : [];
      if (typeof written === 'string' && !(literal.length === 2 && literal.every(part => part === ''))
        && (typeof params[key] !== 'string' || !keepsLiteralText(written, params[key] as string))) {
        throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_MISMATCH, effect: 'not_started',
          message: `This call's ${JSON.stringify(key.slice(0, 64))} does not keep the text its step states around its template. Nothing was done.` });
      }
      fromRunData.add(key);
    } else if (canonicalJson(graph[key]) !== canonicalJson(params[key])) {
      throw new ActionOutcomeError({ status: 'blocked', code: STEP_INPUT_MISMATCH, effect: 'not_started',
        message: `This call's ${JSON.stringify(key.slice(0, 64))} is not the value its step states. Nothing was done.` });
    }
  }
  return fromRunData;
}

/** Whether the step writes its `target` literally, not as a template (#1314 review). */
export function stepTargetIsLiteral(ctx: WorkflowEffectContext, requested: unknown): boolean {
  const run = getFlowRun(ctx.runId);
  const version = run ? getFlowVersion(run.flowVersionId) : null;
  const node = version && ctx.stepName ? walkFlowNodes(version.trigger).filter(n => n.name === ctx.stepName) : [];
  if (node.length !== 1) return false;
  const input = effectiveStepInput(ctx.runId, ctx.stepName!, node[0]!.settings?.input) as Record<string, unknown> | undefined;
  let params: unknown = input?.params;
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { return false; } }
  const target = params && typeof params === 'object' ? (params as Record<string, unknown>).target : undefined;
  // The call must ask for exactly the computer the step writes (#1314 review):
  // the route trusts the step-name header, so a target sent alongside is not
  // the step's unless it is the same one.
  return typeof target === 'string' && target.trim() !== '' && !templated(target) && requested === target;
}
