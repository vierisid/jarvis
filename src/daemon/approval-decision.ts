/**
 * The complete approve/deny flow shared by every decision surface (dashboard
 * REST, chat channels, OS-notification buttons): flip the request, run the
 * deferred executor where the request isn't owned by a blocked in-process
 * caller, record denials, and broadcast so dashboard cards update.
 */

import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';

export interface ApprovalDecisionDeps {
  approvalManager: ApprovalManager;
  deferredExecutor: DeferredExecutor;
  wsService?: { broadcastApprovalUpdate(request: ApprovalRequest): void } | null;
}

export type ApprovalDecisionOutcome =
  | { status: 'already_decided' }
  | { status: 'approved'; executed: boolean; result: string; request: ApprovalRequest; error?: string }
  | { status: 'denied'; request: ApprovalRequest };

export async function applyApprovalDecision(
  action: 'approve' | 'deny',
  requestId: string,
  decidedBy: string,
  deps: ApprovalDecisionDeps,
): Promise<ApprovalDecisionOutcome> {
  const { approvalManager, deferredExecutor, wsService } = deps;

  if (action === 'approve') {
    const approved = approvalManager.approve(requestId, decidedBy);
    if (!approved) return { status: 'already_decided' };
    let executed = false;
    let result = '';
    let error: string | undefined;
    if (approved.tool_name !== 'request_approval' && approved.execution_mode !== 'inline') {
      // Intent-only and inline requests are executed by the blocked caller
      // (request_approval tool / authority gate) once it sees the status flip —
      // executing here would run the tool twice.
      try {
        result = await deferredExecutor.executeApproved(requestId);
        executed = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[Approval] ${decidedBy}-approved execution failed:`, err);
      }
    }
    // Broadcast the update (removes the card from the dashboard thread).
    const updated = approvalManager.getRequest(requestId) ?? approved;
    wsService?.broadcastApprovalUpdate(updated);
    return { status: 'approved', executed, result, request: updated, error };
  }

  const denied = approvalManager.deny(requestId, decidedBy);
  if (!denied) return { status: 'already_decided' };
  deferredExecutor.recordDenial(denied);
  wsService?.broadcastApprovalUpdate(denied);
  return { status: 'denied', request: denied };
}
