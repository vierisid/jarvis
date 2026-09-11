/**
 * CommitmentExecutor — Notify-Then-Execute Engine
 *
 * Detects due commitments, announces pending execution to the UI
 * with a cancel window, then forces the agent to execute if not cancelled.
 *
 * Aggressiveness modes:
 *   passive:    announce only, never auto-execute
 *   moderate:   30s cancel window (default)
 *   aggressive: 5s cancel window
 */

import { getDueCommitments, getUpcoming, updateCommitmentStatus, getCommitment } from '../vault/commitments.ts';
import type { Commitment } from '../vault/commitments.ts';
import type { IAgentService } from './agent-service-interface.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { WorkflowEventBus } from '../workflows/runtime/event-bus.ts';

export type Aggressiveness = 'passive' | 'moderate' | 'aggressive';

export type ExecutionState = {
  commitmentId: string;
  what: string;
  announcedAt: number;
  cancelDeadline: number;
  cancelled: boolean;
  executed: boolean;
};

export type BroadcastFn = (msg: WSMessage) => void;

const CANCEL_WINDOW: Record<Aggressiveness, number> = {
  passive: Infinity,
  moderate: 30_000,
  aggressive: 5_000,
};

/** Minimal view of an approval request the executor needs to settle a commitment. */
export type ApprovalLookup = (requestId: string) => { status: string; execution_result: string | null } | null;

/** Result prefix of a commitment parked on approval requests. */
const AWAITING_PREFIX = 'Awaiting user approval ';
const AWAITING_RE = /^Awaiting user approval \[req:([^\]]*)\]/;

/** Request ids encoded in a parked commitment's result, or null if not parked. */
export function parseParkedRequestIds(result: string | null | undefined): string[] | null {
  if (!result) return null;
  const m = AWAITING_RE.exec(result);
  if (!m) return null;
  return m[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export class CommitmentExecutor {
  private agentService: IAgentService | null = null;
  private broadcast: BroadcastFn | null = null;
  private eventBus: WorkflowEventBus | null = null;
  /** Commitments for which we've already emitted commitment.overdue / due_soon. */
  private notifiedIds: Set<string> = new Set();
  private pending: Map<string, ExecutionState> = new Map();
  private executedIds: Set<string> = new Set();
  /** Commitments parked on approval requests, keyed by commitment id. */
  private awaitingApproval: Map<string, { what: string; requestIds: string[] }> = new Map();
  private approvalLookup: ApprovalLookup | null = null;
  private checkTimer: Timer | null = null;
  /**
   * Per-pending execution-fire timers. Replaces the global 5s polling tick:
   * each announcement schedules its own setTimeout at the exact cancel deadline,
   * so we fire precisely instead of within a 5s window and burn no CPU while
   * waiting.
   */
  private executeTimers: Map<string, Timer> = new Map();
  private aggressiveness: Aggressiveness;
  private running = false;

  constructor(aggressiveness: Aggressiveness = 'moderate') {
    this.aggressiveness = aggressiveness;
  }

  setAgentService(agent: IAgentService): void {
    this.agentService = agent;
  }

  /** Lets the executor read approval outcomes for parked commitments. */
  setApprovalLookup(lookup: ApprovalLookup): void {
    this.approvalLookup = lookup;
  }

  /**
   * Close commitments parked on approval requests once every request has a
   * final outcome: completed if at least one executed, failed if they were
   * all denied or expired. Runs on every check tick and can be called
   * directly (tests, or right after an approval decision).
   */
  settleAwaitingApprovals(): void {
    if (!this.approvalLookup) return;
    for (const [commitmentId, entry] of this.awaitingApproval) {
      try {
        let pending = 0;
        let executed = 0;
        const results: string[] = [];
        for (const id of entry.requestIds) {
          const req = this.approvalLookup(id);
          const status = req?.status ?? 'expired'; // a vanished row counts as expired
          if (status === 'pending' || status === 'approved') pending += 1;
          else if (status === 'executed') {
            executed += 1;
            if (req?.execution_result) results.push(req.execution_result);
          }
        }
        if (pending > 0) continue;

        this.awaitingApproval.delete(commitmentId);
        // The user (dashboard, commitments tool) may have closed or cancelled
        // it by hand in the meantime; their decision wins over the outcome.
        const current = getCommitment(commitmentId);
        if (!current || current.status !== 'active') continue;
        if (executed > 0) {
          const summary = results.join('\n').slice(0, 500) || 'Approved and executed';
          updateCommitmentStatus(commitmentId, 'completed', summary);
          console.log(`[Executor] Completed after approval: "${entry.what}"`);
        } else {
          updateCommitmentStatus(commitmentId, 'failed', 'Approval denied or expired');
          console.log(`[Executor] Approval denied or expired: "${entry.what}"`);
        }
      } catch (err) {
        // One bad row must not skip the rest of the tick.
        console.error('[Executor] Failed to settle commitment status:', err);
      }
    }
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * Wire the workflow event bus so the executor can publish
   * `commitment.due_soon` / `commitment.overdue` events for `on_event`
   * workflow triggers. Previously the 15-min heartbeat did this; pushing it
   * here lets us delete the heartbeat entirely.
   */
  setEventBus(bus: WorkflowEventBus): void {
    this.eventBus = bus;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Discovery sweep: catches commitments created by code paths that don't
    // explicitly call into the executor. Every 60s is cheap (one SQL query,
    // no LLM). Per-pending execution timing uses setTimeout, not polling.
    this.checkTimer = setInterval(() => {
      this.checkAndAnnounce();
    }, 60_000);

    // Run an immediate check
    this.checkAndAnnounce();

    console.log(`[Executor] Started (mode: ${this.aggressiveness}, discovery=60s, fire=per-pending setTimeout)`);
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    for (const t of this.executeTimers.values()) clearTimeout(t);
    this.executeTimers.clear();
    console.log('[Executor] Stopped');
  }

  /**
   * Check for commitments that are due or due within 2 minutes. Announces
   * each new candidate for execution and publishes one-shot
   * `commitment.overdue` / `commitment.due_soon` workflow events so `on_event`
   * triggers fire on transitions (not every poll).
   */
  checkAndAnnounce(): void {
    this.settleAwaitingApprovals();
    try {
      const now = Date.now();
      const dueNow = getDueCommitments(); // when_due <= now
      const upcoming = getUpcoming(20); // all upcoming with when_due

      // Filter upcoming to those due within 15 minutes (matches the workflow
      // event semantics that the deleted heartbeat used).
      const dueSoon = upcoming.filter(
        (c) => c.when_due && c.when_due > now && c.when_due <= now + 15 * 60_000,
      );

      // Emit bus events first so workflows fire as soon as state transitions.
      for (const c of dueNow) {
        if (c.status === 'completed' || c.status === 'failed') continue;
        if (this.notifiedIds.has(`overdue:${c.id}`)) continue;
        this.notifiedIds.add(`overdue:${c.id}`);
        this.eventBus?.publish('commitment.overdue', {
          id: c.id, what: c.what, when_due: c.when_due, priority: c.priority,
        });
      }
      for (const c of dueSoon) {
        if (c.status === 'completed' || c.status === 'failed') continue;
        if (this.notifiedIds.has(`due_soon:${c.id}`)) continue;
        this.notifiedIds.add(`due_soon:${c.id}`);
        this.eventBus?.publish('commitment.due_soon', {
          id: c.id, what: c.what, when_due: c.when_due, priority: c.priority,
        });
      }

      // Cap notifiedIds memory the same way executedIds is capped.
      if (this.notifiedIds.size > 1000) {
        const arr = Array.from(this.notifiedIds);
        this.notifiedIds = new Set(arr.slice(arr.length - 500));
      }

      // Filter to within 2 minutes for actual announcement (existing behavior).
      const announceCandidates = [
        ...dueNow,
        ...upcoming.filter(c => c.when_due && c.when_due > now && c.when_due <= now + 2 * 60_000),
      ];

      for (const commitment of announceCandidates) {
        // Skip if already announced, executed, or terminal status
        if (this.pending.has(commitment.id)) continue;
        if (this.executedIds.has(commitment.id)) continue;
        if (commitment.status === 'completed' || commitment.status === 'failed') continue;

        // Parked on approval requests (possibly from before a restart, or
        // evicted from executedIds): rehydrate the wait instead of running
        // the commitment again and creating a second request.
        const parked = parseParkedRequestIds(commitment.result);
        if (parked) {
          if (!this.awaitingApproval.has(commitment.id)) {
            this.awaitingApproval.set(commitment.id, { what: commitment.what, requestIds: parked });
          }
          continue;
        }

        this.announceExecution(commitment);
      }
    } catch (err) {
      console.error('[Executor] Check error:', err);
    }
  }

  /**
   * Cancel a pending execution. Returns true if successfully cancelled.
   */
  cancelExecution(commitmentId: string): boolean {
    const state = this.pending.get(commitmentId);
    if (!state || state.executed || state.cancelled) return false;

    state.cancelled = true;
    console.log(`[Executor] Cancelled execution: ${state.what}`);

    // Broadcast cancellation confirmation
    this.broadcast?.({
      type: 'notification',
      payload: {
        source: 'commitment_executor',
        action: 'execution_cancelled',
        commitmentId,
        what: state.what,
      },
      timestamp: Date.now(),
    });

    // Clean up
    this.pending.delete(commitmentId);
    const timer = this.executeTimers.get(commitmentId);
    if (timer) {
      clearTimeout(timer);
      this.executeTimers.delete(commitmentId);
    }
    return true;
  }

  /**
   * Get all pending executions (for UI display).
   */
  getPending(): ExecutionState[] {
    return Array.from(this.pending.values()).filter((s) => !s.cancelled && !s.executed);
  }

  // --- Private ---

  private announceExecution(commitment: Commitment): void {
    const now = Date.now();
    const cancelWindow = CANCEL_WINDOW[this.aggressiveness];

    const state: ExecutionState = {
      commitmentId: commitment.id,
      what: commitment.what,
      announcedAt: now,
      cancelDeadline: cancelWindow === Infinity ? Infinity : now + cancelWindow,
      cancelled: false,
      executed: false,
    };

    this.pending.set(commitment.id, state);

    if (this.aggressiveness === 'passive') {
      console.log(`[Executor] Announced (passive, no auto-execute): ${commitment.what}`);
    } else {
      const windowSec = Math.round(cancelWindow / 1000);
      console.log(`[Executor] Announced: "${commitment.what}" — executing in ${windowSec}s unless cancelled`);
    }

    // Broadcast announcement to all WebSocket clients
    this.broadcast?.({
      type: 'notification',
      payload: {
        source: 'commitment_executor',
        action: 'pending_execution',
        commitmentId: commitment.id,
        what: commitment.what,
        executeAt: state.cancelDeadline === Infinity ? null : state.cancelDeadline,
        cancelWindowMs: cancelWindow === Infinity ? null : cancelWindow,
      },
      timestamp: now,
    });

    // Also broadcast as a chat message so the user sees it
    this.broadcast?.({
      type: 'chat',
      payload: {
        text: this.aggressiveness === 'passive'
          ? `Task due: "${commitment.what}". Waiting for your instruction to proceed.`
          : `Executing "${commitment.what}" in ${Math.round(cancelWindow / 1000)}s. Send cancel to abort.`,
        source: 'proactive',
      },
      priority: 'urgent',
      timestamp: now,
    });

    // Schedule the execution fire precisely at the cancel deadline. Passive
    // mode never auto-fires (cancelDeadline is Infinity); we skip scheduling.
    if (state.cancelDeadline !== Infinity) {
      const delay = Math.max(0, state.cancelDeadline - now);
      const timer = setTimeout(() => {
        this.executeTimers.delete(commitment.id);
        this.fireExecution(commitment.id).catch(err =>
          console.error(`[Executor] Fire error for ${commitment.id}:`, err),
        );
      }, delay);
      this.executeTimers.set(commitment.id, timer);
    }
  }

  /**
   * Fire a single pending execution. Called by setTimeout at the cancel
   * deadline. Replaces the global tickTimer that previously polled every 5s.
   */
  private async fireExecution(commitmentId: string): Promise<void> {
    const state = this.pending.get(commitmentId);
    if (!state) return;
    if (state.cancelled || state.executed) {
      this.pending.delete(commitmentId);
      return;
    }
    if (!this.agentService) return;

    state.executed = true;
    this.pending.delete(commitmentId);
    this.executedIds.add(commitmentId);

    // Cap executedIds memory
    if (this.executedIds.size > 500) {
      const arr = Array.from(this.executedIds);
      this.executedIds = new Set(arr.slice(arr.length - 250));
    }

    try {
      await this.executeCommitment(state);
    } catch (err) {
      console.error(`[Executor] Failed to execute "${state.what}":`, err);
      try {
        const reason = err instanceof Error ? err.message : 'Execution failed';
        updateCommitmentStatus(state.commitmentId, 'failed', reason);
      } catch { /* ignore */ }
    }
  }

  private async executeCommitment(state: ExecutionState): Promise<void> {
    console.log(`[Executor] Executing: "${state.what}"`);

    // Mark as active
    try {
      updateCommitmentStatus(state.commitmentId, 'active');
    } catch { /* ignore */ }

    // Build a mandatory execution prompt
    const prompt = [
      '[COMMITMENT EXECUTION — MANDATORY]',
      '',
      `You previously committed to: "${state.what}"`,
      'This commitment is now due. Execute it NOW using your tools.',
      '',
      'Instructions:',
      '1. Use your available tools (browser, terminal, file operations) to complete this task.',
      '2. Be thorough — actually perform the work, don\'t just describe it.',
      '3. Gated actions (commands that change the machine, file writes, app control, deletions, installs, settings, messages, email, payments) stop automatically for the user\'s approval and return [AWAITING_APPROVAL]. Do the autonomous part first, then make the call; if it is awaiting approval, say so and stop. Do NOT write "APPROVAL REQUIRED" yourself and do not claim the action was done.',
      '4. After completion, summarize what you did.',
      '5. If the task is impossible or unclear, explain why and suggest alternatives.',
      '',
      'BEGIN EXECUTION.',
    ].join('\n');

    const response = await this.agentService!.handleMessage(prompt, 'system');

    // Broadcast the execution result
    this.broadcast?.({
      type: 'chat',
      payload: {
        text: response ?? 'Task executed (no response).',
        source: 'proactive',
      },
      priority: 'normal',
      timestamp: Date.now(),
    });

    const resultSummary = response
      ? response.length > 500 ? response.slice(0, 497) + '...' : response
      : 'Executed successfully';

    // A turn that stopped on an approval request did not do the work. Park
    // the commitment as active, remember which requests it is waiting on,
    // and let settleAwaitingApprovals() close it from their outcome instead
    // of recording it as done on the strength of a request that may still
    // be denied or expire.
    const requestIds = this.agentService?.lastTurnApprovalIds?.() ?? [];
    if (requestIds.length > 0) {
      this.awaitingApproval.set(state.commitmentId, { what: state.what, requestIds });
      try {
        // The request ids ride in the stored result so a restarted daemon can
        // pick the parked commitment back up instead of re-running it.
        updateCommitmentStatus(state.commitmentId, 'active', `${AWAITING_PREFIX}[req:${requestIds.join(',')}]: ${resultSummary}`);
      } catch (err) {
        console.error('[Executor] Failed to update commitment status:', err);
      }
      console.log(`[Executor] Awaiting approval (${requestIds.length} request(s)): "${state.what}"`);
      return;
    }

    try {
      updateCommitmentStatus(state.commitmentId, 'completed', resultSummary);
    } catch (err) {
      console.error('[Executor] Failed to update commitment status:', err);
    }

    console.log(`[Executor] Completed: "${state.what}"`);
  }
}
