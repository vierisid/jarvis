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

import { getDueCommitments, getUpcoming, updateCommitmentStatus } from '../vault/commitments.ts';
import type { Commitment } from '../vault/commitments.ts';
import type { IAgentService } from './agent-service-interface.ts';
import type { WSMessage } from '../comms/websocket.ts';

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

export class CommitmentExecutor {
  private agentService: IAgentService | null = null;
  private broadcast: BroadcastFn | null = null;
  private pending: Map<string, ExecutionState> = new Map();
  private executedIds: Set<string> = new Set();
  private checkTimer: Timer | null = null;
  private tickTimer: Timer | null = null;
  private aggressiveness: Aggressiveness;
  private running = false;

  constructor(aggressiveness: Aggressiveness = 'moderate') {
    this.aggressiveness = aggressiveness;
  }

  setAgentService(agent: IAgentService): void {
    this.agentService = agent;
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Check for due commitments every 60 seconds
    this.checkTimer = setInterval(() => {
      this.checkAndAnnounce();
    }, 60_000);

    // Tick pending executions every 5 seconds
    this.tickTimer = setInterval(() => {
      this.tickExecutions().catch((err) =>
        console.error('[Executor] Tick error:', err)
      );
    }, 5_000);

    // Run an immediate check
    this.checkAndAnnounce();

    console.log(`[Executor] Started (mode: ${this.aggressiveness})`);
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.log('[Executor] Stopped');
  }

  /**
   * Check for commitments that are due or due within 2 minutes.
   * Announce each one as a pending execution.
   */
  checkAndAnnounce(): void {
    try {
      const now = Date.now();
      const dueNow = getDueCommitments(); // when_due <= now
      const upcoming = getUpcoming(20); // all upcoming with when_due

      // Filter upcoming to those due within 2 minutes
      const dueSoon = upcoming.filter(
        (c) => c.when_due && c.when_due > now && c.when_due <= now + 2 * 60_000
      );

      const candidates = [...dueNow, ...dueSoon];

      for (const commitment of candidates) {
        // Skip if already announced, executed, or terminal status
        if (this.pending.has(commitment.id)) continue;
        if (this.executedIds.has(commitment.id)) continue;
        if (commitment.status === 'completed' || commitment.status === 'failed') continue;

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
  }

  private async tickExecutions(): Promise<void> {
    if (!this.agentService) return;

    const now = Date.now();

    for (const [id, state] of this.pending) {
      if (state.cancelled || state.executed) {
        this.pending.delete(id);
        continue;
      }

      // Check if cancel window has expired
      if (now < state.cancelDeadline) continue;

      // Execute!
      state.executed = true;
      this.pending.delete(id);
      this.executedIds.add(id);

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
      '3. **Intent Gating still applies.** If this task involves sending email/messages, payments, installs, destructive ops, or any other gated category, you MUST call `request_approval` first and wait for `[APPROVED]` before acting. Do NOT write "APPROVAL REQUIRED" yourself — always use the tool.',
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

    // Mark commitment as completed
    const resultSummary = response
      ? response.length > 500 ? response.slice(0, 497) + '...' : response
      : 'Executed successfully';

    try {
      updateCommitmentStatus(state.commitmentId, 'completed', resultSummary);
    } catch (err) {
      console.error('[Executor] Failed to update commitment status:', err);
    }

    console.log(`[Executor] Completed: "${state.what}"`);
  }
}
