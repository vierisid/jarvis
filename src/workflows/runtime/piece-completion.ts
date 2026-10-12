import { getWorkflowDb } from '../db';
import { getWorkflowEffect, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { canonicalJson, digest, type WorkflowEffectContext } from './effect-context';
import { workflowEffectId, type WorkflowAuthorityDependencies } from './effect-boundary';
import { boundedReceiptText } from '../../roles/untrusted';
import { RECEIPT_MAX_CHARS } from '../../authority/deferred-executor';
import type { ActionCategory } from '../../roles/authority';

/** Accept an in-flight completion even after Kill. It is evidence, never permission to act. */
export function recordPieceCompletion(ctx: WorkflowEffectContext, effectId: string, result: unknown, deps: WorkflowAuthorityDependencies = {}): void {
  const effect = getWorkflowDb().transaction(() => {
    const effect = getWorkflowEffect(effectId);
    if (!effect || effect.route !== 'piece-dispatch' || effect.runId !== ctx.runId || effect.projectId !== ctx.projectId
      || effect.id !== workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], 'piece-dispatch')) {
      throw new Error('Provider receipt identity does not match the dispatch');
    }
    if (effect.status === 'succeeded') {
      if (digest(effect.result) !== digest(result)) throw new Error('Conflicting provider receipt');
      return effect;
    }
    if (effect.status !== 'dispatching') throw new Error('Provider dispatch is not awaiting a receipt');
    effect.status = 'succeeded'; effect.result = result; effect.finishedAt = Date.now();
    saveWorkflowEffect(effect);
    return effect;
  })();
  // Secondary receipts cannot erase the primary completion or reopen dispatch.
  try {
    if (effect.approvalId) deps.approvalManager?.markExecuted(effect.approvalId,
      boundedReceiptText(canonicalJson({ effectId, result }), RECEIPT_MAX_CHARS));
    deps.auditTrail?.log({ agent_id: `workflow:${effect.runId}`, agent_name: `Workflow receipt ${effect.id}`,
      tool_name: effect.toolName, action_category: effect.actionCategory as ActionCategory,
      authority_decision: effect.approvalId ? 'approval_required' : 'allowed', approval_id: effect.approvalId, executed: true });
  } catch (error) { console.error('[Workflow receipt] secondary audit failed:', error); }
}
