import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { createWaitpoint, getWaitpoint } from "../db/repos/waitpoint";
import { createWorkflowRoutes } from "../api/routes";
import { TimerWaitpointScheduler } from "../timer-scheduler";
import { createRunFlowHandler, RUN_FLOW } from "../runner/handler";
import {
  cancelJob,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  getJob,
  queueStats,
  recoverOrphanedJobs,
} from "../db/repos/job-queue";
import { Worker } from "./worker";

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

const silent = () => undefined;

function workflowJob(executionType: "BEGIN" | "RESUME" = "BEGIN") {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "retry safety" });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  const job = enqueue({ jobType: "RUN_FLOW", flowRunId: run.id,
    payload: { runId: run.id, executionType }, maxAttempts: 3 });
  return { job, run };
}

describe("workflow retry containment", () => {
  test("RUN_FLOW has one attempt even when callers request more; ordinary jobs retain retries", () => {
    expect(workflowJob().job.maxAttempts).toBe(1);
    expect(enqueue({ jobType: "RUN_FLOW", payload: {} }).maxAttempts).toBe(1);
    expect(enqueue({ jobType: "READ_ONLY", payload: {} }).maxAttempts).toBe(3);
  });

  test("a live workflow is never stolen when its lease expires", () => {
    const { job } = workflowJob();
    const now = Date.now();
    expect(claimNextJob({ now, leaseMs: 1 })?.id).toBe(job.id);
    const other = enqueue({ jobType: "READ_ONLY", payload: {} });
    expect(claimNextJob({ now: now + 10 })?.id).toBe(other.id);
    expect(getJob(job.id)).toMatchObject({ status: "RUNNING", attempt: 1 });
    // A long-running original worker can still record its result.
    completeJob(job.id);
    expect(getJob(job.id)?.status).toBe("SUCCEEDED");
  });

  test("legacy queued retries are retired before polling, preserving partial results", () => {
    const { job, run } = workflowJob();
    getWorkflowDb().run("UPDATE workflow_job SET attempt = 1, max_attempts = 3 WHERE id = ?", [job.id]);
    updateRun(run.id, { status: "RUNNING", steps: { send: { receipt: "fake-1" } } });
    expect(claimNextJob()).toBeNull();
    expect(getJob(job.id)).toMatchObject({ status: "FAILED", attempt: 1 });
    expect(getFlowRun(run.id)).toMatchObject({ status: "FAILED", steps: { send: { receipt: "fake-1" } } });
    expect(getFlowRun(run.id)?.failedStep?.errorMessage).toContain("Check completed effects");
  });

  for (const executionType of ["BEGIN", "RESUME"] as const) {
    test(`restart retires interrupted legacy ${executionType} jobs and exposes uncertainty`, () => {
      const { job, run } = workflowJob(executionType);
      claimNextJob();
      // Simulate the older queue's three-attempt policy on disk.
      getWorkflowDb().run("UPDATE workflow_job SET max_attempts = 3 WHERE id = ?", [job.id]);
      updateRun(run.id, { status: "PAUSED", steps: { send: { receipt: "fake-1" } } });
      expect(recoverOrphanedJobs()).toBe(0);
      expect(claimNextJob()).toBeNull();
      expect(getJob(job.id)).toMatchObject({ status: "FAILED", attempt: 1 });
      expect(getJob(job.id)?.lastError).toContain("Check completed effects");
      expect(getFlowRun(run.id)).toMatchObject({ status: "FAILED", steps: { send: { receipt: "fake-1" } } });
      expect(getFlowRun(run.id)?.finishTime).toBeGreaterThan(0);
    });
  }

  test("a recorded terminal result survives orphan retirement", () => {
    const { job, run } = workflowJob();
    claimNextJob();
    updateRun(run.id, { status: "SUCCEEDED", steps: { send: "done" }, finishTime: 123 });
    recoverOrphanedJobs();
    expect(getJob(job.id)?.status).toBe("FAILED");
    expect(getFlowRun(run.id)).toMatchObject({ status: "SUCCEEDED", finishTime: 123, steps: { send: "done" } });
  });

  for (const status of ["PAUSED", "RUNNING"] as const) {
    test(`restart preserves an unresolved waitpoint only after a durable PAUSED result (${status})`, () => {
      const { job, run } = workflowJob();
      claimNextJob();
      createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: "wait", type: "MANUAL" });
      updateRun(run.id, { status, steps: { send: { receipt: "fake-1" } } });
      recoverOrphanedJobs();
      expect(getJob(job.id)?.status).toBe("FAILED");
      expect(getFlowRun(run.id)?.status).toBe(status === "PAUSED" ? "PAUSED" : "FAILED");
      expect(getFlowRun(run.id)?.steps).toEqual({ send: { receipt: "fake-1" } });
      expect(claimNextJob()).toBeNull();
    });
  }

  for (const source of ["timer", "webhook", "legacy webhook"] as const) {
    test(`restart preserves and executes the fresh ${source} continuation after consuming its waitpoint`, async () => {
      closeWorkflowDb();
      const directory = mkdtempSync(join(tmpdir(), "jarvis-queued-resume-"));
      const database = join(directory, "workflow.sqlite");
      initWorkflowDb(database);
      try {
        const { job, run } = workflowJob();
        expect(claimNextJob()?.id).toBe(job.id);
        const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId,
          stepName: "wait", type: source === "timer" ? "TIMER" : "WEBHOOK",
          resumeDateTime: new Date(Date.now() - 1000).toISOString() });
        // The engine has durably paused, but its original queue job is still
        // RUNNING while the timer/webhook consumes that pause.
        const completedSteps = { send: { output: { receipt: "fake-before-wait" } } };
        updateRun(run.id, { status: "PAUSED", steps: completedSteps, stepsCount: 1 });
        if (source === "timer") {
          expect(new TimerWaitpointScheduler().tick()).toBe(1);
        } else {
          const request = Object.assign(new Request("http://localhost/api/webhooks/waitpoints/" + waitpoint.id, {
            method: "POST", body: JSON.stringify({ approved: true }),
          }), { params: { id: waitpoint.id } });
          const response = await createWorkflowRoutes()["/api/webhooks/waitpoints/:id"]!.POST!(request);
          expect(response.status).toBe(202);
        }
        expect(getWaitpoint(waitpoint.id)?.resumedAt).not.toBeNull();
        const continuationId = getWorkflowDb().query<{ id: string }, [string]>(
          "SELECT id FROM workflow_job WHERE flow_run_id = ? AND status = 'QUEUED'",
        ).get(run.id)!.id;
        if (source === "legacy webhook") {
          getWorkflowDb().run("UPDATE workflow_job SET flow_run_id = NULL, flow_id = ?, flow_version_id = ? WHERE id = ?",
            [run.flowId, run.flowVersionId, continuationId]);
        }
        for (let boot = 0; boot < 2; boot++) {
          closeWorkflowDb();
          if (boot === 0) {
            const child = Bun.spawn([process.execPath, "-e", `
              import { initWorkflowDb, closeWorkflowDb } from ${JSON.stringify(new URL("../db/index.ts", import.meta.url).href)};
              import { recoverOrphanedJobs } from ${JSON.stringify(new URL("../db/repos/job-queue.ts", import.meta.url).href)};
              initWorkflowDb(${JSON.stringify(database)});
              recoverOrphanedJobs();
              closeWorkflowDb();
            `], { stdout: "pipe", stderr: "pipe" });
            const [exitCode, , stderr] = await Promise.all([
              child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
          }
          initWorkflowDb(database);
          expect(recoverOrphanedJobs()).toBe(0);
          expect(getJob(job.id)).toMatchObject({ status: "FAILED", attempt: 1 });
          expect(getJob(continuationId)).toMatchObject({ status: "QUEUED", attempt: 0, maxAttempts: 1 });
          expect(getFlowRun(run.id)).toMatchObject({ status: "PAUSED", steps: completedSteps, finishTime: null });
        }
        let resumed = 0;
        const worker = new Worker({ log: silent, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
          async execute(ctx) {
            expect(ctx.job.id).toBe(continuationId);
            expect(ctx.job.payload.executionType).toBe("RESUME");
            expect(ctx.job.payload.resumePayload).toEqual(source === "timer" ? {} : { approved: true });
            expect(ctx.run.steps).toEqual(completedSteps);
            resumed++;
            return { steps: { ...ctx.run.steps, afterWait: { output: "done" } }, stepsCount: 2 };
          },
        } }) } });
        expect(await worker.drain()).toBe(1);
        expect(resumed).toBe(1);
        expect(getFlowRun(run.id)?.status).toBe("SUCCEEDED");
        closeWorkflowDb();
        initWorkflowDb(database);
        recoverOrphanedJobs();
        expect(await worker.drain()).toBe(0);
        expect(resumed).toBe(1);
      } finally {
        closeWorkflowDb();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  for (const invalid of ["BEGIN", "attempted", "canceled", "wrong payload run", "wrong row run", "wrong version", "wrong flow", "wrong job type", "malformed JSON", "unpaused run"] as const) {
    test(`recovery does not treat ${invalid} as a valid queued continuation`, () => {
      const { job, run } = workflowJob();
      claimNextJob();
      updateRun(run.id, { status: invalid === "unpaused run" ? "RUNNING" : "PAUSED" });
      const continuation = enqueue({ jobType: invalid === "wrong job type" ? "OTHER" : RUN_FLOW,
        flowRunId: invalid === "wrong row run" ? "other-run" : run.id,
        flowVersionId: invalid === "wrong version" ? "other-version" : run.flowVersionId,
        flowId: invalid === "wrong flow" ? "other-flow" : run.flowId,
        payload: { runId: invalid === "wrong payload run" ? "other-run" : run.id,
          executionType: invalid === "BEGIN" ? "BEGIN" : "RESUME" },
      });
      if (invalid === "attempted") getWorkflowDb().run("UPDATE workflow_job SET attempt = 1 WHERE id = ?", [continuation.id]);
      if (invalid === "canceled") cancelJob(continuation.id);
      if (invalid === "malformed JSON") getWorkflowDb().run("UPDATE workflow_job SET payload = '{' WHERE id = ?", [continuation.id]);
      recoverOrphanedJobs();
      expect(getJob(job.id)?.status).toBe("FAILED");
      expect(getFlowRun(run.id)?.status).toBe("FAILED");
      expect(getFlowRun(run.id)?.failedStep?.errorMessage).toContain("Check completed effects");
    });
  }

  test("legacy RUNNING jobs cannot retry after an executor error", () => {
    const { job } = workflowJob();
    claimNextJob();
    getWorkflowDb().run("UPDATE workflow_job SET max_attempts = 3 WHERE id = ?", [job.id]);
    expect(failJob(job.id, "later failed")).toBe(false);
    expect(getJob(job.id)?.status).toBe("FAILED");
  });

  test("job retirement and the run's uncertainty record commit atomically", () => {
    const { job, run } = workflowJob();
    claimNextJob();
    updateRun(run.id, { status: "RUNNING" });
    getWorkflowDb().run(`CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE ON flow_run
      BEGIN SELECT RAISE(ABORT, 'recovery write failed'); END`);
    expect(() => recoverOrphanedJobs()).toThrow("recovery write failed");
    expect(getJob(job.id)?.status).toBe("RUNNING");
    expect(getFlowRun(run.id)?.status).toBe("RUNNING");
    getWorkflowDb().run("DROP TRIGGER reject_recovery");
    recoverOrphanedJobs();
    expect(getJob(job.id)?.status).toBe("FAILED");
  });

  test("a process lost after delivery cannot replay that effect on either subsequent boot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-retry-safety-"));
    const database = join(directory, "workflow.sqlite");
    const effects = join(directory, "fake-deliveries.txt");
    const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const imports = `
      import { initWorkflowDb, getWorkflowDb } from ${source("../db/index.ts")};
      import { createFlow } from ${source("../db/repos/flow.ts")};
      import { createDraftVersion } from ${source("../db/repos/flow-version.ts")};
      import { createFlowRun, updateRun } from ${source("../db/repos/flow-run.ts")};
      import { enqueue, claimNextJob, recoverOrphanedJobs } from ${source("../db/repos/job-queue.ts")};
      import { Worker } from ${source("./worker.ts")};
      import { appendFileSync } from 'node:fs';
      initWorkflowDb(${JSON.stringify(database)});
    `;
    const runProcess = async (code: string) => {
      const child = Bun.spawn([process.execPath, "-e", imports + code], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      return stdout;
    };
    try {
      // The external fake delivery is durable, but no success receipt gets
      // recorded for the queue. Deliberately leave legacy retry metadata too.
      await runProcess(`
        const flow = createFlow();
        const version = createDraftVersion({ flowId: flow.id, displayName: 'crash' });
        const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
        const job = enqueue({ jobType: 'RUN_FLOW', payload: { runId: run.id } });
        claimNextJob();
        updateRun(run.id, { status: 'RUNNING', steps: { beforeSend: 'done' } });
        getWorkflowDb().run('UPDATE workflow_job SET max_attempts = 3 WHERE id = ?', [job.id]);
        appendFileSync(${JSON.stringify(effects)}, 'delivered\\n');
        process.exit(0);
      `);
      for (let boot = 0; boot < 2; boot++) {
        const output = await runProcess(`
          recoverOrphanedJobs();
          const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: async () => {
            appendFileSync(${JSON.stringify(effects)}, 'DUPLICATE\\n');
          } } });
          const processed = await worker.drain();
          console.log(JSON.stringify({ processed,
            job: getWorkflowDb().query('SELECT status, attempt, last_error FROM workflow_job').get(),
            run: getWorkflowDb().query('SELECT status, steps, failed_step FROM flow_run').get(),
          }));
        `);
        const state = JSON.parse(output.trim().split("\n").at(-1)!);
        expect(state.processed).toBe(0);
        expect(state.job).toMatchObject({ status: "FAILED", attempt: 1 });
        expect(state.job.last_error).toContain("Check completed effects");
        expect(state.run.status).toBe("FAILED");
        expect(JSON.parse(state.run.steps)).toEqual({ beforeSend: "done" });
        expect(JSON.parse(state.run.failed_step).errorMessage).toContain("Check completed effects");
        expect(readFileSync(effects, "utf8")).toBe("delivered\n");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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

  test("recoverOrphanedJobs re-queues orphaned RUNNING jobs for immediate re-claim", () => {
    const j = enqueue({ jobType: "TEST", payload: {} });
    const claimed = claimNextJob(); // -> RUNNING with a live (future) lease
    expect(claimed?.id).toBe(j.id);
    // A normal poll won't re-claim it: the lease hasn't lapsed.
    expect(claimNextJob()).toBeNull();
    // Boot recovery treats the orphaned RUNNING job as re-runnable NOW.
    expect(recoverOrphanedJobs()).toBe(1);
    expect(getJob(j.id)?.status).toBe("QUEUED");
    expect(claimNextJob()?.id).toBe(j.id); // immediately re-claimable
  });

  test("recoverOrphanedJobs fails a poison job at the attempt ceiling instead of re-queuing", () => {
    const poison = enqueue({ jobType: "T", payload: {}, maxAttempts: 1 });
    claimNextJob(); // poison -> RUNNING, attempt 1 == max_attempts
    const healthy = enqueue({ jobType: "T", payload: {}, maxAttempts: 3 });
    claimNextJob(); // healthy -> RUNNING, attempt 1 < max_attempts
    expect(recoverOrphanedJobs()).toBe(1); // only the healthy one re-queues
    expect(getJob(poison.id)?.status).toBe("FAILED");
    expect(getJob(healthy.id)?.status).toBe("QUEUED");
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
    const j = enqueue({ jobType: "T", payload: {}, maxAttempts: 3, scheduledAt: now });
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
    const j = enqueue({ jobType: "T", payload: {}, maxAttempts: 2, scheduledAt: now });
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
    const retryJob = enqueue({ jobType: "FLAKY", payload: {}, maxAttempts: 2 });

    // First drain: claim, throw, requeue with backoff -> not ready immediately.
    await worker.drain();
    expect(queueStats()).toMatchObject({ queued: 1, failed: 0, succeeded: 0 });

    // Make this retry due without relying on wall-clock drift in the host.
    // The repository tests separately verify the backoff calculation.
    getWorkflowDb().run("UPDATE workflow_job SET scheduled_at = 0 WHERE id = ?", [retryJob.id]);
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
