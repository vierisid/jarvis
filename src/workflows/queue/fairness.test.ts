import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { getStoreEntry, putStoreEntry } from "../db/repos/store-entry";
import { createFlowRun } from "../db/repos/flow-run";
import { claimNextJob, completeJob, enqueue, getJob, queueWait } from "../db/repos/job-queue";
import { createWaitpoint } from "../db/repos/waitpoint";
import { claimContinuation, RESUME_PRIORITY } from "../runtime/continuation";
import { Worker, WORKFLOW_WORKER_CONCURRENCY } from "./worker";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

function storeStep(scope: string) {
  return { name: "trigger", type: "EMPTY", displayName: "Manual", settings: {}, nextAction: { name: "step_1", type: "PIECE", displayName: "append",
    settings: { pieceName: "@activepieces/piece-store", actionName: "append", input: { key: "shared", value: "x", store_scope: scope } } } };
}
function newFlow(scope?: string) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "fairness",
    ...(scope ? { trigger: storeStep(scope) } : {}) } as Parameters<typeof createDraftVersion>[0]);
  return { flow, version };
}
function queueRun(flow: { id: string }, version: { id: string }, extra: { priority?: number } = {}) {
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  // The way continuations and manual runs enqueue: run id only, no flow column.
  const job = enqueue({ jobType: "RUN_FLOW", flowRunId: run.id, payload: { runId: run.id }, ...extra });
  return { run, job };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** Wait for a condition instead of a fixed time, so a slow machine only waits longer. */
async function until(done: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await tick(5);
}

describe("run queue fairness", () => {
  test("the daemon runs more than one workflow at a time", () => {
    expect(WORKFLOW_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(2);
  });

  test("a short run of another workflow starts while a long run holds a worker", async () => {
    const a = newFlow(), b = newFlow();
    const long = queueRun(a.flow, a.version), short = queueRun(b.flow, b.version);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const worker = new Worker({
      pollIntervalMs: 5, log: () => undefined,
      handlers: { RUN_FLOW: async (job) => { if (job.id === long.job.id) await gate; done.push(job.id); } },
    });
    worker.start({ concurrency: 2 });
    await until(() => done.length > 0);
    expect(done).toEqual([short.job.id]);
    release();
    await worker.stop();
    expect(done).toEqual([short.job.id, long.job.id]);
  });

  test("two runs of one workflow never execute at once and keep their order", async () => {
    const a = newFlow();
    const first = queueRun(a.flow, a.version), second = queueRun(a.flow, a.version);
    let active = 0, peak = 0;
    const order: string[] = [];
    const worker = new Worker({
      pollIntervalMs: 5, log: () => undefined,
      handlers: { RUN_FLOW: async (job) => { peak = Math.max(peak, ++active); await tick(40); order.push(job.id); active--; } },
    });
    worker.start({ concurrency: 3 });
    await until(() => order.length === 2);
    await worker.stop();
    expect(peak).toBe(1);
    expect(order).toEqual([first.job.id, second.job.id]);
  });

  test("a claim skips a workflow that is already running and takes the next other one", () => {
    const a = newFlow(), b = newFlow();
    const first = queueRun(a.flow, a.version), sameFlow = queueRun(a.flow, a.version), other = queueRun(b.flow, b.version);
    expect(claimNextJob({ serializeFlows: true })?.id).toBe(first.job.id);
    expect(claimNextJob({ serializeFlows: true })?.id).toBe(other.job.id);
    expect(claimNextJob({ serializeFlows: true })).toBeNull();
    completeJob(first.job.id);
    expect(claimNextJob({ serializeFlows: true })?.id).toBe(sameFlow.job.id);
  });

  test("a continuation is claimed before runs that have not started", () => {
    const a = newFlow(), b = newFlow();
    const waiting = queueRun(a.flow, a.version);
    const paused = createFlowRun({ flowId: b.flow.id, flowVersionId: b.version.id, status: "PAUSED" });
    const due = createWaitpoint({ flowRunId: paused.id, projectId: "p", stepName: "wait", type: "TIMER",
      resumeDateTime: new Date(Date.now() - 1000).toISOString() });
    expect(claimContinuation({ runId: paused.id, waitpoint: due, kind: "timer", resumePayload: {} })).toBe("resumed");
    const resumed = claimNextJob();
    expect(resumed?.flowRunId).toBe(paused.id);
    expect(resumed?.priority).toBe(RESUME_PRIORITY);
    expect(claimNextJob()?.id).toBe(waiting.job.id);
  });

  test("a queued run reports how many runs are ahead of it", () => {
    const a = newFlow(), b = newFlow(), c = newFlow();
    const running = queueRun(a.flow, a.version);
    const ahead = queueRun(b.flow, b.version);
    const mine = queueRun(c.flow, c.version);
    expect(queueWait(mine.run.id)).toEqual({ ahead: 2 });
    claimNextJob();
    expect(queueWait(mine.run.id)).toEqual({ ahead: 2 });
    claimNextJob();
    completeJob(running.job.id);
    expect(queueWait(mine.run.id)).toEqual({ ahead: 1 });
    expect(queueWait(running.run.id)).toBeNull();
    expect(getJob(ahead.job.id)?.status).toBe("RUNNING");
  });

  // The store piece's append is read, change, write as separate calls.
  async function appendAll(scopeA: string, scopeB: string, each: number) {
    const a = newFlow(scopeA), b = newFlow(scopeB);
    for (let i = 0; i < each; i++) { queueRun(a.flow, a.version); queueRun(b.flow, b.version); }
    const worker = new Worker({
      pollIntervalMs: 2, log: () => undefined,
      handlers: { RUN_FLOW: async () => {
        const old = (getStoreEntry("p", "shared")?.value as string | undefined) ?? "";
        await tick(5);
        putStoreEntry("p", "shared", old + "x");
      } },
    });
    worker.start({ concurrency: 3 });
    await until(() => ((getStoreEntry("p", "shared")?.value as string | undefined)?.length ?? 0) >= each * 2, 4_000);
    await worker.stop();
    return (getStoreEntry("p", "shared")?.value as string | undefined)?.length ?? 0;
  }

  test("two different workflows appending to the project store at once lose nothing", async () => {
    expect(await appendAll("COLLECTION", "COLLECTION", 6)).toBe(12);
  });

  test("a scope chosen from data is treated as the project store too", async () => {
    expect(await appendAll("{{trigger.scope}}", "COLLECTION", 6)).toBe(12);
  });

  test("workflows that only use their own store scope still run side by side", async () => {
    const a = newFlow("FLOW"), b = newFlow("FLOW");
    queueRun(a.flow, a.version); queueRun(b.flow, b.version);
    expect(claimNextJob({ serializeFlows: true })).not.toBeNull();
    expect(claimNextJob({ serializeFlows: true })).not.toBeNull();
  });
});
