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
 *
 * What a commitment can rely on:
 *   - It runs at its due time, not before: the announcement comes one cancel
 *     window ahead of it.
 *   - It runs at most once. Taking it to run is one statement in the store
 *     (claimCommitmentRun), so it is not run after it was closed, cancelled,
 *     re-dated or removed, and not a second time after a crash in the middle
 *     of its run: that one is closed as interrupted, and said so.
 *   - A cancel is written down. The commitment is closed, not just dropped
 *     from memory to be announced again by the next sweep.
 *   - While Jarvis is paused or stopped nothing is announced or run. What was
 *     announced is withdrawn, and announced again after Resume.
 *   - Listeners (`subscribe`) hear each step, with the time it will run.
 */

import { getDueCommitments, getUpcoming, updateCommitmentStatus, getCommitment, isWorkItemCommitment, parseParkedRequestIds, PARKED_RESULT_PREFIX, claimCommitmentRun, releaseCommitmentRun, getInterruptedCommitments } from '../vault/commitments.ts';
import { truncateText } from '../vault/commitment-text.ts';
import type { Commitment } from '../vault/commitments.ts';
import { runWithAdmission } from '../llm/background-budget.ts';
import { activeEmergencyState } from '../authority/emergency.ts';
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
  /**
   * The due time it was announced for. If the row's has changed since, it is
   * not run on this announcement. Absent: the due time is not compared.
   */
  whenDue?: number | null;
};

/** What the executor tells its listeners. `fireAt` is when it will run, on the wall clock; null means never by itself. */
export type CommitmentEvent =
  | { type: 'announced'; commitmentId: string; what: string; whenDue: number | null; fireAt: number | null }
  /** The person cancelled it inside its window. It is closed and will not run. */
  | { type: 'cancelled'; commitmentId: string; what: string }
  /** Announced, then not run on that announcement: Jarvis was paused, or the task was closed, re-dated or removed. */
  | { type: 'withdrawn'; commitmentId: string; what: string; reason: 'paused' | 'changed' }
  | { type: 'started'; commitmentId: string; what: string }
  /** `parked`: the turn stopped on an approval, and the commitment closes from its outcome. */
  | { type: 'finished'; commitmentId: string; what: string; status: 'completed' | 'failed' | 'parked'; result: string }
  /** Found at start: a process took it to run and stopped in the middle. It is closed, not run again. */
  | { type: 'interrupted'; commitmentId: string; what: string };

/** Runs a commitment directly, in place of a model turn. Comes back with its result text. */
export type CommitmentRunner = (commitment: Commitment) => Promise<string> | string;

/** What a commitment a restart interrupted is closed with. */
export const INTERRUPTED_RESULT = 'Interrupted by a restart. It may have partly run, so it was not run again.';
/** What a commitment the person cancelled inside its window is closed with. */
export const CANCELLED_RESULT = 'Cancelled by user';

export type BroadcastFn = (msg: WSMessage) => void;

const CANCEL_WINDOW: Record<Aggressiveness, number> = {
  passive: Infinity,
  moderate: 30_000,
  aggressive: 5_000,
};

/** Minimal view of an approval request the executor needs to settle a commitment. */
export type ApprovalLookup = (requestId: string) => { status: string; execution_result: string | null } | null;

// The parked-result marker lives with the store (#1115), which keeps every
// other writer from forging it; re-exported for the callers that read it here.
export { parseParkedRequestIds } from '../vault/commitments.ts';

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
  /**
   * Announcements waiting for their moment: a commitment found ahead of its
   * due time is announced one cancel window before it, so that it runs when
   * it is due and not up to two minutes early.
   */
  private announceTimers: Map<string, { timer: Timer; whenDue: number | null }> = new Map();
  private aggressiveness: Aggressiveness;
  private running = false;
  /** Jarvis is paused or stopped: nothing is announced or run. */
  private held = false;
  private readonly listeners = new Set<(event: CommitmentEvent) => void>();
  /** Commitments run directly, by where they were created from. */
  private readonly originRunners = new Map<string, CommitmentRunner>();

  constructor(aggressiveness: Aggressiveness = 'moderate') {
    this.aggressiveness = aggressiveness;
  }

  setAgentService(agent: IAgentService): void {
    this.agentService = agent;
  }

  /**
   * Hears each step of each commitment. Returns the unsubscribe. A listener
   * that throws is logged and does not stop the others, or the executor.
   */
  subscribe(listener: (event: CommitmentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: CommitmentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[Executor] A listener failed:', err);
      }
    }
  }

  /**
   * Commitments created from `origin` are run by `run` in place of a model
   * turn. `created_from` cannot be set through the HTTP route or the model's
   * tool, so only code inside the daemon can make such a commitment.
   */
  setOriginRunner(origin: string, run: CommitmentRunner): void {
    this.originRunners.set(origin, run);
  }

  /** Whether there is anything that could run this commitment right now. */
  private canRun(commitment: Pick<Commitment, 'created_from'>): boolean {
    return this.agentService !== null
      || (commitment.created_from !== null && this.originRunners.has(commitment.created_from));
  }

  private isHeld(): boolean {
    return this.held || activeEmergencyState() !== 'normal';
  }

  /**
   * Told when Jarvis is paused, stopped, or running again. Paused or stopped:
   * every announced commitment is withdrawn, so nothing fires into a system
   * that refuses its tools and then records the refusal as "done". Running
   * again: the sweep runs at once, and each is announced with a fresh window.
   */
  onEmergency(state: 'normal' | 'paused' | 'killed'): void {
    if (state === 'normal') {
      const was = this.held;
      this.held = false;
      if (was && this.running) this.checkAndAnnounce();
      return;
    }
    this.held = true;
    for (const timer of this.executeTimers.values()) clearTimeout(timer);
    this.executeTimers.clear();
    for (const { timer } of this.announceTimers.values()) clearTimeout(timer);
    this.announceTimers.clear();
    for (const state of this.pending.values()) {
      if (!state.cancelled && !state.executed) {
        this.emit({ type: 'withdrawn', commitmentId: state.commitmentId, what: state.what, reason: 'paused' });
      }
    }
    this.pending.clear();
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
        if (isWorkItemCommitment(commitmentId)) {
          this.awaitingApproval.delete(commitmentId);
          continue;
        }
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
          const summary = truncateText(results.join('\n'), 500) || 'Approved and executed';
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

    // What a process took to run and never closed was interrupted in the
    // middle. It is not run again: it may have sent what it was to send.
    this.closeInterrupted();

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
    for (const { timer } of this.announceTimers.values()) clearTimeout(timer);
    this.announceTimers.clear();
    console.log('[Executor] Stopped');
  }

  /**
   * Closes commitments a previous process left in the middle of their run,
   * and tells the listeners. Called once, at start, before anything can be
   * running in this process.
   */
  private closeInterrupted(): void {
    try {
      for (const commitment of getInterruptedCommitments()) {
        if (isWorkItemCommitment(commitment.id)) continue;
        updateCommitmentStatus(commitment.id, 'failed', INTERRUPTED_RESULT);
        this.executedIds.add(commitment.id);
        console.warn(`[Executor] "${commitment.what}" was interrupted by a restart; closed, not run again`);
        this.emit({ type: 'interrupted', commitmentId: commitment.id, what: commitment.what });
      }
    } catch (err) {
      console.error('[Executor] Could not close interrupted commitments:', err);
    }
  }

  /**
   * Check for commitments that are due or due within 2 minutes. Announces
   * each new candidate for execution and publishes one-shot
   * `commitment.overdue` / `commitment.due_soon` workflow events so `on_event`
   * triggers fire on transitions (not every poll).
   */
  checkAndAnnounce(): void {
    this.settleAwaitingApprovals();
    // Paused or stopped: nothing new is announced. The sweep after Resume
    // finds everything that came due in the meantime.
    if (this.isHeld()) return;
    try {
      const now = Date.now();
      const dueNow = getDueCommitments({ excludeWorkItems: true }); // when_due <= now
      const upcoming = getUpcoming(20, { excludeWorkItems: true }); // all upcoming with when_due

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

        // Taken to run already: it is running now, or it is parked, or it was
        // interrupted and closed at start. Never a second run.
        if (commitment.started_at !== null) continue;
        // Nothing here could run it (no agent yet, and no runner for where it
        // came from): announcing it would promise a run that cannot happen.
        // In passive mode nothing is ever run, and the announcement is all.
        if (this.aggressiveness !== 'passive' && !this.canRun(commitment)) continue;

        this.announceWhenItsTime(commitment, now);
      }
    } catch (err) {
      console.error('[Executor] Check error:', err);
    }
  }

  /**
   * Announces a commitment one cancel window before it is due, so that it
   * runs at its due time. One already due, or closer than a window, is
   * announced now.
   */
  private announceWhenItsTime(commitment: Commitment, now: number): void {
    const cancelWindow = CANCEL_WINDOW[this.aggressiveness];
    const lead = cancelWindow === Infinity ? 0 : cancelWindow;
    const announceAt = commitment.when_due === null ? now : commitment.when_due - lead;
    if (announceAt <= now) {
      this.announceExecution(commitment);
      return;
    }
    const waiting = this.announceTimers.get(commitment.id);
    if (waiting) {
      if (waiting.whenDue === commitment.when_due) return;
      // Re-dated while it waited: the old moment is no longer the one.
      clearTimeout(waiting.timer);
    }
    const timer = setTimeout(() => {
      this.announceTimers.delete(commitment.id);
      if (!this.running || this.isHeld()) return;
      try {
        // As it is now: closed, re-dated or removed in the meantime, it is not announced.
        const current = getCommitment(commitment.id);
        if (!current || (current.status !== 'pending' && current.status !== 'active')) return;
        if (current.when_due !== commitment.when_due || current.started_at !== null) return;
        if (this.pending.has(current.id) || this.executedIds.has(current.id)) return;
        this.announceExecution(current);
      } catch (err) {
        console.error('[Executor] Announce error:', err);
      }
    }, announceAt - now);
    this.announceTimers.set(commitment.id, { timer, whenDue: commitment.when_due });
  }

  /**
   * Cancel a pending execution. Returns true if successfully cancelled.
   */
  cancelExecution(commitmentId: string): boolean {
    const state = this.pending.get(commitmentId);
    if (!state || state.executed || state.cancelled) return false;

    state.cancelled = true;
    console.log(`[Executor] Cancelled execution: ${state.what}`);

    // Written down, not only remembered: the row is still open and due, so
    // without this the next sweep would announce it again and it would run.
    // Left alone if someone closed it in the meantime; their word stands.
    try {
      const current = getCommitment(commitmentId);
      if (current && (current.status === 'pending' || current.status === 'active') && current.started_at === null) {
        updateCommitmentStatus(commitmentId, 'failed', CANCELLED_RESULT);
      }
    } catch (err) {
      console.error('[Executor] Could not record the cancellation:', err);
    }
    this.executedIds.add(commitmentId);

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
    this.emit({ type: 'cancelled', commitmentId, what: state.what });
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
      // A full window from now, and never before it is due.
      cancelDeadline: cancelWindow === Infinity ? Infinity : Math.max(now + cancelWindow, commitment.when_due ?? 0),
      cancelled: false,
      executed: false,
      whenDue: commitment.when_due,
    };

    this.pending.set(commitment.id, state);
    const windowSec = state.cancelDeadline === Infinity ? 0 : Math.max(1, Math.round((state.cancelDeadline - now) / 1000));

    if (this.aggressiveness === 'passive') {
      console.log(`[Executor] Announced (passive, no auto-execute): ${commitment.what}`);
    } else {
      console.log(`[Executor] Announced: "${commitment.what}" — executing in ${windowSec}s unless cancelled`);
    }
    this.emit({
      type: 'announced', commitmentId: commitment.id, what: commitment.what, whenDue: commitment.when_due,
      fireAt: state.cancelDeadline === Infinity ? null : state.cancelDeadline,
    });

    // Broadcast announcement to all WebSocket clients
    this.broadcast?.({
      type: 'notification',
      payload: {
        source: 'commitment_executor',
        action: 'pending_execution',
        commitmentId: commitment.id,
        what: commitment.what,
        executeAt: state.cancelDeadline === Infinity ? null : state.cancelDeadline,
        cancelWindowMs: state.cancelDeadline === Infinity ? null : state.cancelDeadline - now,
      },
      timestamp: now,
    });

    // Also broadcast as a chat message so the user sees it
    this.broadcast?.({
      type: 'chat',
      payload: {
        text: this.aggressiveness === 'passive'
          ? `Task due: "${commitment.what}". Waiting for your instruction to proceed.`
          : `Executing "${commitment.what}" in ${windowSec}s. Send cancel to abort.`,
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
    if (state.cancelled || state.executed || isWorkItemCommitment(commitmentId)) {
      this.pending.delete(commitmentId);
      return;
    }
    // Paused or stopped since it was announced: it does not run into a
    // system that refuses its tools. It stays open and is announced again
    // after Resume.
    if (this.isHeld()) {
      this.pending.delete(commitmentId);
      this.emit({ type: 'withdrawn', commitmentId, what: state.what, reason: 'paused' });
      return;
    }
    let row: Commitment | null;
    try {
      row = getCommitment(commitmentId);
    } catch {
      row = null;
    }
    if (row && !this.canRun(row)) return;

    // The one statement that decides whether this runs. It fails when the
    // task was closed, cancelled, removed or re-dated since the announcement,
    // or was already taken: then nothing runs.
    let claimed: Commitment | null;
    try {
      claimed = claimCommitmentRun(commitmentId, state.whenDue === undefined ? {} : { whenDue: state.whenDue });
    } catch (err) {
      console.error(`[Executor] Could not take "${state.what}" to run it:`, err);
      claimed = null;
    }
    if (!claimed) {
      this.pending.delete(commitmentId);
      console.log(`[Executor] Not run, it changed since it was announced: "${state.what}"`);
      this.emit({ type: 'withdrawn', commitmentId, what: state.what, reason: 'changed' });
      return;
    }

    state.executed = true;
    // What it says now, not what it said when it was announced.
    state.what = claimed.what;
    this.pending.delete(commitmentId);
    this.executedIds.add(commitmentId);

    // Cap executedIds memory
    if (this.executedIds.size > 500) {
      const arr = Array.from(this.executedIds);
      this.executedIds = new Set(arr.slice(arr.length - 250));
    }

    this.emit({ type: 'started', commitmentId, what: state.what });
    try {
      await this.executeCommitment(state, claimed);
    } catch (err) {
      console.error(`[Executor] Failed to execute "${state.what}":`, err);
      const reason = err instanceof Error ? err.message : 'Execution failed';
      try {
        updateCommitmentStatus(state.commitmentId, 'failed', reason);
      } catch { /* ignore */ }
      this.emit({ type: 'finished', commitmentId, what: state.what, status: 'failed', result: reason });
    }
  }

  private async executeCommitment(state: ExecutionState, commitment: Commitment): Promise<void> {
    console.log(`[Executor] Executing: "${state.what}"`);

    // Already marked active: taking it to run did that (claimCommitmentRun).

    // Run directly, when where it came from has a runner: no model turn.
    const direct = commitment.created_from !== null ? this.originRunners.get(commitment.created_from) : undefined;
    if (direct) {
      const result = truncateText(String(await direct(commitment)), 500) || 'Executed successfully';
      updateCommitmentStatus(state.commitmentId, 'completed', result);
      console.log(`[Executor] Completed: "${state.what}"`);
      this.emit({ type: 'finished', commitmentId: state.commitmentId, what: state.what, status: 'completed', result });
      return;
    }

    // Build a mandatory execution prompt
    const prompt = [
      '[COMMITMENT EXECUTION — MANDATORY]',
      '',
      // JSON-encoded (#1115): the task text is data, and a quote in it closed
      // the quoting this line used to rely on.
      `You previously committed to: ${JSON.stringify(state.what)}`,
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

    // The `commitments` scope gap (#561, #571), stated where it happens rather
    // than only in a module doc.
    //
    // A commitment created in a project-scoped site chat now RECORDS that
    // scope (`commitments.scope_id`, stamped by ws-service). This turn still
    // does not run under it, and that is a decision rather than an oversight:
    // the executor's agentService is the BackgroundAgentService, which owns a
    // separate AgentOrchestrator and a separate tool registry built in its own
    // `start()` -- and the site-builder tools are registered only into the
    // MAIN orchestrator's registry (daemon/index.ts). So applying
    // PROJECT_SITE_CHAT_SCOPE here would withhold the four generic file and
    // shell tools with nothing to substitute: the pinned `site-builder`
    // category is empty on this registry, so a due "deploy the site" would be
    // handed no file tool of any kind. That is worse than the gap.
    //
    // Closing it properly needs one of: registering the site tools on the
    // background registry (a real behaviour expansion -- those tools would
    // become reachable from every background turn, under a different authority
    // profile, and #570 rated a site build-file write as execution), or
    // routing a scoped commitment through the main orchestrator instead. Both
    // are their own change.
    //
    // What partly holds the line meanwhile is the background authority
    // profile: `execute_command` and `write_data` are in
    // DEFAULT_BACKGROUND_GOVERNED, so a commitment that reaches for the shell
    // or writes a file stops for the user's approval.
    //
    // Two limits on that, stated because it would be easy to read the sentence
    // above as "covered". First, `read_data` is NOT in that list
    // (authority/background-profile.ts) and the background registry does
    // register the generic readers, so a model-written commitment like "read
    // the notes in ~/... and add them to the site tomorrow" performs an
    // unframed, untainting read on a later turn with no gate at all -- which is
    // consequence one of #561, the one this scope exists to remove. Second, an
    // explicit `authority.background.governed_categories: []` is a valid
    // opt-out, so the control can be configured away entirely.
    //
    // Hence the log line: a scoped commitment executing unscoped is visible
    // rather than silent. It is not a substitute for either fix above.
    const commitmentScopeId = (() => {
      try { return getCommitment(state.commitmentId)?.scope_id ?? null; } catch { return null; }
    })();
    if (commitmentScopeId) {
      console.warn(`[Executor] commitment ${state.commitmentId} was created under tool scope `
        + `"${commitmentScopeId}" but executes on the background agent, which does not carry it (#571). `
        + 'The background authority profile is the control for this turn.');
    }

    // A commitment is work the person scheduled, run at most once: exempt from
    // the background budget (src/llm/background-budget.ts), so a busy chat or
    // a spent daily allowance cannot fail it. Origin stays `background`.
    const response = await runWithAdmission('exempt', () => this.agentService!.handleMessage(prompt, 'system'));

    // The turn never began: the process is shutting down. Nothing was done,
    // so it is given back, and the next start runs it. Recorded as done, it
    // would be a promise silently not kept.
    if (response === 'skipped: draining') {
      releaseCommitmentRun(state.commitmentId);
      this.executedIds.delete(state.commitmentId);
      console.log(`[Executor] Not run, shutting down; it will run after the restart: "${state.what}"`);
      this.emit({ type: 'withdrawn', commitmentId: state.commitmentId, what: state.what, reason: 'changed' });
      return;
    }
    // The turn threw, and the background agent handed the error back as text.
    // That is a failure, not a result.
    if (typeof response === 'string' && response.startsWith('Error: ')) {
      throw new Error(truncateText(response.slice('Error: '.length), 500) || 'Execution failed');
    }

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

    // Cut on a code point boundary: `slice` could split a surrogate pair.
    const resultSummary = response ? truncateText(response, 500) : 'Executed successfully';

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
        updateCommitmentStatus(state.commitmentId, 'active', `${PARKED_RESULT_PREFIX}[req:${requestIds.join(',')}]: ${resultSummary}`, { parked: true });
      } catch (err) {
        console.error('[Executor] Failed to update commitment status:', err);
      }
      console.log(`[Executor] Awaiting approval (${requestIds.length} request(s)): "${state.what}"`);
      this.emit({ type: 'finished', commitmentId: state.commitmentId, what: state.what, status: 'parked', result: resultSummary });
      return;
    }

    try {
      updateCommitmentStatus(state.commitmentId, 'completed', resultSummary);
    } catch (err) {
      console.error('[Executor] Failed to update commitment status:', err);
    }

    console.log(`[Executor] Completed: "${state.what}"`);
    this.emit({ type: 'finished', commitmentId: state.commitmentId, what: state.what, status: 'completed', result: resultSummary });
  }
}
