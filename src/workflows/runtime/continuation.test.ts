/**
 * Q-06: a paused run continues exactly once per pause, from the waitpoint
 * that pause is waiting on, and a workflow turned off never wakes its runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow, getFlow, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { claimNextJob, enqueue, getJob } from "../db/repos/job-queue";
import { createWaitpoint, getWaitpoint } from "../db/repos/waitpoint";
import { listFlowFires } from "../db/repos/trigger-fire";
import { TURNED_OFF_REASON } from "../db/repos/flow-turn-off";
import { ApprovalManager } from "../../authority/approval";
import { createWorkflowRoutes } from "../api/routes";
import { Worker } from "../queue/worker";
import { createRunFlowHandler, RUN_FLOW, type FlowExecutor } from "../runner/handler";
import { TimerWaitpointScheduler } from "../timer-scheduler";
import { resumeResolvedWorkflowEffects } from "./effect-approval-scheduler";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

const silent = () => undefined;
const at = (iso: string) => Date.parse(iso);
const EMPTY = { name: "trigger", type: "EMPTY" } as const;

function workflow(on = true) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Continuations", trigger: EMPTY as any });
  if (on) updateFlowStatus(flow.id, "ENABLED");
  return { flowId: flow.id, versionId: version.id };
}
function pausedRun(on = true, steps?: Record<string, unknown>) {
  const { flowId, versionId } = workflow(on);
  const run = createFlowRun({ flowId, flowVersionId: versionId, status: "PAUSED" });
  if (steps) updateRun(run.id, { steps });
  return { flowId, versionId, runId: run.id };
}
const timer = (runId: string, iso: string, stepName = "wait") =>
  createWaitpoint({ flowRunId: runId, projectId: "p", stepName, type: "TIMER", resumeDateTime: iso });
const hook = (runId: string, stepName = "approve") => createWaitpoint({ flowRunId: runId, projectId: "p", stepName, type: "WEBHOOK" });

const routes = () => createWorkflowRoutes();
const resume = (id: string, body = "{}") => routes()["/api/webhooks/waitpoints/:id"]!.POST!(
  Object.assign(new Request(`http://localhost/api/webhooks/waitpoints/${id}`, { method: "POST", body }), { params: { id } }));
const turnOff = (flowId: string) => routes()["/api/workflows/:id"]!.PATCH!(
  Object.assign(new Request(`http://localhost/api/workflows/${flowId}`, { method: "PATCH", body: JSON.stringify({ status: "DISABLED" }),
    headers: { "Content-Type": "application/json" } }), { params: { id: flowId } }));

function counting(status: "PAUSED" | "SUCCEEDED" = "SUCCEEDED") {
  const calls: string[] = [];
  const executor: FlowExecutor = { async execute(ctx) {
    calls.push(String((ctx.job.payload as { executionType?: string }).executionType ?? "BEGIN"));
    return { status, steps: {}, stepsCount: 0 };
  } };
  const drain = () => new Worker({ log: silent, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) } }).drain();
  return { calls, drain };
}

describe("one continuation per pause", () => {
  test("a due timer continues its run once, naming its waitpoint, and its lateness is recorded", () => {
    const { flowId, runId } = pausedRun();
    const wp = timer(runId, "2026-10-07T09:00:00Z");
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:03:00Z"))).toBe(1);
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:04:00Z"))).toBe(0);
    expect(claimNextJob<{ executionType: string; waitpointId: string }>()?.payload).toMatchObject({ executionType: "RESUME", waitpointId: wp.id });
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ source: "resume", lateMs: 180_000, label: "delayed",
      scheduledFor: at("2026-10-07T09:00:00Z"), dedupeKey: expect.stringMatching(/^waitpoint:/) })]);
    // A resume URL is a bearer capability: the record keeps only its digest.
    expect(JSON.stringify(listFlowFires(flowId))).not.toContain(wp.id);
  });

  test("while one continuation is queued, another is not queued behind it", async () => {
    const { runId } = pausedRun();
    const webhookWaitpoint = hook(runId);
    const due = timer(runId, "2026-10-07T09:00:00Z");
    expect((await resume(webhookWaitpoint.id)).status).toBe(202);
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(0);
    expect(getWaitpoint(due.id)?.resumedAt).toBeNull();
    const second = hook(runId, "other");
    const busy = await resume(second.id);
    expect(busy.status).toBe(409);
    expect(getWaitpoint(second.id)?.resumedAt).toBeNull();
  });

  test("a timer whose step already finished is retired, not used to wake the run's next pause", () => {
    const { flowId, runId } = pausedRun(true, {
      wait: { output: { type: "PIECE", status: "SUCCEEDED", input: {}, output: {} } },
      approve: { output: { type: "PIECE", status: "PAUSED", input: {}, output: {} } },
    });
    const stale = timer(runId, "2026-10-07T09:00:00Z", "wait");
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(0);
    expect(getWaitpoint(stale.id)?.resumedAt).not.toBeNull();
    expect(claimNextJob()).toBeNull();
    expect(listFlowFires(flowId)[0]).toMatchObject({ outcome: "skipped",
      detail: { reason: "The step this was waiting for had already finished, so it did not wake the run." } });
  });

  test("the handler continues a run only from the waitpoint that continuation consumed", async () => {
    const { runId } = pausedRun();
    const unconsumed = hook(runId);
    const job = enqueue({ jobType: RUN_FLOW, flowRunId: runId, maxAttempts: 1,
      payload: { runId, executionType: "RESUME", waitpointId: unconsumed.id, resumePayload: {} } });
    const { calls, drain } = counting();
    await drain();
    expect(calls).toEqual([]);
    expect(getFlowRun(runId)?.status).toBe("PAUSED");
    expect(getJob(job.id)).toMatchObject({ status: "FAILED", lastError: expect.stringContaining("its waitpoint was never consumed") });
  });

  test("the resume route consumes the waitpoint and queues the continuation together, or neither", async () => {
    const { runId } = pausedRun();
    const wp = hook(runId);
    getWorkflowDb().exec(`CREATE TEMP TRIGGER fail_enqueue BEFORE INSERT ON workflow_job BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect((await resume(wp.id)).status).toBe(500);
    expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();
    getWorkflowDb().exec(`DROP TRIGGER fail_enqueue`);
    expect((await resume(wp.id)).status).toBe(202);
    expect((await resume(wp.id)).status).toBe(410);
  });
});

describe("a workflow turned off never wakes its runs", () => {
  test("turning it off stops its waiting and queued runs, each saying why", async () => {
    const { flowId, versionId, runId: waiting } = pausedRun();
    timer(waiting, "2026-10-07T09:00:00Z");
    const queued = createFlowRun({ flowId, flowVersionId: versionId });
    enqueue({ jobType: RUN_FLOW, flowRunId: queued.id, maxAttempts: 1, payload: { runId: queued.id } });
    expect((await turnOff(flowId)).status).toBe(200);
    for (const runId of [waiting, queued.id]) {
      expect(getFlowRun(runId)).toMatchObject({ status: "STOPPED", failedStep: { errorMessage: TURNED_OFF_REASON } });
    }
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(0);
    expect(listFlowFires(flowId).map(f => f.label)).toEqual(["stopped", "stopped"]);
  });

  test("after a crash between turning off and stopping, the next continuation stops the run instead", async () => {
    const off = (flowId: string) => getWorkflowDb().run("UPDATE flow SET status = 'DISABLED', disabled_at = ? WHERE id = ?", [Date.now() + 1, flowId]);
    const viaTimer = pausedRun();
    timer(viaTimer.runId, "2026-10-07T09:00:00Z");
    off(viaTimer.flowId);
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(0);
    expect(getFlowRun(viaTimer.runId)?.status).toBe("STOPPED");

    const viaUrl = pausedRun();
    const wp = hook(viaUrl.runId);
    off(viaUrl.flowId);
    expect((await resume(wp.id)).status).toBe(409);
    expect(getFlowRun(viaUrl.runId)?.status).toBe("STOPPED");

    const { flowId, versionId } = workflow();
    const queued = createFlowRun({ flowId, flowVersionId: versionId });
    enqueue({ jobType: RUN_FLOW, flowRunId: queued.id, maxAttempts: 1, payload: { runId: queued.id } });
    off(flowId);
    const { calls, drain } = counting();
    await drain();
    expect(calls).toEqual([]);
    expect(getFlowRun(queued.id)?.status).toBe("STOPPED");
  });

  test("an approval granted after the workflow was turned off does not continue the run", () => {
    const { flowId, runId } = pausedRun(true, { send: { output: { type: "PIECE", status: "PAUSED", input: {}, output: {} } } });
    const approvals = new ApprovalManager();
    const request = approvals.createRequest({ agentId: `workflow:${runId}`, agentName: "Workflow", toolName: "send",
      toolArguments: {}, actionCategory: "send_email", urgency: "normal", reason: "test", context: "{}", executionMode: "workflow" });
    const wp = createWaitpoint({ flowRunId: runId, projectId: "p", stepName: "send", type: "MANUAL" });
    getWorkflowDb().run(`INSERT INTO workflow_effect (id, run_id, status, approval_id, waitpoint_id, record) VALUES ('e1', ?, 'pending', ?, ?, '{}')`,
      [runId, request.id, wp.id]);
    approvals.approve(request.id, "person");
    getWorkflowDb().run("UPDATE flow SET status = 'DISABLED', disabled_at = ? WHERE id = ?", [Date.now() + 1, flowId]);
    expect(resumeResolvedWorkflowEffects()).toBe(0);
    expect(getFlowRun(runId)?.status).toBe("STOPPED");
  });

  test("a test run of a workflow that was never on continues normally, even when it is set off again", async () => {
    const { flowId, runId } = pausedRun(false);
    timer(runId, "2026-10-07T09:00:00Z");
    expect(getFlow(flowId)?.status).toBe("DISABLED");
    expect((await turnOff(flowId)).status).toBe(200);
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(1);
  });

  test("a run started by hand after the workflow was turned off is not stopped", async () => {
    const { flowId, versionId } = workflow();
    expect((await turnOff(flowId)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2));
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: "PAUSED" });
    timer(run.id, "2026-10-07T09:00:00Z");
    expect(new TimerWaitpointScheduler().tick(at("2026-10-07T09:01:00Z"))).toBe(1);
  });
});

describe("a run continues on the graph it began on", () => {
  async function begun(locked: boolean) {
    const { flowId, versionId } = workflow(false);
    if (locked) lockVersion(versionId);
    const run = createFlowRun({ flowId, flowVersionId: versionId });
    enqueue({ jobType: RUN_FLOW, flowRunId: run.id, maxAttempts: 1, payload: { runId: run.id } });
    const harness = counting("PAUSED");
    await harness.drain();
    return { versionId, runId: run.id, ...harness };
  }

  test("a draft edited while its run was paused is not continued on the changed steps", async () => {
    const { versionId, runId, calls, drain } = await begun(false);
    updateDraftVersion(versionId, { trigger: { ...EMPTY, displayName: "Edited" } as any });
    expect((await resume(hook(runId).id)).status).toBe(202);
    await drain();
    expect(calls).toEqual(["BEGIN"]);
    expect(getFlowRun(runId)).toMatchObject({ status: "FAILED", failedStep: { name: "<resume>",
      errorMessage: expect.stringContaining("edited while the run was paused") } });
  });

  test("a published version, which cannot change, continues", async () => {
    const { runId, calls, drain } = await begun(true);
    expect((await resume(hook(runId).id)).status).toBe(202);
    await drain();
    expect(calls).toEqual(["BEGIN", "RESUME"]);
  });
});
