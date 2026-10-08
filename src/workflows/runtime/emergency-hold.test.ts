/**
 * Q-08: Pause holds and Kill stops, for workflows, below every UI control:
 * the worker, the run handler, continuations, steps parked on a hold, and
 * starts by hand. Triggers are covered in `delivery.test.ts`, governed and
 * ungoverned steps in `governed-pieces.test.ts` and `workflow-authority.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { claimNextJob, enqueue, getJob } from "../db/repos/job-queue";
import { createWaitpoint, getWaitpoint } from "../db/repos/waitpoint";
import { listFlowFires } from "../db/repos/trigger-fire";
import { EmergencyController, setActiveEmergencyController } from "../../authority/emergency";
import { createWorkflowRoutes } from "../api/routes";
import { Worker } from "../queue/worker";
import { createRunFlowHandler, RUN_FLOW, type FlowExecutor } from "../runner/handler";
import { TimerWaitpointScheduler } from "../timer-scheduler";
import { releaseEmergencyHolds } from "./continuation";
import { holdStep, KILLED_RUN_REASON, stopUnfinishedRunsForKill } from "./emergency-hold";
import { applyEmergencyState } from "../../daemon/emergency-state";
import { ApprovalManager } from "../../authority/approval";
import { AuthorityEngine } from "../../authority/engine";

let controller: EmergencyController;
beforeEach(() => {
  initWorkflowDb(":memory:");
  controller = new EmergencyController();
  setActiveEmergencyController(controller);
});
afterEach(() => {
  setActiveEmergencyController(null);
  closeWorkflowDb();
});

const silent = () => undefined;
const at = (iso: string) => Date.parse(iso);
const EMPTY = { name: "trigger", type: "EMPTY" } as const;

function workflow() {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Emergency", trigger: EMPTY as any });
  updateFlowStatus(flow.id, "ENABLED");
  return { flowId: flow.id, versionId: version.id };
}
function queued() {
  const { flowId, versionId } = workflow();
  const run = createFlowRun({ flowId, flowVersionId: versionId });
  const job = enqueue({ jobType: RUN_FLOW, flowRunId: run.id, maxAttempts: 1, payload: { runId: run.id } });
  return { flowId, versionId, runId: run.id, jobId: job.id };
}
function counting() {
  const calls: string[] = [];
  const executor: FlowExecutor = { async execute(ctx) {
    calls.push(String((ctx.job.payload as { executionType?: string }).executionType ?? "BEGIN"));
    return { status: "SUCCEEDED", steps: {}, stepsCount: 0 };
  } };
  const handler = createRunFlowHandler({ executor });
  const drain = () => new Worker({ log: silent, handlers: { [RUN_FLOW]: handler } }).drain();
  return { calls, drain, handler };
}
const resume = (id: string) => createWorkflowRoutes()["/api/webhooks/waitpoints/:id"]!.POST!(
  Object.assign(new Request(`http://localhost/api/webhooks/waitpoints/${id}`, { method: "POST", body: "{}" }), { params: { id } }));

describe("Pause holds queued work", () => {
  test("the worker claims nothing while paused, and runs it after Resume", async () => {
    const { runId, jobId } = queued();
    const { calls, drain } = counting();
    controller.pause();
    expect(await drain()).toBe(0);
    expect(getJob(jobId)?.status).toBe("QUEUED");
    controller.resume();
    expect(await drain()).toBe(1);
    expect(calls).toEqual(["BEGIN"]);
    expect(getFlowRun(runId)?.status).toBe("SUCCEEDED");
  });

  test("a job claimed just as Jarvis was paused goes back untouched, and is not taken for a replay", async () => {
    const { runId, jobId } = queued();
    const { calls, drain, handler } = counting();
    const job = claimNextJob()!;
    controller.pause();
    await handler(job);
    expect(getJob(jobId)).toMatchObject({ status: "QUEUED", attempt: 0 });
    expect(getFlowRun(runId)?.status).toBe("QUEUED");
    controller.resume();
    await drain();
    expect(calls).toEqual(["BEGIN"]);
  });
});

describe("Kill stops every unfinished run", () => {
  test("queued, executing and waiting runs are stopped, saying why; finished ones are left alone", () => {
    const { flowId, versionId } = workflow();
    const runs = (["QUEUED", "RUNNING", "PAUSED", "SUCCEEDED"] as const).map((status) => createFlowRun({ flowId, flowVersionId: versionId, status }));
    expect(stopUnfinishedRunsForKill()).toBe(3);
    expect(runs.map((r) => getFlowRun(r.id)?.status)).toEqual(["STOPPED", "STOPPED", "STOPPED", "SUCCEEDED"]);
    expect(getFlowRun(runs[0]!.id)?.failedStep).toMatchObject({ errorMessage: KILLED_RUN_REASON });
    expect(listFlowFires(flowId).map((f) => f.label)).toEqual(["stopped", "stopped", "stopped"]);
  });

  test("a job claimed as Kill was pressed stops its run instead of starting it", async () => {
    const { runId } = queued();
    const { calls, handler } = counting();
    const job = claimNextJob()!;
    controller.kill();
    await handler(job);
    expect(calls).toEqual([]);
    expect(getFlowRun(runId)).toMatchObject({ status: "STOPPED", failedStep: { errorMessage: KILLED_RUN_REASON } });
  });
});

describe("Pause holds what would wake a waiting run", () => {
  function pausedRun() {
    const { flowId, versionId } = workflow();
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: "PAUSED" });
    return { flowId, runId: run.id };
  }

  test("a due timer wakes nothing while paused, and continues the run after Resume", () => {
    const { runId } = pausedRun();
    const wp = createWaitpoint({ flowRunId: runId, projectId: "p", stepName: "wait", type: "TIMER", resumeDateTime: "2026-10-07T09:00:00Z" });
    controller.pause();
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(0);
    expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();
    controller.resume();
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:02:00Z"))).toBe(1);
  });

  test("a resume URL answers 503 while paused and keeps its waitpoint", async () => {
    const { runId } = pausedRun();
    const wp = createWaitpoint({ flowRunId: runId, projectId: "p", stepName: "approve", type: "WEBHOOK" });
    controller.pause();
    const response = await resume(wp.id);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();
    controller.resume();
    expect((await resume(wp.id)).status).toBe(202);
  });

  test("a step parked on a hold is released by Resume, never by a URL", async () => {
    const { runId } = pausedRun();
    controller.pause();
    const hold = holdStep({ runId, projectId: "p", stepName: "send" });
    expect(releaseEmergencyHolds()).toBe(0);
    expect((await resume(hold.id)).status).toBe(403);
    controller.resume();
    expect(releaseEmergencyHolds()).toBe(1);
    const job = claimNextJob<{ executionType: string; waitpointId: string }>()!;
    expect(job.payload).toMatchObject({ executionType: "RESUME", waitpointId: hold.id });
  });

  test("the timer tick releases a hold left by a restart while paused", () => {
    const { runId } = pausedRun();
    const hold = holdStep({ runId, projectId: "p", stepName: "send" });
    expect(new TimerWaitpointScheduler().tick()).toBe(1);
    expect(getWaitpoint(hold.id)?.resumedAt).not.toBeNull();
  });
});

describe("starting a run by hand", () => {
  test("is refused while paused or stopped, saying why", async () => {
    const { flowId } = workflow();
    const run = () => createWorkflowRoutes()["/api/workflows/:id/run"]!.POST!(
      Object.assign(new Request(`http://localhost/api/workflows/${flowId}/run`, { method: "POST", body: "{}" }), { params: { id: flowId } }));
    controller.pause();
    const paused = await run();
    expect(paused.status).toBe(409);
    expect(await paused.text()).toContain("Jarvis is paused");
    controller.resume();
    controller.kill();
    expect(await (await run()).text()).toContain("stopped with Kill");
    controller.reset();
    expect((await run()).status).toBe(202);
  });
});

describe("the daemon's Kill and Resume (daemon/emergency-state.ts)", () => {
  function deps() {
    const authorityEngine = new AuthorityEngine({ default_level: 3, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 5 }, emergency_state: "normal" });
    const approvalManager = new ApprovalManager();
    const denied: string[] = [];
    return { authorityEngine, approvalManager, denied, onApprovalDenied: (r: { id: string }) => denied.push(r.id) };
  }

  test("Kill stops every unfinished run and denies every pending approval; the engine's copy of the state follows", () => {
    const d = deps();
    const { runId } = queued();
    const card = d.approvalManager.createRequest({ agentId: "a", agentName: "PA", toolName: "write_file", toolArguments: {},
      actionCategory: "write_data", urgency: "normal", reason: "r", context: "" });
    controller.kill();
    expect(applyEmergencyState("killed", d)).toMatchObject({ stoppedRuns: 1, deniedApprovals: 1 });
    expect(getFlowRun(runId)?.status).toBe("STOPPED");
    expect(d.denied).toEqual([card.id]);
    expect(d.authorityEngine.getConfig().emergency_state).toBe("killed");
  });

  test("Resume releases the steps held while paused", () => {
    const d = deps();
    const { flowId, versionId } = workflow();
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: "PAUSED" });
    controller.pause();
    applyEmergencyState("paused", d);
    holdStep({ runId: run.id, projectId: "p", stepName: "send" });
    controller.resume();
    expect(applyEmergencyState("normal", d)).toMatchObject({ releasedHolds: 1 });
    expect(d.authorityEngine.getConfig().emergency_state).toBe("normal");
  });
});
