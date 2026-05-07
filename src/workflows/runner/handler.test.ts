import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { enqueue, queueStats } from "../db/repos/job-queue";
import { Worker } from "../queue/worker";
import {
  createRunFlowHandler,
  FlowExecutionError,
  NoopFlowExecutor,
  RUN_FLOW,
  type FlowExecutor,
  type FlowExecutorContext,
  type FlowExecutorResult,
} from "./handler";

const silent = () => undefined;

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

function setupRun(): { flowId: string; versionId: string; runId: string } {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "v1" });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  enqueue({
    jobType: RUN_FLOW,
    payload: { runId: run.id, payload: {} },
    flowRunId: run.id,
    flowId: flow.id,
    flowVersionId: version.id,
  });
  return { flowId: flow.id, versionId: version.id, runId: run.id };
}

describe("RUN_FLOW handler with NoopFlowExecutor", () => {
  test("transitions QUEUED -> RUNNING -> SUCCEEDED and records start/finish times", async () => {
    const { runId } = setupRun();
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new NoopFlowExecutor() }) },
    });
    expect(getFlowRun(runId)?.status).toBe("QUEUED");
    await worker.drain();
    const after = getFlowRun(runId);
    expect(after?.status).toBe("SUCCEEDED");
    expect(after?.startTime).toBeGreaterThan(0);
    expect(after?.finishTime).toBeGreaterThan(0);
    expect(after?.steps).toEqual({});
    expect(after?.stepsCount).toBe(0);
    expect(queueStats()).toMatchObject({ succeeded: 1, queued: 0 });
  });

  test("preserves an existing startTime across retries (does not reset on second attempt)", async () => {
    const { runId } = setupRun();
    // Pre-set startTime to simulate a job that already started.
    const fixedStart = 1_700_000_000_000;
    updateRun(runId, { startTime: fixedStart });
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new NoopFlowExecutor() }) },
    });
    await worker.drain();
    expect(getFlowRun(runId)?.startTime).toBe(fixedStart);
  });
});

describe("RUN_FLOW handler with custom executor", () => {
  test("persists steps + stepsCount returned by the executor", async () => {
    const { runId } = setupRun();
    const executor: FlowExecutor = {
      async execute(_ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
        return {
          steps: { trigger: { output: { ok: true } }, action1: { output: 42 } },
          stepsCount: 2,
        };
      },
    };
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    });
    await worker.drain();
    const after = getFlowRun(runId);
    expect(after?.status).toBe("SUCCEEDED");
    expect(after?.steps).toEqual({
      trigger: { output: { ok: true } },
      action1: { output: 42 },
    });
    expect(after?.stepsCount).toBe(2);
  });

  test("hands the executor the full run, version, and external payload", async () => {
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id,
      displayName: "v1",
      trigger: { name: "trigger", type: "PIECE_TRIGGER" },
    });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: { foo: "bar" } },
      flowRunId: run.id,
    });
    let captured: FlowExecutorContext | null = null;
    const executor: FlowExecutor = {
      async execute(ctx) {
        captured = ctx;
        return { steps: {}, stepsCount: 0 };
      },
    };
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    });
    await worker.drain();
    expect(captured).not.toBeNull();
    const ctx = captured as unknown as FlowExecutorContext;
    expect(ctx.run.id).toBe(run.id);
    expect(ctx.version.id).toBe(version.id);
    expect(ctx.version.trigger).toEqual({ name: "trigger", type: "PIECE_TRIGGER" });
    expect(ctx.payload).toEqual({ foo: "bar" });
  });

  test("FlowExecutionError marks run FAILED with named step + partial steps", async () => {
    const { runId } = setupRun();
    const executor: FlowExecutor = {
      async execute() {
        throw new FlowExecutionError(
          "step2 blew up",
          { name: "step2", displayName: "Send Email" },
          { step1: { output: "ok" }, step2: { error: "blew up" } },
        );
      },
    };
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
      // Single attempt -- no retries to keep the test deterministic.
    });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId, payload: {} },
      flowRunId: runId,
      maxAttempts: 1,
    });
    await worker.drain();
    const after = getFlowRun(runId);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep).toEqual({ name: "step2", displayName: "Send Email" });
    expect(after?.steps).toEqual({ step1: { output: "ok" }, step2: { error: "blew up" } });
    expect(after?.stepsCount).toBe(2);
  });

  test("non-FlowExecutionError marks run FAILED with generic engine step", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 1,
    });
    const executor: FlowExecutor = {
      async execute() {
        throw new Error("network blip");
      },
    };
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    });
    await worker.drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("<engine>");
  });

  test("clears failed_step from a prior attempt before retry", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    let attempts = 0;
    const executor: FlowExecutor = {
      async execute() {
        attempts++;
        if (attempts === 1) {
          throw new FlowExecutionError("first try", { name: "stepX", displayName: "X" });
        }
        return { steps: { stepX: { output: "fine" } }, stepsCount: 1 };
      },
    };
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: {} },
      flowRunId: run.id,
      maxAttempts: 3,
    });
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) },
    });

    // First drain: handler throws, queue requeues with backoff.
    await worker.drain();
    expect(getFlowRun(run.id)?.status).toBe("FAILED");
    expect(getFlowRun(run.id)?.failedStep?.name).toBe("stepX");

    await Bun.sleep(1100);
    await worker.drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("SUCCEEDED");
    expect(after?.failedStep).toBeNull();
    expect(attempts).toBe(2);
  });

  test("missing run row: handler returns silently and the job is marked succeeded", async () => {
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: "does-not-exist", payload: {} },
      maxAttempts: 1,
    });
    const worker = new Worker({
      log: silent,
      handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new NoopFlowExecutor() }) },
    });
    await worker.drain();
    expect(queueStats()).toMatchObject({ succeeded: 1, failed: 0 });
  });

  // Note: there is no test for "missing flow_version" because the schema has
  // an FK from flow_run.flow_version_id to flow_version(id), so the corrupt
  // state isn't reachable. The handler keeps a defensive check anyway.
});
