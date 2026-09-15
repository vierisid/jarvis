import type { WorkflowEffectContext } from '../../runtime/effect-context';
import type { RouteContext } from './shared';

/** Identity headers come from piece execution context, never propsValue. */
export function workflowEffectContext(ctx: RouteContext): WorkflowEffectContext {
  let executionPath;
  const raw = ctx.req.headers.get('x-jarvis-execution-path');
  if (raw) { try { executionPath = JSON.parse(raw); } catch { throw new Error('Invalid workflow execution path'); } }
  return { runId: ctx.claims.runId, projectId: ctx.claims.projectId, sandboxId: ctx.claims.sandboxId,
    stepName: ctx.req.headers.get('x-jarvis-step-name') ?? undefined, executionPath };
}
