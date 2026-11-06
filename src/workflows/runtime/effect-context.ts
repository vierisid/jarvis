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
