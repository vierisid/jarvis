/**
 * Deferred Executor — Runs approved tool calls that were waiting for approval.
 */

import type { ToolRegistry } from '../actions/tools/registry.ts';
import { executionState, approvalNeedsClick, type ApprovalManager, type ApprovalRequest } from './approval.ts';
import { resolveToolGate } from './tool-action-map';
import { rawUiGate } from './ui-intent';
import type { AuditTrail } from './audit.ts';
import type { AuthorityLearner } from './learning.ts';
import type { EmergencyController } from './emergency.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { TAINT_PROFILE_LABEL } from './taint-gating.ts';

/**
 * The phrase in the reason of an approval that was SUBSTITUTED for a level
 * denial (`confirm: 'above_level'`), rather than requested on its own merits.
 *
 * Exported and interpolated by the one place that writes it, the substitution
 * in `AgentOrchestrator.executeToolInner`, so the producer and the consumer
 * cannot drift. Matched as a substring, the same way TAINT_PROFILE_LABEL is
 * above it.
 */
export const ABOVE_LEVEL_SUBSTITUTION = "is above this agent's authority level";

export type ExecutionResultCallback = (requestId: string, request: ApprovalRequest, result: string) => void;

export class DeferredExecutor {
  private toolRegistry: ToolRegistry | null = null;
  private approvalManager: ApprovalManager;
  private auditTrail: AuditTrail;
  private learner: AuthorityLearner | null = null;
  private emergencyController: EmergencyController | null = null;
  private onResult: ExecutionResultCallback | null = null;

  constructor(approvalManager: ApprovalManager, auditTrail: AuditTrail) {
    this.approvalManager = approvalManager;
    this.auditTrail = auditTrail;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  setLearner(learner: AuthorityLearner): void {
    this.learner = learner;
  }

  setEmergencyController(controller: EmergencyController): void {
    this.emergencyController = controller;
  }

  setResultCallback(cb: ExecutionResultCallback): void {
    this.onResult = cb;
  }

  /**
   * Execute a previously approved request. `claimedBy` names the surface
   * that runs it (dashboard, voice, inline gate) and lands in the claim.
   * The string is what the conversation or the channel shows the user.
   */
  async executeApproved(requestId: string, claimedBy = 'deferred-executor'): Promise<string> {
    return (await this.executeApprovedWithReceipt(requestId, claimedBy)).result;
  }

  /**
   * The same execution, reporting whether this call held the claim. A caller
   * that must not report a lost claim as a run (the execute route) reads
   * `claimed`; `result` is the receipt text, or why nothing ran.
   */
  async executeApprovedWithReceipt(requestId: string, claimedBy = 'deferred-executor'): Promise<{ claimed: boolean; result: string }> {
    const request = this.approvalManager.getRequest(requestId);
    if (!request || request.status !== 'approved') {
      return { claimed: false, result: `Error: Request ${requestId} not found or not in approved state` };
    }

    if (request.execution_mode === 'workflow') {
      return { claimed: false, result: 'Workflow-owned approval: execution must resume through its recorded effect boundary' };
    }

    if (!this.toolRegistry) {
      return { claimed: false, result: 'Error: No tool registry configured' };
    }

    // One executor per approval. A second caller, or a daemon restarted after
    // the claim, cannot dispatch the same approved action again; the receipt
    // or the reconciled state says what became of the first attempt.
    if (!this.approvalManager.claimExecution(requestId, claimedBy)) {
      const current = this.approvalManager.getRequest(requestId);
      return { claimed: false, result: `Error: Request ${requestId} was already taken for execution (${current ? executionState(current) : 'missing'}); check its receipt before deciding on another run` };
    }

    // Emergency gate: an approval clicked while the system is paused/killed
    // must not execute. Close the request out (mirroring the error path)
    // so it doesn't linger as an approved-but-never-executed zombie.
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      const blocked = `[SYSTEM ${state.toUpperCase()}] Approved action ${request.tool_name} was NOT executed: all tool execution is suspended because the user has ${state} the system.`;
      this.approvalManager.markExecuted(requestId, blocked, 'blocked');
      this.onResult?.(requestId, request, blocked);
      return { claimed: true, result: blocked };
    }

    const startTime = Date.now();

    try {
      const args = JSON.parse(request.tool_arguments);
      const uiCall = rawUiGate(request.tool_name, args);
      const registry = uiCall ? this.approvalManager.getUiExecutionRegistry(request) : this.toolRegistry;
      const gate = resolveToolGate(registry?.get(request.tool_name), request.tool_name, args);
      if (gate.confirm === 'always' && !approvalNeedsClick(request)) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: this approval predates the required UI review. Request a fresh dashboard review.`;
        this.approvalManager.markExecuted(requestId, blocked, 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      if (!registry) {
        const blocked = `Approved action ${request.tool_name} was NOT executed: its original UI session or reviewed subject is no longer available. Take a fresh snapshot and request a fresh review.`;
        this.approvalManager.markExecuted(requestId, blocked, 'blocked');
        this.onResult?.(requestId, request, blocked);
        return { claimed: true, result: blocked };
      }
      const raw = await registry.execute(request.tool_name, args);
      const result = typeof raw === 'string' ? raw : JSON.stringify(raw);

      const executionTimeMs = Date.now() - startTime;

      // The receipt: the tool returned.
      this.approvalManager.markExecuted(requestId, result.slice(0, 2000), 'committed');

      // Log to audit trail
      this.auditTrail.log({
        agent_id: request.agent_id,
        agent_name: request.agent_name,
        tool_name: request.tool_name,
        action_category: request.action_category as ActionCategory,
        authority_decision: 'approval_required',
        approval_id: requestId,
        executed: true,
        execution_time_ms: executionTimeMs,
      });

      // Record approval for learning. Two kinds are excluded.
      //
      // Taint-gated: an override the learner would suggest cannot lift a
      // profile gate, so the suggestion would be dead on arrival.
      //
      // Above-level substitutions: the opposite problem, and live rather
      // than dead. A `confirm: 'above_level'` card says "this one call
      // reached a category above this agent's level" -- it is not the
      // person endorsing the category. But `getSuggestions` emits a
      // per-CATEGORY override with no tool and no role, and an override is
      // evaluated BEFORE the level check, so accepting one would auto-allow
      // that category for every tool at every level. `site_delete_file`
      // (#503) makes this concrete: it is an approval on every single call,
      // so five routine project-file deletions would offer to auto-allow
      // `delete_data` everywhere.
      const reason = request.reason ?? '';
      const learnable = !reason.includes(TAINT_PROFILE_LABEL)
        && !reason.includes(ABOVE_LEVEL_SUBSTITUTION);
      if (learnable) {
        this.learner?.recordDecision(
          request.action_category as ActionCategory,
          request.tool_name,
          true
        );
      }

      // Notify
      this.onResult?.(requestId, request, result);

      return { claimed: true, result };
    } catch (err) {
      const errorStr = `Error executing ${request.tool_name}: ${err instanceof Error ? err.message : String(err)}`;
      // The receipt: the tool threw. The call was dispatched, so a partial
      // effect is possible; the row is executed with a failed outcome.
      this.approvalManager.markExecuted(requestId, errorStr, 'failed');
      this.onResult?.(requestId, request, errorStr);
      return { claimed: true, result: errorStr };
    }
  }

  /**
   * Handle a denial — record for learning.
   */
  recordDenial(request: ApprovalRequest): void {
    this.learner?.recordDecision(
      request.action_category as ActionCategory,
      request.tool_name,
      false
    );
  }
}
