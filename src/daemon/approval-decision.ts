/**
 * The complete approve/deny flow shared by every decision surface (dashboard
 * REST, chat channels, OS-notification buttons): flip the request, run the
 * deferred executor where the request isn't owned by a blocked in-process
 * caller, record denials, and broadcast so dashboard cards update.
 *
 * `applyExecutionResolution` is the second decision a user can face: an
 * approved request that a restart left without a receipt. Running it is
 * allowed only when nothing happened; closing it is always allowed.
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
    if (approved.tool_name !== 'request_approval' && approved.execution_mode === 'deferred') {
      // Intent-only and inline requests are executed by the blocked caller
      // (request_approval tool / authority gate) once it sees the status flip —
      // executing here would run the tool twice.
      try {
        result = await deferredExecutor.executeApproved(requestId, decidedBy);
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

export type ExecutionResolutionOutcome =
  /** Not found, or not an approved row that a restart left unresolved. */
  | { status: 'not_unresolved' }
  /** Unresolved, but running it is not an option; closing is. */
  | { status: 'not_executable'; reason: string }
  | { status: 'executed'; result: string; request: ApprovalRequest }
  | { status: 'closed'; request: ApprovalRequest };

export async function applyExecutionResolution(
  action: 'execute' | 'close',
  requestId: string,
  resolvedBy: string,
  deps: ApprovalDecisionDeps,
  note?: string,
): Promise<ExecutionResolutionOutcome> {
  const { approvalManager, deferredExecutor, wsService } = deps;
  const current = approvalManager.getRequest(requestId);
  const outcome = current?.execution_outcome ?? null;
  if (!current || current.status !== 'approved' || (outcome !== 'not_started' && outcome !== 'unknown')) {
    return { status: 'not_unresolved' };
  }

  if (action === 'close') {
    if (!approvalManager.closeUnresolved(requestId, resolvedBy, note)) return { status: 'not_unresolved' };
    const updated = approvalManager.getRequest(requestId) ?? current;
    wsService?.broadcastApprovalUpdate(updated);
    return { status: 'closed', request: updated };
  }

  if (outcome === 'unknown') {
    return { status: 'not_executable', reason: 'The earlier attempt was interrupted and may have run. Check what happened, then close it.' };
  }
  if (current.tool_name === 'request_approval') {
    return { status: 'not_executable', reason: 'An intent grant has nothing to run on its own; the conversation that asked for it is gone. Close it.' };
  }
  // Runs through the same claim as every execution, so this is exactly one
  // attempt even if two surfaces resolve the same row at once. A claim lost
  // between the check above and the run is reported as such, not as a run.
  const { claimed, result } = await deferredExecutor.executeApprovedWithReceipt(requestId, resolvedBy);
  const updated = approvalManager.getRequest(requestId) ?? current;
  if (!claimed) {
    return { status: 'not_executable', reason: `Another surface took this approval first (${updated.execution_outcome ?? 'in flight'}); its receipt will say what happened.` };
  }
  wsService?.broadcastApprovalUpdate(updated);
  return { status: 'executed', result, request: updated };
}
