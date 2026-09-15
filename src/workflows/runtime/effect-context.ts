import { createHash } from 'node:crypto';
import { getFlowRun } from '../db/repos/flow-run';
import { getFlowVersion, type FlowTriggerNode } from '../db/repos/flow-version';

export type WorkflowEffectContext = {
  runId: string; projectId: string; sandboxId?: string;
  stepName?: string; executionPath?: Array<[string, number]>;
};
export type WorkflowApprovalPending = { effectId: string; approvalId: string; waitpointId: string };

/** Stable JSON identity, independent of object key insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function walkWorkflow(root: FlowTriggerNode): FlowTriggerNode[] {
  const out: FlowTriggerNode[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    out.push(node);
    if (node.nextAction) pending.push(node.nextAction);
    if (node.firstLoopAction) pending.push(node.firstLoopAction);
    for (const child of node.children ?? []) if (child) pending.push(child);
  }
  return out;
}

export function resolveEffectContext(ctx: WorkflowEffectContext, piece: string, action: string) {
  const run = getFlowRun(ctx.runId);
  if (!run || run.projectId !== ctx.projectId) throw new Error('Workflow effect identity does not match the run');
  if (run.status !== 'RUNNING') throw new Error(`Workflow effect blocked: run is ${run.status}`);
  const version = getFlowVersion(run.flowVersionId);
  if (!version || version.flowId !== run.flowId) throw new Error('Workflow version is unavailable');
  const nodes = walkWorkflow(version.trigger);
  const matches = nodes.filter(node => node.name === ctx.stepName);
  const node = matches[0];
  if (!ctx.stepName || matches.length !== 1 || node?.settings?.pieceName !== piece
    || node.settings.actionName !== action) throw new Error('Workflow effect step does not match the pinned version');
  if (!Array.isArray(ctx.executionPath) || ctx.executionPath.length > 32
    || ctx.executionPath.some(part => !Array.isArray(part) || part.length !== 2
      || typeof part[0] !== 'string' || !Number.isSafeInteger(part[1]) || part[1] < 0
      || !nodes.some(n => n.name === part[0] && n.type === 'LOOP_ON_ITEMS'))) {
    throw new Error('Workflow effect requires a valid runtime execution path');
  }
  return { run, version, stepName: ctx.stepName, executionPath: ctx.executionPath,
    versionDigest: digest(version.trigger) };
}
