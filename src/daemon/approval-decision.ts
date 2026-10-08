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

import { APPROVAL_SHORT_ID_LENGTH, type ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';
import { approvalChannelCard, approvalToast } from '../authority/approval-delivery.ts';

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

/** What the channel reply handler answers when an `approve` names a card that could not be shown whole. */
export const CHANNEL_APPROVE_REFUSED =
  'This approval is too long to show whole in a chat message, so it cannot be approved from here. Open the Jarvis dashboard to read it and decide.';

/**
 * A Telegram/Discord `approve <id>` or `deny <id>` reply, and the answer sent
 * back to the chat.
 *
 * An `approve` is refused for a request whose card could not show all of what
 * would happen (`approvalChannelCard(...).approvable`, #718): that card offered
 * only `deny`, and typing `approve` must not get past what the card withheld.
 * Recomputed from the request rather than remembered, so it holds across a
 * restart and for a card delivered before it.
 */
export async function channelApprovalReply(
  action: 'approve' | 'deny',
  shortId: string,
  channel: string,
  deps: ApprovalDecisionDeps,
): Promise<string> {
  const match = deps.approvalManager.findByShortId(shortId);
  const nothing = action === 'approve' ? 'Nothing was approved.' : 'Nothing was denied.';
  // The id is never echoed when malformed: it is whatever followed the verb.
  if (match.status === 'malformed') {
    return `That is not an approval ID. Reply with the ${APPROVAL_SHORT_ID_LENGTH}-character ID shown on the card, like "${action} 1a2b3c4d". ${nothing}`;
  }
  if (match.status === 'ambiguous') {
    return `More than one pending approval has the ID ${shortId}, so it does not say which one you mean. ${nothing} Open the Jarvis dashboard to decide.`;
  }
  if (match.status === 'none') return `No pending approval found for ID ${shortId}`;
  const request = match.request;
  if (action === 'approve' && !approvalChannelCard(request).approvable) return CHANNEL_APPROVE_REFUSED;

  const outcome = await applyApprovalDecision(action, request.id, channel, deps);
  if (outcome.status === 'already_decided') return 'Request already decided';
  if (outcome.status === 'denied') return `Denied: ${request.tool_name}`;
  if (outcome.executed) return `Approved and executed. Result: ${outcome.result.slice(0, 200)}`;
  if (outcome.error) return `Approved, but execution failed: ${outcome.error.slice(0, 200)}`;
  return 'Approved. The agent will continue and report back in chat.';
}

/**
 * The person's choice from a desktop notification (`notify.action`), or null
 * when it is not an approval decision the daemon acts on.
 *
 * Only kind `approval` carries Approve and Deny, and only for a request whose
 * toast can still show what is being approved (`approvalToast(...).approvable`,
 * #791): a review-only toast has no such buttons, and a click reported for one
 * anyway -- an older sidecar, a stale notification, a sidecar that reports the
 * wrong kind -- is ignored rather than acted on, so the person decides in the
 * dashboard. Recomputed from the request rather than remembered, so it holds
 * across a restart.
 */
export async function notificationApprovalDecision(
  payload: unknown,
  deps: ApprovalDecisionDeps,
): Promise<ApprovalDecisionOutcome | null> {
  const p = (payload ?? {}) as { id?: unknown; kind?: unknown; action?: unknown };
  if (p.kind !== 'approval' || typeof p.id !== 'string' || !p.id) return null;
  if (p.action !== 'approve' && p.action !== 'deny') return null;
  // Fails closed: a request that cannot be read cannot be judged approvable.
  const request = deps.approvalManager.getRequest(p.id);
  if (!request || !approvalToast(request).approvable) {
    console.warn(`[Approval] ignored a notification ${p.action} for ${p.id}: ${request ? 'its toast was review-only' : 'no such request'}`);
    return null;
  }
  return applyApprovalDecision(p.action, p.id, 'notification', deps);
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
