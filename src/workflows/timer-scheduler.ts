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

  /** Resume every currently-due TIMER waitpoint. Returns how many were resumed. */
  tick(now: number = Date.now()): number {
    let resumed = 0;
    for (const wp of listDueTimerWaitpoints(new Date(now).toISOString())) {
      const run = getFlowRun(wp.flowRunId);
      // Only PAUSED runs are resumable; for anything else, retire the waitpoint
      // so it isn't re-scanned every tick.
      if (!run || run.status !== 'PAUSED') {
        markWaitpointResumed(wp.id, now);
        continue;
      }
      // Claim-then-enqueue: marking resumed first (unique on resumed_at IS NULL)
      // keeps a double tick from enqueuing the same resume twice.
      if (!markWaitpointResumed(wp.id, now)) continue;
      enqueue({
        jobType: 'RUN_FLOW',
        payload: { runId: wp.flowRunId, executionType: 'RESUME', resumePayload: {} },
        flowRunId: wp.flowRunId,
        maxAttempts: 1, // re-resuming an already-resumed waitpoint would walk past it
      });
      resumed++;
    }
    return resumed;
  }
}
