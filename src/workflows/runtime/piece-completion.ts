import { getWorkflowDb } from '../db';
import { getWorkflowEffect, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { canonicalJson, digest, type WorkflowEffectContext } from './effect-context';
import { NOT_SENT_PIECES } from './piece-effects';
import { closeEffectApproval, workflowEffectId, type WorkflowAuthorityDependencies } from './effect-boundary';
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
      authority_decision: effect.approvalId ? 'approval_required' : 'allowed', approval_id: effect.approvalId, executed: true,
      effect_id: effect.id, outcome: 'succeeded' });
  } catch (error) { console.error('[Workflow receipt] secondary audit failed:', error); }
}

/**
 * A tracked send the engine's egress guard refused before the request went
 * out (#1153): recorded as blocked and not started, as any refusal before
 * dispatch is, instead of being left `dispatching` and read as uncertain.
 * Only from `dispatching`; a recorded completion is never undone by it.
 */
export function recordPieceNotSent(ctx: WorkflowEffectContext, effectId: string, message: string, deps: WorkflowAuthorityDependencies = {}): void {
  const effect = getWorkflowDb().transaction(() => {
    const effect = getWorkflowEffect(effectId);
    if (!effect || effect.route !== 'piece-dispatch' || effect.runId !== ctx.runId || effect.projectId !== ctx.projectId
      || effect.id !== workflowEffectId(ctx.runId, ctx.stepName!, ctx.executionPath ?? [], 'piece-dispatch')) {
      throw new Error('Provider receipt identity does not match the dispatch');
    }
    if (effect.status !== 'dispatching') throw new Error('Provider dispatch is not awaiting a receipt');
    if (!NOT_SENT_PIECES.has(String(effect.provenance?.piece))) throw new Error('A not-sent receipt applies only to a piece whose refusals come before sending');
    const text = `Not sent: ${message}`;
    effect.status = 'blocked'; effect.error = text; effect.finishedAt = Date.now();
    effect.outcome = { status: 'blocked', code: 'EGRESS_REFUSED', message: text, effect: 'not_started' };
    saveWorkflowEffect(effect);
    return effect;
  })();
  try {
    closeEffectApproval(deps.approvalManager, effect, 'blocked');
    deps.auditTrail?.log({ agent_id: `workflow:${effect.runId}`, agent_name: `Workflow receipt ${effect.id}`,
      tool_name: effect.toolName, action_category: effect.actionCategory as ActionCategory,
      authority_decision: effect.approvalId ? 'approval_required' : 'allowed', approval_id: effect.approvalId, executed: false,
      effect_id: effect.id, outcome: 'not_started' });
  } catch (error) { console.error('[Workflow receipt] secondary audit failed:', error); }
}
