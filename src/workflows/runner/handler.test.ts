import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, getFlowVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { enqueue, getJob, queueStats } from "../db/repos/job-queue";
import { workflowFailureMessage } from "../queue/retry-policy";
import { Worker } from "../queue/worker";
import { createWaitpoint } from "../db/repos/waitpoint";
import { createWorkflowRoutes } from "../api/routes";
import { TimerWaitpointScheduler } from "../timer-scheduler";
import { EngineFlowExecutor } from "./engine-runtime/engine-flow-executor";
import type { EngineHandle, EngineRuntime } from "./engine-runtime/engine-runtime";
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

  test("preserves the startTime recorded at enqueue", async () => {
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
  for (const source of ["timer", "webhook"] as const) {
    for (const timing of ["before", "after"] as const) {
      test(`${source} continuation queued ${timing} original completion preserves the engine pause`, async () => {
        const { runId, versionId } = setupRun();
        let deliveries = 0;
        let resumes = 0;
        let waitpointId = "";
        const seed = { output: { type: "PIECE", status: "SUCCEEDED", output: { receipt: "fake-before-pause" } } };
        const resumePayload = source === "timer" ? {} : { approved: true };
        const resume = async () => {
          if (source === "timer") {
            expect(new TimerWaitpointScheduler().tick()).toBe(1);
          } else {
            const request = Object.assign(new Request("http://localhost/api/webhooks/waitpoints/" + waitpointId, {
              method: "POST", body: JSON.stringify(resumePayload),
            }), { params: { id: waitpointId } });
            expect((await createWorkflowRoutes()["/api/webhooks/waitpoints/:id"]!.POST!(request)).status).toBe(202);
          }
        };
        // Stub only the engine subprocess: the queue, handler, production
        // executor, run records and continuation producers are real.
        const runtime = { async acquire() {
          return { async executeFlow(opts: Parameters<EngineHandle["executeFlow"]>[0]) {
            if (opts.executionType === "RESUME") {
              resumes++;
              expect(queueStats().succeeded).toBe(1);
              expect(getFlowVersion(versionId)?.sampleData).toBeNull();
              expect(getFlowRun(runId)?.finishTime).toBeNull();
              expect(opts.resumePayload).toEqual(resumePayload);
              expect(opts.executionState?.steps.seed).toEqual(seed.output);
              updateRun(runId, { status: "SUCCEEDED", steps: { seed, afterWait: { output: "done" } }, stepsCount: 2 });
            } else {
              deliveries++;
              const run = getFlowRun(runId)!;
              waitpointId = createWaitpoint({ flowRunId: runId, projectId: run.projectId, stepName: "wait",
                type: source === "timer" ? "TIMER" : "WEBHOOK",
                resumeDateTime: new Date(Date.now() - 1000).toISOString(),
              }).id;
              // An engine attempt can finish while the workflow is waiting.
              updateRun(runId, { status: "PAUSED", steps: { seed }, stepsCount: 1, finishTime: 123 });
              if (timing === "before") await resume();
            }
          }, async release() {} } as unknown as EngineHandle;
        } } as unknown as EngineRuntime;
        const worker = new Worker({ log: silent, handlers: {
          [RUN_FLOW]: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }),
        } });
        await worker.drain();
        if (timing === "after") {
          expect(getFlowRun(runId)).toMatchObject({ status: "PAUSED", finishTime: null, steps: { seed } });
          expect(queueStats()).toMatchObject({ succeeded: 1, failed: 0 });
          // A legacy pause may already carry a stale finish time. Clear it
          // before dispatching the continuation as well as after a new pause.
          updateRun(runId, { finishTime: 456 });
          await resume();
          await worker.drain();
        }
        expect({ deliveries, resumes }).toEqual({ deliveries: 1, resumes: 1 });
        expect(getFlowRun(runId)).toMatchObject({ status: "SUCCEEDED", steps: { seed, afterWait: { output: "done" } } });
        expect(getFlowRun(runId)!.finishTime).toBeGreaterThan(0);
        expect(queueStats()).toMatchObject({ succeeded: 2, failed: 0 });
      });
    }
  }

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
    });
    await worker.drain();
    const after = getFlowRun(runId);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep).toEqual({
      name: "step2",
      displayName: "Send Email",
      errorMessage: workflowFailureMessage("step2 blew up"),
    });
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
    // The reason must survive onto the run row, not just the daemon log.
    expect(after?.failedStep?.errorMessage).toBe(workflowFailureMessage("network blip"));
  });

  test("retains a failed run instead of replaying it, even when a caller requests retries", async () => {
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

    // First drain: handler throws; the shared policy stops the job.
    await worker.drain();
    expect(getFlowRun(run.id)?.status).toBe("FAILED");
    expect(getFlowRun(run.id)?.failedStep?.name).toBe("stepX");

    await Bun.sleep(1100);
    await worker.drain();
    const after = getFlowRun(run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failedStep?.name).toBe("stepX");
    expect(attempts).toBe(1);
  });

  test("a fresh BEGIN job cannot replay an already completed run", async () => {
    const { runId } = setupRun();
    let effects = 0;
    const worker = new Worker({ log: silent, handlers: {
      [RUN_FLOW]: createRunFlowHandler({ executor: { async execute() {
        effects++;
        return { steps: { send: { receipt: "fake-1" } }, stepsCount: 1 };
      } } }),
    } });
    await worker.drain();
    const original = getFlowRun(runId);
    const duplicate = enqueue({ jobType: RUN_FLOW, payload: { runId }, flowRunId: runId });
    await worker.drain();
    expect(effects).toBe(1);
    expect(getJob(duplicate.id)?.status).toBe("FAILED");
    expect(getFlowRun(runId)).toEqual(original);
  });

  test("planned RESUME continues PAUSED state once; another dispatch cannot replay the terminal run", async () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "paused" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "PAUSED" });
    updateRun(run.id, { steps: { send: { receipt: "fake-1" } } });
    const payload = { runId: run.id, executionType: "RESUME" };
    enqueue({ jobType: RUN_FLOW, payload, flowRunId: run.id });
    let continuations = 0;
    const worker = new Worker({ log: silent, handlers: {
      [RUN_FLOW]: createRunFlowHandler({ executor: { async execute(ctx) {
        expect(ctx.run.steps).toEqual({ send: { receipt: "fake-1" } });
        expect(ctx.job.payload.executionType).toBe("RESUME");
        continuations++;
        return { steps: { ...ctx.run.steps, afterWait: "done" }, stepsCount: 2 };
      } } }),
    } });
    await worker.drain();
    const duplicate = enqueue({ jobType: RUN_FLOW, payload, flowRunId: run.id });
    await worker.drain();
    expect(continuations).toBe(1);
    expect(getJob(duplicate.id)?.status).toBe("FAILED");
    expect(getFlowRun(run.id)?.status).toBe("SUCCEEDED");
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
