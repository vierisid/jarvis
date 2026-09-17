import type { AuthorityEngine, AuthorityProfile } from '../../authority/engine';
import type { AuditTrail } from '../../authority/audit';
import type { EmergencyController } from '../../authority/emergency';
import type { ApprovalManager, ApprovalRequest } from '../../authority/approval';
import type { ActionCategory } from '../../roles/authority';
import { getWorkflowDb } from '../db';
import { assertRunNotCanceled } from './cancellation';
import { withExecutionScope } from '../../actions/execution-scope';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { getFlowRun } from '../db/repos/flow-run';
import { createWaitpoint } from '../db/repos/waitpoint';
import { claimWorkflowEffect, getWorkflowEffect, saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { canonicalJson, digest, resolveEffectContext, type WorkflowApprovalPending, type WorkflowEffectContext } from './effect-context';

export interface WorkflowAuthorityDependencies {
  authorityEngine?: AuthorityEngine; auditTrail?: AuditTrail; emergencyController?: EmergencyController;
  approvalManager?: ApprovalManager;
  onWorkflowApproval?: (request: ApprovalRequest) => void | Promise<void>;
}
/**
 * Who an effect is dispatched for when it is not the workflow itself. A
 * delegated sub-agent's gate judged the call with this identity; the boundary
 * judges it again with the same one, never with a looser one.
 */
export type EffectPrincipal = {
  agentId: string; agentRoleId: string; agentAuthorityLevel: number; profile?: AuthorityProfile | null;
};
export interface EffectInvocation {
  context: WorkflowEffectContext; piece: string; action: string; route: string;
  toolName: string; category: ActionCategory; toolCategory: string;
  request: Record<string, unknown>;
  prepare: () => { arguments: Record<string, unknown>; target: Record<string, unknown> };
  validateTarget?: (args: Record<string, unknown>, target: Record<string, unknown>) => void;
  execute: (args: Record<string, unknown>, checkpoint: () => void) => Promise<unknown>;
  principal?: EffectPrincipal;
  /** The caller's gate already found this effect needs approval; the boundary never concludes otherwise. */
  approvalRequired?: boolean;
}
export type EffectReply = { result: unknown; approval?: never } | { approval: WorkflowApprovalPending; result?: never };

/** The durable identity of an effect: one per run, step, loop position and route. */
export const workflowEffectId = (runId: string, stepName: string, executionPath: Array<[string, number]>, route: string) =>
  'wfe_' + digest([runId, stepName, executionPath, route]);

/** The daemon owns policy, frozen arguments, approvals and the dispatch fence. */
export class WorkflowEffectBoundary {
  constructor(private readonly deps: WorkflowAuthorityDependencies) {}

  /**
   * Record a capability we refused before an effect record could exist. A tool
   * with no bounded Authority action never reaches `invoke`, and a refusal is
   * exactly the event an operator needs in the audit trail, so log it here.
   * Best effort: the refusal itself is raised by the caller either way.
   */
  auditRefusal(input: { context: WorkflowEffectContext; toolName: string; category: ActionCategory }): void {
    try {
      // The step name is engine-supplied provenance and is not validated on this
      // path, so it is bounded before it reaches the audit row.
      const step = (input.context.stepName ?? 'unknown step').slice(0, 120);
      this.deps.auditTrail?.log({ agent_id: `workflow:${input.context.runId}`,
        agent_name: `Workflow ${input.context.runId} / ${step}`,
        tool_name: input.toolName, action_category: input.category,
        authority_decision: 'denied', approval_id: null, executed: false });
    } catch (error) { console.error('[Workflow Authority] refusal audit failed:', error); }
  }

  async invoke(input: EffectInvocation): Promise<EffectReply> {
    const { authorityEngine: authority, emergencyController: emergency, auditTrail: audit, approvalManager: approvals } = this.deps;
    if (!authority || !emergency || !audit) throw new Error('Workflow Authority is unavailable; execution denied');
    const resolved = resolveEffectContext(input.context, input.piece, input.action);
    const id = workflowEffectId(resolved.run.id, resolved.stepName, resolved.executionPath, input.route);
    let effect = getWorkflowEffect(id);
    if (effect && (effect.requestDigest !== digest(input.request) || effect.versionDigest !== resolved.versionDigest
      || effect.toolName !== input.toolName || effect.actionCategory !== input.category)) {
      throw new Error('Workflow effect changed since it was recorded; start a new run for new arguments or version');
    }
    if (effect?.status === 'succeeded') return { result: effect.result };
    if (effect?.outcome && effect.outcome.status !== 'succeeded') throw new ActionOutcomeError(effect.outcome);
    if (effect?.status === 'dispatching') throw new Error('Workflow effect outcome is uncertain or still in flight; automatic replay is blocked');
    if (effect && effect.status !== 'pending') throw new Error(effect.error ?? `Workflow effect is ${effect.status}`);
    if (!effect) {
      const prepared = JSON.parse(canonicalJson(input.prepare()));
      effect = { id, runId: resolved.run.id, projectId: resolved.run.projectId, flowId: resolved.run.flowId,
        versionId: resolved.version.id, versionDigest: resolved.versionDigest, stepName: resolved.stepName,
        executionPath: resolved.executionPath, route: input.route, toolName: input.toolName,
        actionCategory: input.category, requestDigest: digest(input.request), ...prepared,
        provenance: { source: 'workflow-runtime', sandboxId: input.context.sandboxId ?? null,
          machineBindingVersion: 1,
          triggeredBy: resolved.run.triggeredBy, environment: resolved.run.environment,
          piece: input.piece, action: input.action },
        decision: 'unresolved', reason: '', status: 'pending', approvalId: null, waitpointId: null, createdAt: Date.now() };
      saveWorkflowEffect(effect!);
    }
    const record = effect!;
    // The trail names who was judged: the workflow itself, or the sub-agent a
    // delegated call was judged as.
    const judged = input.principal ? ` / as ${input.principal.agentRoleId} (level ${input.principal.agentAuthorityLevel})` : '';
    const log = (executed: boolean) => audit.log({ agent_id: `workflow:${record.runId}`,
      agent_name: `Workflow ${resolved.version.displayName} / ${record.stepName} / ${record.id}${judged}`,
      tool_name: record.toolName, action_category: input.category,
      authority_decision: record.decision === 'denied' ? 'denied' : record.approvalId ? 'approval_required' : 'allowed',
      approval_id: record.approvalId, executed });
    const policy = () => {
      const state = emergency.getState();
      const configuredState = authority.getConfig().emergency_state;
      if (state !== 'normal' || configuredState !== 'normal') throw new Error(`Workflow effect blocked: system ${state !== 'normal' ? state : configuredState}`);
      const run = getFlowRun(record.runId);
      if (!run || run.status !== 'RUNNING') throw new Error(`Workflow effect blocked: run is ${run?.status ?? 'missing'}`);
      // Cancellation has one fence, owned by `runtime/cancellation`. Defer to it
      // rather than reading job rows here, so the boundary and the daemon's
      // other dispatch points can never disagree about whether a run is dead.
      assertRunNotCanceled(record.runId);
      const who = input.principal ?? { agentId: `workflow:${record.runId}`, agentRoleId: 'workflow-default', agentAuthorityLevel: 0, profile: null };
      const decision = authority.checkAuthority({ agentId: who.agentId, agentRoleId: who.agentRoleId,
        agentAuthorityLevel: who.agentAuthorityLevel, toolName: input.toolName, toolCategory: input.toolCategory,
        actionCategory: input.category, temporaryGrants: new Map(), profile: who.profile ?? null });
      if (!decision.allowed) throw new Error(`Authority denied ${input.toolName}: ${decision.reason}`);
      // A gate that already required approval for this principal is never
      // overruled by a recomputation here that happens to be looser.
      if (input.approvalRequired && !decision.requiresApproval) {
        return { ...decision, requiresApproval: true, reason: `${decision.reason}; approval required by the calling gate` };
      }
      return decision;
    };
    let decision;
    try { decision = policy(); } catch (error) {
      record.status = 'blocked'; record.decision = 'denied'; record.error = String((error as Error).message);
      record.reason = record.error; record.finishedAt = Date.now(); saveWorkflowEffect(record); log(false); throw error;
    }
    record.reason = decision.reason;
    if (record.approvalId || decision.requiresApproval) {
      if (!approvals) throw new Error('Workflow approval service unavailable; execution denied');
      if (!record.approvalId) {
        let request!: ApprovalRequest;
        getWorkflowDb().transaction(() => {
          request = approvals.createRequest({ agentId: `workflow:${record.runId}`,
            agentName: `Workflow: ${resolved.version.displayName}${input.principal ? ` as ${input.principal.agentRoleId}` : ''}`,
            toolName: input.toolName, toolArguments: record.arguments, actionCategory: input.category,
            urgency: 'normal', reason: decision.reason,
            context: canonicalJson({ effectId: id, runId: record.runId, versionId: record.versionId,
              stepName: record.stepName, executionPath: record.executionPath, target: record.target }), executionMode: 'workflow' });
          record.approvalId = request.id;
          record.waitpointId = createWaitpoint({ flowRunId: record.runId, projectId: record.projectId,
            stepName: record.stepName, type: 'MANUAL' }).id;
          record.decision = 'approval_required'; saveWorkflowEffect(record); log(false);
        })();
        // Delivery is retriable by the existing pending-request surfaces. Do
        // not keep a database transaction open across external notification.
        try { await this.deps.onWorkflowApproval?.(request); } catch (error) { console.error('[Workflow Authority] approval delivery failed:', error); }
        // Delivery yields to other callers. An approved duplicate may already
        // have claimed or completed this effect; never overwrite its outcome
        // with the pre-delivery pending snapshot.
        const latest = getWorkflowEffect(id);
        if (latest?.status === 'succeeded') return { result: latest.result };
        if (latest?.outcome && latest.outcome.status !== 'succeeded') throw new ActionOutcomeError(latest.outcome);
        if (latest?.status === 'dispatching') throw new Error('Workflow effect outcome is uncertain or still in flight; automatic replay is blocked');
        if (!latest || latest.status !== 'pending') throw new Error(latest?.error ?? 'Workflow effect is no longer pending');
      }
      const approval = approvals.getRequest(record.approvalId!);
      if (!approval || approval.execution_mode !== 'workflow' || digest(JSON.parse(approval.tool_arguments)) !== digest(record.arguments)) {
        throw new Error('Workflow approval does not match the recorded effect');
      }
      if (approval.status === 'pending') return { approval: { effectId: id, approvalId: approval.id, waitpointId: record.waitpointId! } };
      if (approval.status !== 'approved') {
        record.decision = 'denied';
        record.status = 'blocked'; record.error = `Workflow approval ${approval.status}; effect was not executed`;
        record.finishedAt = Date.now(); saveWorkflowEffect(record); log(false); throw new Error(record.error);
      }
    } else { record.decision = 'allowed'; }
    // Recheck after delivery/approval and immediately before the synchronous
    // dispatch claim. No await separates this gate from the effect callback.
    const checkpoint = () => {
      input.validateTarget?.(record.arguments, record.target);
      const latest = resolveEffectContext(input.context, input.piece, input.action);
      if (latest.versionDigest !== record.versionDigest) throw new Error('Workflow version changed before dispatch');
      const current = policy();
      if (record.approvalId && approvals?.getRequest(record.approvalId)?.status !== 'approved') {
        throw new Error('Workflow approval is no longer approved; dispatch blocked');
      }
      if (current.requiresApproval && !record.approvalId) throw new Error('Workflow Authority now requires approval; effect was not dispatched');
    };
    try { checkpoint(); } catch (error) {
      // A rejected target/session has not reached the dispatch claim. Preserve
      // that fact separately from uncertainty about already-started effects.
      if (error instanceof ActionOutcomeError) {
        record.outcome = error.outcome; record.status = 'blocked'; record.error = error.message;
        record.finishedAt = Date.now(); saveWorkflowEffect(record); log(false);
      }
      throw error;
    }
    if (!claimWorkflowEffect(record)) throw new Error('Workflow effect was already claimed; replay blocked');
    try {
      // Publish the same checkpoint into the ambient execution scope. Deep
      // dispatch points (TTS chunks, channel adapters) call
      // `checkpointExecution()` for cancellation; inside a governed effect that
      // has to mean Authority and emergency state as well. Scopes compose, so
      // this adds to the run's cancellation fence rather than replacing it.
      const result = await withExecutionScope(checkpoint,
        () => input.execute(JSON.parse(canonicalJson(record.arguments)), checkpoint));
      record.result = result ?? null; record.status = 'succeeded'; record.finishedAt = Date.now();
      saveWorkflowEffect(record);
      if (record.approvalId) approvals!.markExecuted(record.approvalId, canonicalJson({ effectId: id, result: record.result }).slice(0, 2000));
      log(true);
      return { result: record.result };
    } catch (error) {
      if (error instanceof ActionOutcomeError) {
        record.outcome = error.outcome;
        record.status = error.outcome.status === 'error' ? 'failed' : error.outcome.status;
        record.error = error.message;
      } else {
        record.status = 'failed'; record.error = `Effect dispatch failed; partial effects may have occurred: ${(error as Error).message}`;
      }
      record.finishedAt = Date.now(); saveWorkflowEffect(record);
      // Completion was not established. The durable record retains the
      // possibility that a remote effect happened before the failure.
      log(false);
      throw error;
    }
  }
}
