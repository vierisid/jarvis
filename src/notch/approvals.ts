/**
 * Approvals on the notch: one line, one yes.
 *
 * Every pending approval the product holds becomes an item in the inbox
 * (./inbox.ts). Nothing about approving is decided here. The yes goes through
 * the one decision function every surface uses (daemon/approval-decision.ts),
 * so "decided once" and every refusal it makes hold for the notch as they do
 * for the dashboard.
 *
 * What a key may approve follows the rules a spoken yes already follows
 * (roles/authority.ts, gateVoiceApprovalResolution), plus the rule every
 * surface smaller than the dashboard follows (approvalToast: it must be able
 * to show the action whole):
 *
 *   - a payment: never. The line says so and offers to open the dashboard.
 *   - a destructive request, or one that needs on-screen review: the same.
 *   - a sentence too long to show whole, or one that could be a look-alike:
 *     the same.
 *   - anything else: yes approves it.
 *
 * A yes is not acted on at once. A fuse burns first, and Esc takes it back:
 * that is the undo window. The approval stays pending for all of it, so
 * nothing has to be undone: if the fuse is taken back, or the page goes away
 * before it has burnt, nothing was ever decided. If the dashboard decides in
 * the meantime, the decision function says so and the notch passes that on.
 *
 * Not now and a line left alone are never a deny. A deny is a decision with
 * consequences (the agent is told not to try again), and it is not given by
 * looking away.
 *
 * The approvals are found by looking, once a second, the way the tray and
 * the toast find them: nothing in the product announces them to listeners.
 */
import { approvalToast } from '../authority/approval-delivery.ts';
import { approvalDashboardOnly, executionState } from '../authority/approval.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { ApprovalDecisionOutcome } from '../daemon/approval-decision.ts';
import { gateVoiceApprovalResolution } from '../roles/authority.ts';
import type { ActionCategory } from '../roles/authority.ts';
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';

/** How long the fuse burns between a yes and the decision. */
export const NOTCH_APPROVAL_FUSE_MS = 3000;
/** How often the pending approvals are looked at. */
export const NOTCH_APPROVAL_LOOK_MS = 1000;
/** An approval older than this when first seen joins the count without speaking up. */
const FRESH_MS = 60_000;

/**
 * How the notch may answer a request: `key` when yes approves it, otherwise
 * why it must be approved in the dashboard.
 */
export type NotchApprovalWay = 'key' | 'payment' | 'click' | 'destructive' | 'unreadable';

export function notchApprovalWay(request: ApprovalRequest): NotchApprovalWay {
  const only = approvalDashboardOnly(request);
  if (only === 'payment') return 'payment';
  if (only === 'click_only') return 'click';
  // A key press is a clear yes, so only the impact rule of the voice gate is left.
  if (gateVoiceApprovalResolution(request.action_category as ActionCategory, 1, 'approve').kind !== 'resolve') return 'destructive';
  if (!approvalToast(request).approvable) return 'unreadable';
  return 'key';
}

export interface NotchApprovalDeps {
  approvalManager: {
    getPending(): ApprovalRequest[];
    getRequest(requestId: string): ApprovalRequest | null;
  };
  /** Approves through the product's own decision function, as the notch. */
  approve(requestId: string): Promise<ApprovalDecisionOutcome>;
  /** Opens the dashboard on the machine whose notch was answered. */
  openDashboard?: (sidecarId: string | null) => void;
  now?: () => number;
  fuseMs?: number;
  log?: (line: string) => void;
}

export interface NotchApprovals {
  /** Looks at the pending approvals now, and brings the inbox in line with them. */
  sync(): void;
  /** The item id an approval has in the inbox. */
  itemId(requestId: string): string;
}

const em = (text: string): NotchPart => ({ em: text });

/** One sentence, with its last full stop taken off so another mark can follow. */
const bare = (sentence: string): string => sentence.replace(/[.\s]+$/u, '');

export function attachNotchApprovals(inbox: NotchInbox, deps: NotchApprovalDeps): NotchApprovals {
  const now = deps.now ?? Date.now;
  const fuseMs = deps.fuseMs ?? NOTCH_APPROVAL_FUSE_MS;
  const log = deps.log ?? ((line: string) => console.log(line));
  const itemId = (requestId: string): string => `approval:${requestId}`;
  /** Approvals that have an item, by request id. */
  const known = new Set<string>();
  /**
   * Approvals the person has said yes to on the notch, from that yes until
   * the notch has said what came of it. If one is decided somewhere else in
   * that time, the line does not just leave: its own script finds out and
   * says so.
   */
  const answering = new Set<string>();

  const pendingRequest = (requestId: string): ApprovalRequest | null => {
    const request = deps.approvalManager.getRequest(requestId);
    return request && request.status === 'pending' ? request : null;
  };

  /** What happened to a request the notch did not get to decide. */
  const decidedElsewhere = (requestId: string): NotchPart[] => {
    const request = deps.approvalManager.getRequest(requestId);
    if (!request) return ['That request is gone.'];
    if (request.status === 'denied') return ['Already denied. Nothing was run.'];
    if (request.status === 'expired') return ['It expired before you answered. Nothing was run.'];
    return ['Already decided in the dashboard.'];
  };

  async function play(requestId: string, stage: NotchStage): Promise<NotchItemEnd> {
    // Each time round: the offer, then the fuse. Taking the fuse back returns
    // to the offer, which is where it came from.
    for (;;) {
      const request = pendingRequest(requestId);
      if (!request) return 'settled';
      const toast = approvalToast(request);
      const way = notchApprovalWay(request);
      if (way !== 'key') {
        // The reason first, then the thing itself, with nothing after it: a
        // line that wraps must not start with a stray full stop.
        const why: NotchPart[] = way === 'payment'
          ? ['A payment. I never take that on a key: ', em(bare(toast.body))]
          : way === 'unreadable'
            ? ['Too long to show whole here, so it is approved in the dashboard: ', em(bare(toast.body))]
            : ['Approved with a click in the dashboard, not with a key: ', em(bare(toast.body))];
        const answer = await stage.offer(why, 'open', { mood: 'careful' });
        if (answer.act !== 'yes') return 'waits';
        deps.openDashboard?.(stage.from());
        await stage.say(['It is open in the dashboard.'], 1800);
        return 'waits';
      }

      const answer = await stage.offer([`${bare(toast.body)}?`], 'approve');
      if (answer.act !== 'yes') return 'waits';
      answering.add(requestId);
      try {
        const fuse = await stage.fuse([`${bare(toast.body)}…`], fuseMs, { mood: 'work' });
        if (fuse === 'undo') continue;
        // Nobody saw the fuse burn out: the yes is not acted on.
        if (fuse === 'lost') return 'waits';
        return await decide(requestId, stage);
      } finally {
        answering.delete(requestId);
      }
    }
  }

  /** The fuse has burnt: decide, and say what came of it. */
  async function decide(requestId: string, stage: NotchStage): Promise<NotchItemEnd> {
    let outcome: ApprovalDecisionOutcome;
    try {
      outcome = await deps.approve(requestId);
    } catch (error) {
      log(`[notch] an approval could not be decided: ${error instanceof Error ? error.message : String(error)}`);
      await stage.say(['That did not go through. It still waits.'], 2600, { mood: 'sorry', mark: 'fail' });
      return 'waits';
    }

    switch (outcome.status) {
      case 'already_decided':
        await stage.say(decidedElsewhere(requestId), 2600);
        return 'settled';
      case 'needs_dashboard':
        await stage.say(['That one is approved with a click in the dashboard.'], 2600, { mood: 'careful' });
        return 'waits';
      case 'held':
        await stage.say([outcome.state === 'paused'
          ? 'Jarvis is paused, so this waits. Wake me, then say yes again.'
          : 'Jarvis was stopped, so this cannot be approved.'], 3200, { mood: 'careful' });
        return 'waits';
      case 'denied':
        return 'settled';
      case 'approved': {
        if (outcome.error) {
          await stage.say(['Approved, but it could not be started.'], 3000, { mood: 'sorry', mark: 'fail' });
          return 'settled';
        }
        // Run by whoever was waiting for the answer, not here: an agent in
        // the middle of its work, or a workflow that now goes on.
        if (!outcome.executed) {
          await stage.say(['Approved.'], 1800, { mood: 'happy', mark: 'check' });
          return 'settled';
        }
        const state = executionState(outcome.request);
        if (state === 'committed') {
          await stage.say(['Done.'], 1800, { mood: 'happy', mark: 'check' });
        } else if (state === 'blocked') {
          await stage.say(['Approved, but it was not run. The dashboard says why.'], 3200, { mood: 'careful', mark: 'fail' });
        } else if (state === 'unknown') {
          await stage.say(['Approved, but I cannot tell whether it happened. Check before asking again.'], 3600, { mood: 'worried', mark: 'fail' });
        } else {
          await stage.say(['Approved, but it failed.'], 3000, { mood: 'sorry', mark: 'fail' });
        }
        return 'settled';
      }
    }
  }

  function item(request: ApprovalRequest): NotchItem {
    const requestId = request.id;
    return {
      id: itemId(requestId),
      subject: itemId(requestId),
      // An agent stopped in the middle of its work is a running clock: it
      // gives up waiting after a while. The rest can wait.
      class: request.execution_mode === 'inline' ? 'clock' : 'rest',
      // What was already waiting when the notch came up joins the count
      // quietly, as the toast leaves a backlog alone.
      speaks: now() - request.created_at < FRESH_MS,
      title: () => {
        const current = deps.approvalManager.getRequest(requestId) ?? request;
        return [approvalToast(current).body];
      },
      check: () => pendingRequest(requestId) !== null,
      play: (stage) => play(requestId, stage),
    };
  }

  function sync(): void {
    let pending: ApprovalRequest[];
    try {
      pending = deps.approvalManager.getPending();
    } catch (error) {
      log(`[notch] the pending approvals could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const ids = new Set(pending.map((request) => request.id));
    // Oldest first, so the count's order is the order they were asked in.
    for (const request of [...pending].sort((a, b) => a.created_at - b.created_at)) {
      if (known.has(request.id)) continue;
      known.add(request.id);
      inbox.add(item(request));
    }
    for (const requestId of [...known]) {
      if (ids.has(requestId) || answering.has(requestId)) continue;
      known.delete(requestId);
      // Decided, expired or withdrawn somewhere else: the line leaves by itself.
      inbox.remove(itemId(requestId));
    }
  }

  return { sync, itemId };
}
