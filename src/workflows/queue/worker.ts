/**
 * In-process worker that polls the SQLite job queue and dispatches each
 * claimed job to a registered handler.
 *
 * Replaces BullMQ's worker pattern. One Worker instance per Jarvis daemon is
 * enough for the personal-AI scale we're targeting; if we ever need more
 * parallelism, increasing `concurrency` in start() lets us run several claim
 * loops in parallel within the same process.
 *
 * Lifecycle:
 *   const worker = new Worker({ handlers: { RUN_FLOW: ... } });
 *   await worker.start({ concurrency: 2 });
 *   // ... daemon runs ...
 *   await worker.stop();
 */

import {
  claimNextJob,
  completeJob,
  failJob,
  getJob,
  type Job,
} from "../db/repos/job-queue";
import { emergencyHold } from "../runtime/emergency-hold";
import { noteStorageFailure, probeStorage, storageStatus } from "../../vault/storage-health";

export type JobHandler<P = Record<string, unknown>> = (job: Job<P>) => Promise<void>;

export interface WorkerOptions {
  /** Map of job_type -> async handler. Throwing inside a handler triggers retry/fail. */
  handlers: Record<string, JobHandler>;
  /** Idle poll interval; lower = lower latency, higher CPU. Default 250ms. */
  pollIntervalMs?: number;
  /** Lease for retryable jobs. Workflow execution claims are never reassigned. */
  leaseMs?: number;
  /** Optional logger; defaults to console. Pass a no-op to silence. */
  log?: (line: string) => void;
}

export interface StartOptions {
  /** Number of parallel claim loops. Default 1. */
  concurrency?: number;
}

export class Worker {
  private readonly handlers: Record<string, JobHandler>;
  private readonly pollIntervalMs: number;
  /** Per-loop wait while storage is not writable: 1 s, doubling to 10 s. */
  private readonly storageBackoffMs = new Map<number, number>();
  private readonly leaseMs: number | undefined;
  private readonly log: (line: string) => void;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(opts: WorkerOptions) {
    this.handlers = opts.handlers;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.leaseMs = opts.leaseMs;
    this.log = opts.log ?? ((line) => console.log(`[workflow-worker] ${line}`));
  }

  /** Start `concurrency` claim loops. Resolves immediately; loops run until stop(). */
  start(opts: StartOptions = {}): void {
    if (this.running) return;
    this.running = true;
    const concurrency = Math.max(1, opts.concurrency ?? 1);
    for (let i = 0; i < concurrency; i++) {
      this.loops.push(this.runLoop(i));
    }
    this.log(`started with concurrency=${concurrency} pollIntervalMs=${this.pollIntervalMs}`);
  }

  /** Stop accepting new jobs and wait for in-flight loops to drain. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
    this.log("stopped");
  }

  /**
   * Drain mode for tests / one-shot processing: process every ready job once
   * and return. Returns when claimNextJob returns null. Yields to the event
   * loop between iterations so a synchronous handler doesn't pin the
   * interpreter.
   *
   * Caller must not have called start() (or must have stopped it).
   */
  async drain(): Promise<number> {
    let processed = 0;
    while (true) {
      // Paused or stopped: queued work waits (Q-08).
      if (emergencyHold()) return processed;
      const job = claimNextJob({ leaseMs: this.leaseMs });
      if (!job) return processed;
      await this.handle(job);
      processed++;
      // Yield to the event loop. If `handle` was synchronous (handler awaited
      // nothing), we'd otherwise tight-loop and starve other tasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async runLoop(idx: number): Promise<void> {
    while (this.running) {
      // Paused or stopped: claim nothing; queued work waits for Resume (Q-08).
      if (emergencyHold()) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      // Nothing can be saved (a full disk): claiming would fail four times a
      // second. Probe with one small write and back off until it works again.
      if (!storageStatus().writable && !probeStorage()) {
        await sleep(this.storageBackoff(idx));
        continue;
      }
      let claimed: Job | null = null;
      try {
        claimed = claimNextJob({ leaseMs: this.leaseMs });
        // Only a claim that worked ends the streak: a probe can pass on a
        // nearly full disk while the claim still fails.
        this.storageBackoffMs.delete(idx);
      } catch (e) {
        if (noteStorageFailure(e)) {
          // Once per streak, not on every probe-then-claim cycle.
          if (idx === 0 && !this.storageBackoffMs.has(idx)) this.log(`loop ${idx}: cannot save, so no job can be claimed: ${storageStatus().message}`);
          await sleep(this.storageBackoff(idx));
          continue;
        }
        this.log(`loop ${idx}: claim error: ${(e as Error).message}`);
      }
      if (!claimed) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      await this.handle(claimed);
    }
  }

  private storageBackoff(idx: number): number {
    const next = Math.min((this.storageBackoffMs.get(idx) ?? 500) * 2, 10_000);
    this.storageBackoffMs.set(idx, next);
    return next;
  }

  private async handle(job: Job): Promise<void> {
    const handler = this.handlers[job.jobType];
    if (!handler) {
      const msg = `no handler registered for jobType=${job.jobType}`;
      this.log(`job ${job.id}: ${msg}`);
      try {
        failJob(job.id, msg);
      } catch (e) {
        this.log(`job ${job.id}: failJob errored: ${(e as Error).message}`);
      }
      return;
    }
    try {
      await handler(job);
      // Cancellation is terminal queue bookkeeping, not a handler failure.
      if (getJob(job.id)?.status === "RUNNING") completeJob(job.id);
    } catch (e) {
      // A run that could not record its work (a full disk) stops further
      // claims: the loop probes before claiming again, so no new work starts
      // that could not be recorded either. A claim alone can still fit on a
      // disk where the run's own writes do not.
      noteStorageFailure(e);
      if (getJob(job.id)?.status === "CANCELED") return;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.log(`job ${job.id} (${job.jobType}) failed: ${msg}`);
      try {
        const willRetry = failJob(job.id, msg);
        if (willRetry) this.log(`job ${job.id} requeued for retry (attempt ${job.attempt + 1}/${job.maxAttempts})`);
      } catch (failErr) {
        noteStorageFailure(failErr);
        this.log(`job ${job.id}: failJob errored: ${(failErr as Error).message}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
