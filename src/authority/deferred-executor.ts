/**
 * Deferred Executor — Runs approved tool calls that were waiting for approval.
 */

import type { ToolRegistry } from '../actions/tools/registry.ts';
import type { ApprovalManager, ApprovalRequest } from './approval.ts';
import type { AuditTrail } from './audit.ts';
import type { AuthorityLearner } from './learning.ts';
import type { EmergencyController } from './emergency.ts';
import type { ActionCategory } from '../roles/authority.ts';

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
   * Execute a previously approved request.
   */
  async executeApproved(requestId: string): Promise<string> {
    const request = this.approvalManager.getRequest(requestId);
    if (!request || request.status !== 'approved') {
      return `Error: Request ${requestId} not found or not in approved state`;
    }

    if (!this.toolRegistry) {
      return 'Error: No tool registry configured';
    }

    // Emergency gate: an approval clicked while the system is paused/killed
    // must not execute. Close the request out (mirroring the error path)
    // so it doesn't linger as an approved-but-never-executed zombie.
    if (this.emergencyController && !this.emergencyController.canExecute()) {
      const state = this.emergencyController.getState();
      const blocked = `[SYSTEM ${state.toUpperCase()}] Approved action ${request.tool_name} was NOT executed: all tool execution is suspended because the user has ${state} the system.`;
      this.approvalManager.markExecuted(requestId, blocked);
      this.onResult?.(requestId, request, blocked);
      return blocked;
    }

    const startTime = Date.now();

    try {
      const args = JSON.parse(request.tool_arguments);
      const raw = await this.toolRegistry.execute(request.tool_name, args);
      const result = typeof raw === 'string' ? raw : JSON.stringify(raw);

      const executionTimeMs = Date.now() - startTime;

      // Mark as executed
      this.approvalManager.markExecuted(requestId, result.slice(0, 2000));

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

      // Record approval for learning
      this.learner?.recordDecision(
        request.action_category as ActionCategory,
        request.tool_name,
        true
      );

      // Notify
      this.onResult?.(requestId, request, result);

      return result;
    } catch (err) {
      const errorStr = `Error executing ${request.tool_name}: ${err instanceof Error ? err.message : String(err)}`;
      this.approvalManager.markExecuted(requestId, errorStr);
      this.onResult?.(requestId, request, errorStr);
      return errorStr;
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
