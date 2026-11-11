/**
 * #1154: the ordinary delete (DELETE /api/workflows/:id, manage_workflow
 * `delete`) removes what the Brief purge removes, in batches, and never
 * while an effect of the flow is still being dispatched.
 */
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../index";
import { createFlow, getFlow } from "./flow";
import { createDraftVersion } from "./flow-version";
import { createFlowRun, getFlowRun, updateRun } from "./flow-run";
import { enqueue, getJob } from "./job-queue";
import { saveWorkflowEffect, type WorkflowEffect } from "./workflow-effect";
import { createWorkflowRoutes } from "../../api/routes";
import { createManageWorkflowTool } from "../../../actions/tools/manage-workflow";
import { beginEffectDispatch } from "../../runtime/effect-inflight";
import { listUnreadDashboardNotifications, recordDashboardNotification } from "../../../vault/dashboard-notifications";
import { deleteWorkflow, FLOW_DELETE_BATCH, FLOW_DELETE_WAIT_MS, setDeletedWorkflowCardListener } from "./flow-deletion";

let dir: string, savedData: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-flow-delete-"));
  initWorkflowDb(join(dir, "workflow.db"));
  savedData = process.env.JARVIS_WORKFLOW_DATA_DIR;
  process.env.JARVIS_WORKFLOW_DATA_DIR = join(dir, "data");
});
afterEach(() => {
  closeWorkflowDb();
  rmSync(dir, { recursive: true, force: true });
  if (savedData === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR;
  else process.env.JARVIS_WORKFLOW_DATA_DIR = savedData;
});

const db = () => getWorkflowDb();
const count = (sql: string, ...args: string[]) => (db().query(sql).get(...args) as { n: number }).n;

function fixture() {
  const flow = createFlow({ projectId: DEFAULT_IDS.project });
  const version = createDraftVersion({ flowId: flow.id, displayName: "W", trigger: { name: "trigger", type: "EMPTY", settings: {} } });
  return { flow, version };
}

function cardFor(runId: string, flowId: string, versionId: string): string {
  const approvalId = crypto.randomUUID(), now = Date.now();
  db().run(`INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, urgency, reason, context, status, execution_mode, created_at)
    VALUES (?, 'workflow', 'Workflow', 'send_message', '{}', 'send_message', 'normal', 'r', '', 'pending', 'workflow', ?)`, [approvalId, now]);
  const effect: WorkflowEffect = { id: crypto.randomUUID(), runId, projectId: DEFAULT_IDS.project, flowId, versionId, versionDigest: "d",
    stepName: "notify", executionPath: [], route: "notify", toolName: "send_message", actionCategory: "send_message", requestDigest: "r",
    arguments: {}, target: {}, provenance: {}, decision: "approval_required", reason: "r", status: "pending", approvalId, waitpointId: null,
    createdAt: now } as WorkflowEffect;
  saveWorkflowEffect(effect);
  return approvalId;
}

/** Everything a flow leaves behind that the cascade from the flow row did not remove before #1154. */
function leftovers(flowId: string, versionId: string) {
  const finished = createFlowRun({ flowId, flowVersionId: versionId, status: "SUCCEEDED" });
  const card = cardFor(finished.id, flowId, versionId);
  db().run(`INSERT INTO workflow_file (id, project_id, flow_id, type, data, size, created) VALUES (?, ?, ?, 'FLOW_RUN_LOG', x'00', 1, 1)`,
    [crypto.randomUUID(), DEFAULT_IDS.project, flowId]);
  db().run(`INSERT INTO open_failure (key, source, run_id, flow_id, at) VALUES (?, 'run', ?, ?, 1)`, [`run:${finished.id}`, finished.id, flowId]);
  const store = (key: string) => db().run(`INSERT INTO store_entry (id, project_id, key, value, created, updated) VALUES (?, ?, ?, '1', 1, 1)`,
    [crypto.randomUUID(), DEFAULT_IDS.project, key]);
  store(`flow_${flowId}/k`);
  store(`testflow_${flowId}/k`);
  store("project-key");
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: finished.id }, flowRunId: finished.id });
  // A saved dashboard notification of this workflow, and one of another (#1344).
  const notice = recordDashboardNotification({ message: "from this flow", priority: "normal", workflowId: flowId, runId: finished.id });
  const otherNotice = recordDashboardNotification({ message: "from another flow", priority: "normal", workflowId: "other-flow" });
  const logs = join(dir, "data", "workflow-logs"), files = join(dir, "data", "workflow-files");
  mkdirSync(logs, { recursive: true });
  mkdirSync(join(files, flowId, "step"), { recursive: true });
  writeFileSync(join(logs, `${finished.id}.bin`), "state");
  writeFileSync(join(files, flowId, "step", "file__a.txt"), "data");
  return {
    card,
    check: () => {
      expect(getFlow(flowId)).toBeNull();
      expect(getFlowRun(finished.id)).toBeNull();
      for (const table of ["workflow_file", "open_failure"]) expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE flow_id = ?`, flowId)).toBe(0);
      expect((db().query("SELECT key FROM store_entry").all() as Array<{ key: string }>).map((r) => r.key)).toEqual(["project-key"]);
      expect(getJob(job.id)).toBeNull();
      expect(listUnreadDashboardNotifications().map((n) => n.id)).toEqual([otherNotice.id]);
      expect(notice.id).not.toBe(otherNotice.id);
      expect(existsSync(join(logs, `${finished.id}.bin`))).toBe(false);
      expect(existsSync(join(files, flowId))).toBe(false);
      // The card of a run that ended before it parked is closed, not left approvable (#1039).
      expect((db().query("SELECT status FROM approval_requests WHERE id = ?").get(card) as { status: string }).status).toBe("denied");
    },
  };
}

test("the dashboard delete removes run logs, step files, file rows, store keys, jobs and ended runs' cards, and tells the dashboard", async () => {
  const { flow, version } = fixture();
  const left = leftovers(flow.id, version.id);
  const closed: string[] = [];
  setDeletedWorkflowCardListener((id) => closed.push(id));
  const request = Object.assign(new Request(`http://local/api/workflows/${flow.id}`, { method: "DELETE" }), { params: { id: flow.id } });
  expect((await createWorkflowRoutes()["/api/workflows/:id"]!.DELETE!(request)).status).toBe(200);
  left.check();
  // The dashboard hears each card the delete closed, as it does for a purge.
  expect(closed).toEqual([left.card]);
});

test("manage_workflow delete removes the same and tells the dashboard; a failing listener does not stop it", async () => {
  const { flow, version } = fixture();
  const left = leftovers(flow.id, version.id);
  // A live run's card too: the delete stops the run and closes it.
  const live = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "RUNNING" });
  const liveCard = cardFor(live.id, flow.id, version.id);
  const closed: string[] = [];
  setDeletedWorkflowCardListener((id) => { closed.push(id); throw new Error("socket gone"); });
  const out = JSON.parse(await createManageWorkflowTool().execute({ action: "delete", flow: flow.id }) as string);
  expect(out).toEqual({ id: flow.id, deleted: true });
  left.check();
  // Every card is reported, the later one too after the listener threw on the first.
  expect(closed.sort()).toEqual([left.card, liveCard].sort());
});

test("a missing or foreign flow is not found and nothing is touched", async () => {
  const { flow } = fixture();
  expect(await deleteWorkflow("another-project", flow.id)).toEqual({ status: "not_found" });
  expect(await deleteWorkflow(DEFAULT_IDS.project, "missing")).toEqual({ status: "not_found" });
  expect(getFlow(flow.id)).not.toBeNull();
});

test("a large history goes in batches of FLOW_DELETE_BATCH, letting the event loop run between them", async () => {
  const { flow, version } = fixture();
  const total = 2 * FLOW_DELETE_BATCH + 500;
  db().transaction(() => {
    for (let i = 0; i < total; i++) createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "SUCCEEDED" });
  })();
  // What another task sees each time the delete lets the event loop run.
  const seen: number[] = [];
  let watching = true;
  const watch = () => {
    if (!watching) return;
    seen.push(count("SELECT COUNT(*) AS n FROM flow_run WHERE flow_id = ?", flow.id));
    setImmediate(watch);
  };
  setImmediate(watch);
  const outcome = await deleteWorkflow(DEFAULT_IDS.project, flow.id);
  watching = false;
  expect(outcome).toMatchObject({ status: "deleted", counts: { runs: total } });
  expect(getFlow(flow.id)).toBeNull();
  // Two full batches were taken while the rest of the daemon ran.
  expect(seen).toContain(total - FLOW_DELETE_BATCH);
  expect(seen).toContain(total - 2 * FLOW_DELETE_BATCH);
});

test("the delete waits for an effect still being dispatched, so its record is written before the run goes", async () => {
  const { flow, version } = fixture();
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  updateRun(run.id, { status: "RUNNING" });
  const end = beginEffectDispatch(flow.id);
  const deleting = deleteWorkflow(DEFAULT_IDS.project, flow.id);
  await new Promise((r) => setTimeout(r, 50));
  // Stopped, but still there while the effect is in flight.
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  expect(getFlow(flow.id)).not.toBeNull();
  // The effect returns and records itself against its run: the write the
  // delete used to make fail on the missing run (foreign key).
  cardFor(run.id, flow.id, version.id);
  expect(count("SELECT COUNT(*) AS n FROM workflow_effect WHERE run_id = ?", run.id)).toBe(1);
  end();
  expect(await deleting).toMatchObject({ status: "deleted" });
  expect(getFlow(flow.id)).toBeNull();
});

test("a run started while the delete waits is stopped before it is deleted (review)", async () => {
  const { flow, version } = fixture();
  const end = beginEffectDispatch(flow.id);
  const deleting = deleteWorkflow(DEFAULT_IDS.project, flow.id);
  await new Promise((r) => setTimeout(r, 20));
  // A trigger fires meanwhile: the flow stays on while it is deleted.
  const late = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  updateRun(late.id, { status: "RUNNING" });
  enqueue({ jobType: "RUN_FLOW", payload: { runId: late.id }, flowRunId: late.id });
  end();
  expect(await deleting).toMatchObject({ status: "deleted" });
  // Stopped (and its stop recorded in the trigger ledger, which outlives the flow) before it went.
  expect(count("SELECT COUNT(*) AS n FROM workflow_trigger_fire WHERE run_id = ? AND outcome = 'stopped'", late.id)).toBe(1);
});

test("an effect that starts between batches holds the next batch until it is recorded (review)", async () => {
  const { flow, version } = fixture();
  const total = 2 * FLOW_DELETE_BATCH + 500;
  db().transaction(() => {
    for (let i = 0; i < total; i++) createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "SUCCEEDED" });
  })();
  const runs = () => count("SELECT COUNT(*) AS n FROM flow_run WHERE flow_id = ?", flow.id);
  let during: number[] = [];
  // The first time the delete lets the event loop run (after its first
  // batch), an effect of the flow starts, and ends 50 ms later.
  setImmediate(() => {
    const end = beginEffectDispatch(flow.id);
    during.push(runs());
    setTimeout(() => {
      during.push(runs());
      end();
    }, 50);
  });
  expect(await deleteWorkflow(DEFAULT_IDS.project, flow.id)).toMatchObject({ status: "deleted", counts: { runs: total } });
  expect(during).toHaveLength(2);
  expect(during[0]).toBe(total - FLOW_DELETE_BATCH);
  // Nothing more went while it was in flight.
  expect(during[1]).toBe(during[0]);
});

test("the dashboard answers 409 workflow_stopping, and manage_workflow says to retry, when the wait runs out", async () => {
  const { flow } = fixture();
  db().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  const end = beginEffectDispatch(flow.id);
  jest.useFakeTimers();
  try {
    const request = Object.assign(new Request(`http://local/api/workflows/${flow.id}`, { method: "DELETE" }), { params: { id: flow.id } });
    let settled = 0;
    const answering = Promise.resolve(createWorkflowRoutes()["/api/workflows/:id"]!.DELETE!(request)).finally(() => settled++);
    const telling = createManageWorkflowTool().execute({ action: "delete", flow: flow.id })
      .then(() => null, (e: Error) => e.message).finally(() => settled++);
    await Promise.resolve();
    // Both wait the whole FLOW_DELETE_WAIT_MS, not less.
    jest.advanceTimersByTime(FLOW_DELETE_WAIT_MS - 1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(0);
    jest.advanceTimersByTime(2);
    const response = await answering;
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; code: string };
    expect(body.code).toBe("workflow_stopping");
    expect(body.error).toContain("Try the delete again");
    expect(await telling).toContain("Try the delete again");
    // Still there, and turned off.
    expect(getFlow(flow.id)?.status).toBe("DISABLED");
  } finally {
    jest.useRealTimers();
    end();
  }
});

test("an effect still in flight when the wait runs out answers stopping and deletes nothing", async () => {
  expect(FLOW_DELETE_WAIT_MS).toBe(10_000);
  const { flow, version } = fixture();
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  const end = beginEffectDispatch(flow.id);
  try {
    expect(await deleteWorkflow(DEFAULT_IDS.project, flow.id, { waitMs: 30 })).toEqual({ status: "stopping" });
    expect(getFlow(flow.id)).not.toBeNull();
    expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  } finally {
    end();
  }
  expect(await deleteWorkflow(DEFAULT_IDS.project, flow.id, { waitMs: 30 })).toMatchObject({ status: "deleted" });
});
