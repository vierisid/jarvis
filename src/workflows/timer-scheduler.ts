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

import { getWorkflowDb } from './db/index.ts';
import { enqueue } from './db/repos/job-queue.ts';
import { getFlowRun } from './db/repos/flow-run.ts';
import { listDueTimerWaitpoints, markWaitpointResumed } from './db/repos/waitpoint.ts';

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
    let resumed = 0;
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
        // Only PAUSED runs are resumable; for anything else, retire the
        // waitpoint so it isn't re-scanned every tick.
        if (!run || run.status !== 'PAUSED') {
          markWaitpointResumed(wp.id, now);
          continue;
        }
        // Mark-resumed + enqueue ATOMICALLY: a crash between the two would
        // otherwise leave the waitpoint retired with no RESUME job -> run stuck
        // PAUSED forever. The unique `WHERE resumed_at IS NULL` also stops a
        // concurrent tick from double-enqueuing.
        const enqueued = getWorkflowDb().transaction(() => {
          if (!markWaitpointResumed(wp.id, now)) return false; // lost the race
          enqueue({
            jobType: 'RUN_FLOW',
            payload: { runId: wp.flowRunId, executionType: 'RESUME', resumePayload: {} },
            flowRunId: wp.flowRunId,
            maxAttempts: 1, // re-resuming an already-resumed waitpoint would walk past it
          });
          return true;
        })();
        if (enqueued) resumed++;
      } catch (e) {
        console.error(`[TimerScheduler] resume failed for waitpoint ${wp.id}:`, e);
      }
    }
    return resumed;
  }
}
