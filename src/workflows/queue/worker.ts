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
  type Job,
} from "../db/repos/job-queue";

export type JobHandler<P = Record<string, unknown>> = (job: Job<P>) => Promise<void>;

export interface WorkerOptions {
  /** Map of job_type -> async handler. Throwing inside a handler triggers retry/fail. */
  handlers: Record<string, JobHandler>;
  /** Idle poll interval; lower = lower latency, higher CPU. Default 250ms. */
  pollIntervalMs?: number;
  /** Lease for a claimed job. If a worker dies mid-job the lease lapses and another claim picks it up. */
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
      let claimed: Job | null = null;
      try {
        claimed = claimNextJob({ leaseMs: this.leaseMs });
      } catch (e) {
        this.log(`loop ${idx}: claim error: ${(e as Error).message}`);
      }
      if (!claimed) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      await this.handle(claimed);
    }
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
      completeJob(job.id);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.log(`job ${job.id} (${job.jobType}) failed: ${msg}`);
      try {
        const willRetry = failJob(job.id, msg);
        if (willRetry) this.log(`job ${job.id} requeued for retry (attempt ${job.attempt + 1}/${job.maxAttempts})`);
      } catch (failErr) {
        this.log(`job ${job.id}: failJob errored: ${(failErr as Error).message}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
