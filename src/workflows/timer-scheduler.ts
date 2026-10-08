/**
 * TIMER-waitpoint scheduler (UPDATES.md graceful-drain resume).
 *
 * A workflow `delay`/`wait` step parks the run at PAUSED with a TIMER waitpoint
 * carrying a `resume_date_time`. WEBHOOK/MANUAL waitpoints resume when their URL
 * is hit, but a TIMER has no external trigger — so without this tick a timer
 * that elapses (including entirely during a restart's downtime) never fires.
 * This periodically finds due TIMER waitpoints and enqueues their RESUME job,
 * exactly as the resume webhook route does.
 */

import { getFlowRun } from './db/repos/flow-run.ts';
import { listDueTimerWaitpoints, markWaitpointResumed } from './db/repos/waitpoint.ts';
import { stopTurnedOffRun, turnedOffReason } from './db/repos/flow-turn-off.ts';
import { resumeResolvedWorkflowEffects } from './runtime/effect-approval-scheduler';
import { claimContinuation, releaseEmergencyHolds } from './runtime/continuation';
import { emergencyHold } from './runtime/emergency-hold';

export class TimerWaitpointScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs = 15_000) {}

  start(): void {
    if (this.timer) return;
    this.tick(); // fire once now so a due-during-downtime timer resumes at boot
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resume every currently-due TIMER waitpoint. Returns how many were resumed.
   * Never throws (runs on a setInterval — a throw would become an
   * uncaughtException and take the daemon down); per-waitpoint errors are logged
   * and skipped.
   */
  tick(now: number = Date.now()): number {
    // Paused or stopped: no timer, approval or held step wakes anything; they
    // wait for Resume (Q-08).
    if (emergencyHold()) return 0;
    let resumed = 0;
    try { resumed += releaseEmergencyHolds(now); }
    catch (error) { console.error('[Workflow emergency] releasing held steps failed:', error); }
    try { resumed += resumeResolvedWorkflowEffects(); }
    catch (error) { console.error('[Workflow Authority] approval recovery failed:', error); }
    let due;
    try {
      due = listDueTimerWaitpoints(new Date(now).toISOString());
    } catch (e) {
      console.error('[TimerScheduler] scan failed:', e);
      return 0;
    }
    for (const wp of due) {
      try {
        const run = getFlowRun(wp.flowRunId);
        // A waitpoint can become due before the engine publishes PAUSED.
        // Keep it pending until that upload lands; only missing or finished
        // runs can safely have their timers retired.
        if (run?.status === 'RUNNING' || run?.status === 'QUEUED') continue;
        if (!run || run.status !== 'PAUSED') {
          markWaitpointResumed(wp.id, now);
          continue;
        }
        // A workflow turned off since this run began does not wake it: the
        // run is stopped instead (Q-06).
        if (turnedOffReason(run.id)) {
          stopTurnedOffRun(run.flowId, run.id);
          continue;
        }
        // Consume + enqueue + record ATOMICALLY: a crash between them would
        // otherwise leave the waitpoint retired with no RESUME job -> run stuck
        // PAUSED forever. A continuation already queued for the run keeps this
        // timer for the next tick; a timer whose step already finished is
        // retired rather than waking the run's next pause.
        if (claimContinuation({ runId: run.id, waitpoint: wp, kind: 'timer', resumePayload: {}, now }) === 'resumed') resumed++;
      } catch (e) {
        console.error(`[TimerScheduler] resume failed for waitpoint ${wp.id}:`, e);
      }
    }
    return resumed;
  }
}
