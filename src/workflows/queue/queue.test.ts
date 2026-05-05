import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import {
  cancelJob,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  getJob,
  queueStats,
} from "../db/repos/job-queue";
import { Worker } from "./worker";

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

const silent = () => undefined;

describe("job-queue repo", () => {
  test("enqueue + claim + complete happy path", () => {
    const j = enqueue({ jobType: "TEST", payload: { foo: 1 } });
    expect(j.status).toBe("QUEUED");
    expect(j.attempt).toBe(0);

    const claimed = claimNextJob<{ foo: number }>();
    expect(claimed?.id).toBe(j.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.payload.foo).toBe(1);

    completeJob(j.id);
    expect(getJob(j.id)?.status).toBe("SUCCEEDED");
  });

  test("priority + scheduled_at ordering", () => {
    const now = Date.now();
    const a = enqueue({ jobType: "T", payload: {}, priority: 1, scheduledAt: now });
    const b = enqueue({ jobType: "T", payload: {}, priority: 5, scheduledAt: now + 100 });
    const c = enqueue({ jobType: "T", payload: {}, priority: 5, scheduledAt: now });

    // Highest priority among ready (scheduled_at <= now): b is in the future,
    // c (priority=5, scheduled=now) wins over a (priority=1, scheduled=now).
    const first = claimNextJob({ now });
    expect(first?.id).toBe(c.id);
    const second = claimNextJob({ now });
    expect(second?.id).toBe(a.id);
    const third = claimNextJob({ now });
    expect(third).toBeNull(); // b is scheduled in the future

    const fourth = claimNextJob({ now: now + 1000 });
    expect(fourth?.id).toBe(b.id);
  });

  test("claim respects locked_until lease", () => {
    const j = enqueue({ jobType: "T", payload: {} });
    const claimed = claimNextJob({ leaseMs: 60_000 });
    expect(claimed?.id).toBe(j.id);
    // Same row should not be re-claimable while leased.
    expect(claimNextJob()).toBeNull();
  });

  test("expired lease lets another worker steal the job", () => {
    const j = enqueue({ jobType: "T", payload: {} });
    const now = Date.now();
    const first = claimNextJob({ leaseMs: 1, now });
    expect(first?.id).toBe(j.id);
    const second = claimNextJob({ now: now + 100 });
    expect(second?.id).toBe(j.id);
    expect(second?.attempt).toBe(2);
  });

  test("failJob retries with exponential backoff while attempts remain", () => {
    const now = Date.now();
    const j = enqueue({ jobType: "T", payload: {}, maxAttempts: 3 });
    const c1 = claimNextJob({ now });
    expect(c1?.attempt).toBe(1);

    const willRetry = failJob(j.id, "boom", { backoffMs: 1000, now });
    expect(willRetry).toBe(true);
    const after = getJob(j.id);
    expect(after?.status).toBe("QUEUED");
    expect(after?.lastError).toBe("boom");
    expect(after?.scheduledAt).toBe(now + 1000);

    // Not ready until backoff elapses.
    expect(claimNextJob({ now: now + 500 })).toBeNull();
    expect(claimNextJob({ now: now + 1000 })?.id).toBe(j.id);
  });

  test("failJob terminates as FAILED after maxAttempts", () => {
    const now = Date.now();
    const j = enqueue({ jobType: "T", payload: {}, maxAttempts: 2 });
    claimNextJob({ now });
    failJob(j.id, "first", { backoffMs: 1, now });
    claimNextJob({ now: now + 1 });
    const willRetry = failJob(j.id, "second", { backoffMs: 1, now: now + 1 });
    expect(willRetry).toBe(false);
    expect(getJob(j.id)?.status).toBe("FAILED");
  });

  test("cancelJob terminates QUEUED and RUNNING jobs", () => {
    const a = enqueue({ jobType: "T", payload: {} });
    cancelJob(a.id);
    expect(getJob(a.id)?.status).toBe("CANCELED");

    const b = enqueue({ jobType: "T", payload: {} });
    claimNextJob();
    cancelJob(b.id);
    expect(getJob(b.id)?.status).toBe("CANCELED");
  });

  test("queueStats reflects status counts", () => {
    enqueue({ jobType: "T", payload: {} });
    enqueue({ jobType: "T", payload: {} });
    const claimed = claimNextJob();
    if (claimed) completeJob(claimed.id);
    expect(queueStats()).toEqual({
      queued: 1,
      running: 0,
      succeeded: 1,
      failed: 0,
      canceled: 0,
    });
  });
});

describe("Worker", () => {
  test("drain processes all ready jobs and dispatches by jobType", async () => {
    const seen: string[] = [];
    const worker = new Worker({
      log: silent,
      handlers: {
        TYPE_A: async (job) => {
          seen.push(`A:${(job.payload as { x: number }).x}`);
        },
        TYPE_B: async (job) => {
          seen.push(`B:${(job.payload as { y: number }).y}`);
        },
      },
    });
    enqueue({ jobType: "TYPE_A", payload: { x: 1 } });
    enqueue({ jobType: "TYPE_B", payload: { y: 2 } });
    enqueue({ jobType: "TYPE_A", payload: { x: 3 } });

    const n = await worker.drain();
    expect(n).toBe(3);
    expect(seen.sort()).toEqual(["A:1", "A:3", "B:2"]);
    expect(queueStats()).toMatchObject({ succeeded: 3, queued: 0, running: 0 });
  });

  test("handler exception triggers retry; final failure marks FAILED", async () => {
    let calls = 0;
    const worker = new Worker({
      log: silent,
      handlers: {
        FLAKY: async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
      },
    });
    enqueue({ jobType: "FLAKY", payload: {}, maxAttempts: 2 });

    // First drain: claim, throw, requeue with backoff -> not ready immediately.
    await worker.drain();
    expect(queueStats()).toMatchObject({ queued: 1, failed: 0, succeeded: 0 });

    // Wait past the backoff (default 1s for attempt 1) to make it claimable.
    await Bun.sleep(1100);
    await worker.drain();
    expect(calls).toBe(2);
    expect(queueStats()).toMatchObject({ failed: 1, queued: 0, running: 0 });
  });

  test("missing handler marks job FAILED on first attempt", async () => {
    const worker = new Worker({ log: silent, handlers: {} });
    enqueue({ jobType: "UNKNOWN", payload: {}, maxAttempts: 1 });
    await worker.drain();
    expect(queueStats()).toMatchObject({ failed: 1 });
  });

  test("concurrency: each job is claimed and processed by exactly one loop", async () => {
    // Property-style: enqueue N jobs, run with concurrency K, expect each
    // jobId observed exactly once across all loops. If the atomic claim ever
    // raced and let two loops grab the same row, we'd see a duplicate.
    const N = 200;
    const K = 8;
    const seen = new Map<string, number>();
    const handler = async (job: { id: string }): Promise<void> => {
      seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
      // Tiny await to encourage scheduler interleavings.
      await new Promise<void>((r) => setImmediate(r));
    };
    const ids = new Set<string>();
    for (let i = 0; i < N; i++) {
      const j = enqueue({ jobType: "RACE", payload: { i } });
      ids.add(j.id);
    }
    const worker = new Worker({
      log: silent,
      pollIntervalMs: 1,
      handlers: { RACE: handler as (j: { id: string }) => Promise<void> } as unknown as Record<
        string,
        (j: { id: string }) => Promise<void>
      >,
    });
    worker.start({ concurrency: K });
    // Wait for all jobs to terminate. Stats reflect 'succeeded' only when the
    // queue marks them so; busy-wait is acceptable for a deterministic test.
    while (queueStats().succeeded < N) {
      await Bun.sleep(5);
    }
    await worker.stop();

    expect(seen.size).toBe(N);
    let max = 0;
    for (const v of seen.values()) max = Math.max(max, v);
    expect(max).toBe(1); // No job seen twice.
    for (const id of ids) expect(seen.has(id)).toBe(true);
    expect(queueStats()).toMatchObject({ succeeded: N, queued: 0, running: 0 });
  });

  test("start/stop runs jobs in the background", async () => {
    let resolved: (() => void) | null = null;
    const finished = new Promise<void>((r) => { resolved = r; });
    const worker = new Worker({
      log: silent,
      pollIntervalMs: 10,
      handlers: {
        ASYNC: async () => {
          if (resolved) resolved();
        },
      },
    });
    worker.start();
    enqueue({ jobType: "ASYNC", payload: {} });
    await finished;
    await worker.stop();
    expect(queueStats().succeeded).toBe(1);
  });
});
