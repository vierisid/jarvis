/**
 * The CODE-step permission is read when a run executes, not only when it is
 * queued (#1426). After the owner revokes it, no CODE step runs from any path:
 * a run queued or paused before the revoke is refused when the worker takes
 * it, a run already executing is stopped by the revoke, and a revoke that
 * lands while the engine is being prepared (CODE sources written, packages
 * installed) is caught by the recheck just before the flow is sent. Granting
 * again lets new runs through.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow, setFlowCodeStepsEnabled } from "../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { enqueue, type Job } from "../db/repos/job-queue";
import { WorkflowReadinessError } from "../db/repos/flow-readiness";
import { CODE_REVOKED_REASON } from "../db/repos/flow-turn-off";
import { DEFAULT_IDS } from "../db/schema";
import { Worker } from "../queue/worker";
import { createWorkflowRoutes } from "../api/routes";
import { onCodeStepsRevoked } from "../runtime/cancellation-signals";
import { EngineFlowExecutor } from "./engine-runtime/engine-flow-executor";
import type { EngineHandle, EngineRuntime } from "./engine-runtime/engine-runtime";
import { createRunFlowHandler, RUN_FLOW, type FlowExecutorContext } from "./handler";

const silent = () => undefined;
const CODE_STEP = { name: "compute_totals", type: "CODE", displayName: "Compute totals",
  settings: { sourceCode: { packageJson: "{}", code: "export const code = async () => ({});" } } };

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

/** A granted flow and a locked version; with `code` false the version has no CODE step. */
function flowWith(code = true): { flowId: string; versionId: string } {
  const flow = createFlow({ projectId: DEFAULT_IDS.project });
  setFlowCodeStepsEnabled(flow.id, true);
  const v = createDraftVersion({ flowId: flow.id, displayName: "v" });
  updateDraftVersion(v.id, { trigger: { name: "trigger", type: "EMPTY", ...(code ? { nextAction: { ...CODE_STEP } } : {}) } });
  lockVersion(v.id);
  return { flowId: flow.id, versionId: v.id };
}

function queue(flowId: string, versionId: string, status: "QUEUED" | "PAUSED" = "QUEUED"): string {
  const run = createFlowRun({ flowId, flowVersionId: versionId, status });
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: {}, ...(status === "PAUSED" ? { executionType: "RESUME" } : {}) },
    flowRunId: run.id, flowId, flowVersionId: versionId, maxAttempts: 1 });
  return run.id;
}

function counting(): { executed: string[]; worker: Worker } {
  const executed: string[] = [];
  const worker = new Worker({ log: silent, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
    async execute(ctx: FlowExecutorContext) { executed.push(ctx.run.id); return { steps: {}, stepsCount: 0 }; },
  } }) } });
  return { executed, worker };
}

async function grant(flowId: string, enabled: boolean): Promise<number> {
  const req = new Request("http://localhost/api/workflows/x/code-steps", { method: "POST", body: JSON.stringify({ enabled }),
    headers: { "Content-Type": "application/json" } }) as Request & { params: Record<string, string> };
  req.params = { id: flowId };
  return (await createWorkflowRoutes()["/api/workflows/:id/code-steps"]!.POST!(req)).status;
}

describe("the RUN_FLOW worker reads the CODE-step grant when it executes (#1426)", () => {
  test("a run queued before the revoke never reaches the executor and fails with a readiness refusal", async () => {
    const { flowId, versionId } = flowWith();
    const runId = queue(flowId, versionId);
    setFlowCodeStepsEnabled(flowId, false);
    const { executed, worker } = counting();
    await worker.drain();
    expect(executed).toEqual([]);
    const run = getFlowRun(runId)!;
    expect(run.status).toBe("FAILED");
    const message = (run.failedStep as { errorMessage?: string }).errorMessage ?? "";
    expect(message).toContain("compute_totals");
    expect(message).toContain("CODE steps are not allowed for it any more");
  });

  test("a paused run is not continued after the revoke", async () => {
    const { flowId, versionId } = flowWith();
    const runId = queue(flowId, versionId, "PAUSED");
    setFlowCodeStepsEnabled(flowId, false);
    const { executed, worker } = counting();
    await worker.drain();
    expect(executed).toEqual([]);
    expect(getFlowRun(runId)!.status).toBe("FAILED");
  });

  test("granted, or with no CODE step, the run executes; re-granting lets the next run through", async () => {
    const coded = flowWith();
    const plain = flowWith(false);
    setFlowCodeStepsEnabled(plain.flowId, false);
    const { executed, worker } = counting();
    const first = queue(coded.flowId, coded.versionId);
    const noCode = queue(plain.flowId, plain.versionId);
    await worker.drain();
    expect(executed.sort()).toEqual([first, noCode].sort());
    setFlowCodeStepsEnabled(coded.flowId, false);
    const refused = queue(coded.flowId, coded.versionId);
    await worker.drain();
    expect(executed).not.toContain(refused);
    setFlowCodeStepsEnabled(coded.flowId, true);
    const again = queue(coded.flowId, coded.versionId);
    await worker.drain();
    expect(executed).toContain(again);
  });
});

describe("revoking through the grant route stops what is already in flight (#1426)", () => {
  test("queued, paused and executing runs of a CODE version are stopped, saying why; a version without CODE is left", async () => {
    const { flowId, versionId } = flowWith();
    const queued = queue(flowId, versionId);
    const paused = queue(flowId, versionId, "PAUSED");
    const other = createDraftVersion({ flowId, displayName: "no code" });
    const untouched = createFlowRun({ flowId, flowVersionId: other.id, status: "PAUSED" }).id;
    const revoked: string[] = [];
    const stopWatch = onCodeStepsRevoked((id) => revoked.push(id));

    // One run executing on the engine when the revoke lands: it passed every
    // check while the grant held, so only the revoke can stop it.
    let aborted = false;
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const executing = queue(flowId, versionId);
    getWorkflowDb().run("UPDATE workflow_job SET status = 'CANCELED' WHERE flow_run_id IN (?, ?)", [queued, paused]);
    const worker = new Worker({ log: silent, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
      async execute(ctx: FlowExecutorContext) {
        started();
        await new Promise<void>((resolve) => ctx.signal!.addEventListener("abort", () => resolve()));
        aborted = true;
        throw new Error("engine stopped");
      },
    } }) } });
    const drained = worker.drain();
    await running;
    expect(getFlowRun(executing)!.status).toBe("RUNNING");

    expect(await grant(flowId, false)).toBe(200);
    await drained;
    stopWatch();

    expect(aborted).toBe(true);
    for (const id of [queued, paused, executing]) {
      const run = getFlowRun(id)!;
      expect(run.status).toBe("STOPPED");
      expect((run.failedStep as { errorMessage?: string }).errorMessage).toBe(CODE_REVOKED_REASON);
    }
    expect(getFlowRun(untouched)!.status).toBe("PAUSED");
    expect(revoked).toEqual([flowId]);
    const stops = getWorkflowDb().query<{ detail: string }, [string]>(
      "SELECT detail FROM workflow_trigger_fire WHERE flow_id = ? AND outcome = 'stopped'").all(flowId);
    expect(stops).toHaveLength(3);
    expect(JSON.parse(stops[0]!.detail).code).toBe("CODE_STEPS_NOT_ENABLED");

    // Granting again stops nothing and lets a new run execute.
    expect(await grant(flowId, true)).toBe(200);
    const { executed, worker: next } = counting();
    const fresh = queue(flowId, versionId);
    await next.drain();
    expect(executed).toEqual([fresh]);
    expect(getFlowRun(untouched)!.status).toBe("PAUSED");
  });
});

describe("the engine executor rechecks the grant just before it sends the flow (#1426)", () => {
  function executorFor(onExecuteFlow: (opts: { beforeSend?: () => void }, runId: string) => void): {
    executor: EngineFlowExecutor; sent: () => boolean;
  } {
    let sent = false;
    let runId = "";
    const handle = {
      async executeFlow(opts: { beforeSend?: () => void }) {
        onExecuteFlow(opts, runId);
        opts.beforeSend?.();
        sent = true;
        updateRun(runId, { status: "SUCCEEDED", finishTime: Date.now() });
        return undefined;
      },
      async release() {},
      async killAndTerminate() {},
    } as unknown as EngineHandle;
    const runtime = { async acquire(args: { runId: string }) { runId = args.runId; return handle; } } as unknown as EngineRuntime;
    return { executor: new EngineFlowExecutor(runtime), sent: () => sent };
  }

  function context(flowId: string, versionId: string): FlowExecutorContext {
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: "RUNNING" });
    const version = getWorkflowDb().query<{ trigger: string }, [string]>("SELECT trigger FROM flow_version WHERE id = ?").get(versionId)!;
    return { run, version: { id: versionId, flowId, trigger: JSON.parse(version.trigger) } as FlowExecutorContext["version"],
      job: { id: "job", attempt: 1, payload: { runId: run.id } } as unknown as Job<never>, payload: {} } as FlowExecutorContext;
  }

  test("a revoke while the CODE sources are prepared sends nothing", async () => {
    const { flowId, versionId } = flowWith();
    // The revoke lands inside executeFlow, after the executor's own checks,
    // where the CODE sources are written and their packages installed.
    const { executor, sent } = executorFor(() => setFlowCodeStepsEnabled(flowId, false));
    const error = await executor.execute(context(flowId, versionId)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowReadinessError);
    expect((error as WorkflowReadinessError).readiness.issues[0]!.code).toBe("CODE_STEPS_NOT_ENABLED");
    expect(sent()).toBe(false);
  });

  test("with the grant held the flow is sent", async () => {
    const { flowId, versionId } = flowWith();
    const { executor, sent } = executorFor(() => undefined);
    await executor.execute(context(flowId, versionId));
    expect(sent()).toBe(true);
  });
});
