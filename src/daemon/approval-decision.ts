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

import { approvalNeedsClick, DASHBOARD_DECIDER, executionState, type ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { AuditTrail, ResolutionChannel } from '../authority/audit.ts';
import { activeEmergencyState } from '../authority/emergency.ts';
import type { ActionCategory } from '../roles/authority.ts';

export interface ApprovalDecisionDeps {
  approvalManager: ApprovalManager;
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
    if (pending?.status === 'pending' && emergency !== 'normal') {
      return { status: 'held', request: pending, state: emergency };
    }
    const approved = approvalManager.approve(requestId, decidedBy);
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

  const denied = approvalManager.deny(requestId, decidedBy);
  if (!denied) return { status: 'already_decided' };
  auditDecision(deps, denied, 'deny', decidedBy);
  deferredExecutor.recordDenial(denied);
  wsService?.broadcastApprovalUpdate(denied);
  return { status: 'denied', request: denied };
}

/** What a person approving while Jarvis is paused or stopped is told (Q-08). */
export function heldApprovalMessage(state: 'paused' | 'killed'): string {
  return state === 'paused'
    ? 'Jarvis is paused, so nothing can be approved now. Resume Jarvis, then approve it; it is still waiting.'
    : 'Jarvis was stopped with Kill, so nothing can be approved now. Reset Jarvis first.';
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
