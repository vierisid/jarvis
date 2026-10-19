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

import { APPROVAL_SHORT_ID_LENGTH, guardedApprovalWrite, approvalNeedsClick, DASHBOARD_DECIDER, executionState, type ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { isAgentStopCard, type DeferredExecutor } from '../authority/deferred-executor.ts';
import type { AuditTrail, ResolutionChannel } from '../authority/audit.ts';
import { activeEmergencyState } from '../authority/emergency.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { approvalChannelCard, approvalToast } from '../authority/approval-delivery.ts';

export interface ApprovalDecisionDeps {
  approvalManager: ApprovalManager;
  /** Optional revision fence supplied by a decision surface. Runs before a durable write. */
  assertCurrent?: () => void;
  deferredExecutor: DeferredExecutor;
  wsService?: { broadcastApprovalUpdate(request: ApprovalRequest): void } | null;
  /** Records each decision with the surface it came from (Q-08). */
  auditTrail?: Pick<AuditTrail, 'log'> | null;
}

/** The audit channel a decision surface writes (Q-08). */
export function resolutionChannel(decidedBy: string): ResolutionChannel {
  if (decidedBy === DASHBOARD_DECIDER) return 'click';
  if (decidedBy === 'voice') return 'voice';
  if (decidedBy === 'notification') return 'notification';
  if (decidedBy === 'telegram' || decidedBy === 'discord') return 'chat';
  return 'system';
}

function auditDecision(deps: ApprovalDecisionDeps, request: ApprovalRequest, decision: 'approve' | 'deny', decidedBy: string): void {
  try {
    deps.auditTrail?.log({
      agent_id: request.agent_id, agent_name: request.agent_name, tool_name: request.tool_name,
      action_category: request.action_category as ActionCategory,
      authority_decision: decision === 'approve' ? 'allowed' : 'denied',
      approval_id: request.id, executed: false, channel: resolutionChannel(decidedBy),
    });
  } catch (err) {
    console.warn('[Approval] could not audit a decision:', err instanceof Error ? err.message : err);
  }
}

export type ApprovalDecisionOutcome =
  | { status: 'already_decided' }
  /** A card that must be reviewed on screen, approved from anywhere else: refused, and it stays pending (Q-08). */
  | { status: 'needs_dashboard'; request: ApprovalRequest }
  /** Jarvis is paused or stopped: approving waits for Resume, and the card stays pending; denying still works (Q-08). */
  | { status: 'held'; request: ApprovalRequest; state: 'paused' | 'killed' }
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
    // A card whose effect has to be reviewed on screen (browser and desktop
    // actions) is approved on the dashboard only: a chat reply or a toast
    // cannot show what it would do (Q-08). The executor refuses it too.
    const pending = approvalManager.getRequest(requestId);
    if (pending?.status === 'pending' && decidedBy !== DASHBOARD_DECIDER && approvalNeedsClick(pending)) {
      return { status: 'needs_dashboard', request: pending };
    }
    // Pause holds: nothing new starts, an approval included. The card waits
    // for Resume instead of turning into a refused run (Q-08).
    const emergency = activeEmergencyState();
    if (pending?.status === 'pending' && emergency !== 'normal' && !isAgentStopCard(pending)) {
      return { status: 'held', request: pending, state: emergency };
    }
    const approved = guardedApprovalWrite(deps.assertCurrent, () => approvalManager.approve(requestId, decidedBy));
    if (!approved) return { status: 'already_decided' };
    auditDecision(deps, approved, 'approve', decidedBy);
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

  const denied = guardedApprovalWrite(deps.assertCurrent, () => approvalManager.deny(requestId, decidedBy));
  if (!denied) return { status: 'already_decided' };
  auditDecision(deps, denied, 'deny', decidedBy);
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
  return channelDecisionReply(outcome, request);
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

/** What a person approving while Jarvis is paused or stopped is told (Q-08). */
export function heldApprovalMessage(state: 'paused' | 'killed'): string {
  return state === 'paused'
    ? 'Jarvis is paused, so this action waits. Resume Jarvis, then approve it; it is still waiting.'
    : 'Jarvis was stopped with Kill, so this action cannot be approved. Reset Jarvis and make a fresh request.';
}

/**
 * What a desktop notification says after an approve it refused, the card
 * still pending; null when there is nothing to say (Q-08).
 */
export function notificationDecisionNote(outcome: ApprovalDecisionOutcome): string | null {
  if (outcome.status === 'needs_dashboard') {
    return 'This one has to be reviewed on screen, so it cannot be approved from a notification. Approve it on the Jarvis dashboard.';
  }
  if (outcome.status === 'held') return heldApprovalMessage(outcome.state);
  return null;
}

/**
 * What a Telegram or Discord reply is told: what the receipt says happened,
 * never "executed" for a run that was refused, failed or may not have
 * happened (Q-08).
 */
export function channelDecisionReply(outcome: ApprovalDecisionOutcome, request: ApprovalRequest): string {
  if (outcome.status === 'already_decided') return 'Request already decided';
  if (outcome.status === 'needs_dashboard') {
    return 'This one has to be reviewed on screen, so it cannot be approved from chat. Approve it on the Jarvis dashboard.';
  }
  if (outcome.status === 'held') return heldApprovalMessage(outcome.state);
  if (outcome.status === 'denied') return `Denied: ${request.tool_name}`;
  if (outcome.error) return `Approved, but execution failed: ${outcome.error.slice(0, 200)}`;
  if (!outcome.executed) return 'Approved. The agent will continue and report back in chat.';
  switch (executionState(outcome.request)) {
    case 'committed': return `Approved and executed. Result: ${outcome.result.slice(0, 200)}`;
    case 'blocked': return `Approved, but not run: ${outcome.result.slice(0, 200)}`;
    case 'unknown': return `Approved, but it is not known whether it happened. Check before asking again: ${outcome.result.slice(0, 200)}`;
    default: return `Approved, but it failed: ${outcome.result.slice(0, 200)}`;
  }
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
    if (!guardedApprovalWrite(deps.assertCurrent, () => approvalManager.closeUnresolved(requestId, resolvedBy, note))) return { status: 'not_unresolved' };
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
  // Paused or stopped: running it waits, as approving does (Q-08). Claimed
  // now, the executor's emergency gate would close it as refused for good.
  const emergency = activeEmergencyState();
  if (emergency !== 'normal' && !isAgentStopCard(current)) {
    return { status: 'not_executable', reason: emergency === 'paused'
      ? 'Jarvis is paused, so nothing can run now. Resume Jarvis, then run it; it is still waiting.'
      : 'Jarvis was stopped with Kill, so nothing can run now. Reset Jarvis first.' };
  }
  // Runs through the same claim as every execution, so this is exactly one
  // attempt even if two surfaces resolve the same row at once. A claim lost
  // between the check above and the run is reported as such, not as a run.
  const { claimed, result } = await deferredExecutor.executeApprovedWithReceipt(requestId, resolvedBy, deps.assertCurrent);
  const updated = approvalManager.getRequest(requestId) ?? current;
  if (!claimed) {
    return { status: 'not_executable', reason: `Another surface took this approval first (${updated.execution_outcome ?? 'in flight'}); its receipt will say what happened.` };
  }
  wsService?.broadcastApprovalUpdate(updated);
  return { status: 'executed', result, request: updated };
}
