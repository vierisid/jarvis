import type { AuthorityEngine } from '../../authority/engine';
import type { AuditTrail } from '../../authority/audit';
import type { EmergencyController } from '../../authority/emergency';
import type { ApprovalManager, ApprovalRequest } from '../../authority/approval';
import type { ActionCategory } from '../../roles/authority';
import { getWorkflowDb } from '../db';
import { getFlowRun } from '../db/repos/flow-run';
import { createWaitpoint } from '../db/repos/waitpoint';
import { claimWorkflowEffect, getWorkflowEffect, saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { canonicalJson, digest, resolveEffectContext, type WorkflowApprovalPending, type WorkflowEffectContext } from './effect-context';

export interface WorkflowAuthorityDependencies {
  authorityEngine?: AuthorityEngine; auditTrail?: AuditTrail; emergencyController?: EmergencyController;
  approvalManager?: ApprovalManager;
  onWorkflowApproval?: (request: ApprovalRequest) => void | Promise<void>;
}
export interface EffectInvocation {
  context: WorkflowEffectContext; piece: string; action: string; route: string;
  toolName: string; category: ActionCategory; toolCategory: string;
  request: Record<string, unknown>;
  prepare: () => { arguments: Record<string, unknown>; target: Record<string, unknown> };
  validateTarget?: (args: Record<string, unknown>, target: Record<string, unknown>) => void;
  execute: (args: Record<string, unknown>, checkpoint: () => void) => Promise<unknown>;
}
export type EffectReply = { result: unknown; approval?: never } | { approval: WorkflowApprovalPending; result?: never };

/** The daemon owns policy, frozen arguments, approvals and the dispatch fence. */
export class WorkflowEffectBoundary {
  constructor(private readonly deps: WorkflowAuthorityDependencies) {}

  async invoke(input: EffectInvocation): Promise<EffectReply> {
    const { authorityEngine: authority, emergencyController: emergency, auditTrail: audit, approvalManager: approvals } = this.deps;
    if (!authority || !emergency || !audit) throw new Error('Workflow Authority is unavailable; execution denied');
    const resolved = resolveEffectContext(input.context, input.piece, input.action);
    const id = 'wfe_' + digest([resolved.run.id, resolved.stepName, resolved.executionPath, input.route]);
    let effect = getWorkflowEffect(id);
    if (effect && (effect.requestDigest !== digest(input.request) || effect.versionDigest !== resolved.versionDigest
      || effect.toolName !== input.toolName || effect.actionCategory !== input.category)) {
      throw new Error('Workflow effect changed since it was recorded; start a new run for new arguments or version');
    }
    if (effect?.status === 'succeeded') return { result: effect.result };
    if (effect?.status === 'dispatching') throw new Error('Workflow effect outcome is uncertain or still in flight; automatic replay is blocked');
    if (effect && effect.status !== 'pending') throw new Error(effect.error ?? `Workflow effect is ${effect.status}`);
    if (!effect) {
      const prepared = JSON.parse(canonicalJson(input.prepare()));
      effect = { id, runId: resolved.run.id, projectId: resolved.run.projectId, flowId: resolved.run.flowId,
        versionId: resolved.version.id, versionDigest: resolved.versionDigest, stepName: resolved.stepName,
        executionPath: resolved.executionPath, route: input.route, toolName: input.toolName,
        actionCategory: input.category, requestDigest: digest(input.request), ...prepared,
        provenance: { source: 'workflow-runtime', sandboxId: input.context.sandboxId ?? null,
          triggeredBy: resolved.run.triggeredBy, environment: resolved.run.environment,
          piece: input.piece, action: input.action },
        decision: 'unresolved', reason: '', status: 'pending', approvalId: null, waitpointId: null, createdAt: Date.now() };
      saveWorkflowEffect(effect!);
    }
    const record = effect!;
    const log = (executed: boolean) => audit.log({ agent_id: `workflow:${record.runId}`,
      agent_name: `Workflow ${resolved.version.displayName} / ${record.stepName} / ${record.id}`,
      tool_name: record.toolName, action_category: input.category,
      authority_decision: record.decision === 'denied' ? 'denied' : record.approvalId ? 'approval_required' : 'allowed',
      approval_id: record.approvalId, executed });
    const policy = () => {
      const state = emergency.getState();
      const configuredState = authority.getConfig().emergency_state;
      if (state !== 'normal' || configuredState !== 'normal') throw new Error(`Workflow effect blocked: system ${state !== 'normal' ? state : configuredState}`);
      const run = getFlowRun(record.runId);
      if (!run || run.status !== 'RUNNING') throw new Error(`Workflow effect blocked: run is ${run?.status ?? 'missing'}`);
      // A canceled job can precede the run-status update. W5 can extend this
      // boundary with in-flight cancellation without weakening this check.
      const canceled = getWorkflowDb().query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status='CANCELED' LIMIT 1").get(record.runId);
      if (canceled) throw new Error('Workflow effect blocked: run job was canceled');
      const decision = authority.checkAuthority({ agentId: `workflow:${record.runId}`, agentRoleId: 'workflow-default',
        agentAuthorityLevel: 0, toolName: input.toolName, toolCategory: input.toolCategory,
        actionCategory: input.category, temporaryGrants: new Map() });
      if (!decision.allowed) throw new Error(`Authority denied ${input.toolName}: ${decision.reason}`);
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
          request = approvals.createRequest({ agentId: `workflow:${record.runId}`, agentName: `Workflow: ${resolved.version.displayName}`,
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
    checkpoint();
    if (!claimWorkflowEffect(record)) throw new Error('Workflow effect was already claimed; replay blocked');
    try {
      const result = await input.execute(JSON.parse(canonicalJson(record.arguments)), checkpoint);
      record.result = result ?? null; record.status = 'succeeded'; record.finishedAt = Date.now();
      saveWorkflowEffect(record);
      if (record.approvalId) approvals!.markExecuted(record.approvalId, canonicalJson({ effectId: id, result: record.result }).slice(0, 2000));
      log(true);
      return { result: record.result };
    } catch (error) {
      record.status = 'failed'; record.error = `Effect dispatch failed; partial effects may have occurred: ${(error as Error).message}`;
      record.finishedAt = Date.now(); saveWorkflowEffect(record);
      // Completion was not established. The durable record retains the
      // possibility that a remote effect happened before the failure.
      log(false);
      throw error;
    }
  }
}
