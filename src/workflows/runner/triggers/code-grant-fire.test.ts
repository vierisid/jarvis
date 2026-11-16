/**
 * The CODE-step permission is read when a delivery arrives, not only when a
 * trigger is registered. Revoking it must stop a published, enabled flow's
 * webhook, event and schedule from running the code, say why in the delivery
 * record, and take the subscription down; granting it again brings it back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../db/index";
import { createFlow, getFlow, setFlowCodeStepsEnabled, setPublishedVersion, updateFlowStatus } from "../../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../../db/repos/flow-version";
import { configureWorkflowReadiness } from "../../db/repos/flow-readiness";
import { queueStats } from "../../db/repos/job-queue";
import { PieceCatalog } from "../../runtime/piece-catalog";
import { WorkflowEventBus } from "../../runtime/event-bus";
import { createWorkflowRoutes } from "../../api/routes";
import { TriggerManager } from "./manager";

const silent = () => undefined;
const CODE_STEP = { name: "compute_totals", type: "CODE", displayName: "Compute totals",
  settings: { sourceCode: { packageJson: "{}", code: "export const code = async () => ({});" } } };

beforeEach(() => {
  initWorkflowDb(":memory:");
  configureWorkflowReadiness({ pieces: new PieceCatalog([
    { name: "p", displayName: "", description: "", actions: { a: { name: "a", displayName: "", description: "" } } },
    { name: "jarvis-trigger", displayName: "", description: "", actions: {}, triggers: { on_event: { name: "on_event", displayName: "", description: "", inputSchema: { fields: [{ name: "eventType", label: "", type: "string", required: true }] } } } },
  ]) });
});
afterEach(() => closeWorkflowDb());

/** Granted, published and enabled, as a flow that could only be enabled with the grant. */
function codeFlow(trigger: Record<string, unknown>): { flowId: string; versionId: string } {
  const flow = createFlow();
  setFlowCodeStepsEnabled(flow.id, true);
  const v = createDraftVersion({ flowId: flow.id, displayName: "Code flow" });
  updateDraftVersion(v.id, { trigger: { ...trigger, nextAction: { ...CODE_STEP } } });
  lockVersion(v.id);
  setPublishedVersion(flow.id, v.id);
  updateFlowStatus(flow.id, "ENABLED");
  return { flowId: flow.id, versionId: v.id };
}
const webhookTrigger = { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "webhook", input: {} } };
const hook = (tm: TriggerManager, flowId: string) => tm.webhookManager().handleRequest(flowId, new Request("http://x/webhook", {
  method: "POST", body: JSON.stringify({ n: Math.random() }), headers: { "Content-Type": "application/json" } }));
const settleTicks = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
const fires = (flowId: string) => getWorkflowDb().query<{ outcome: string; source: string; detail: string; repeats: number }, [string]>(
  "SELECT outcome, source, detail, repeats FROM workflow_trigger_fire WHERE flow_id = ? ORDER BY observed_at, rowid").all(flowId);

describe("revoking the CODE-step grant stops published triggers (B-1)", () => {
  test("a webhook fire after the revoke runs nothing and the delivery record says why", async () => {
    const { flowId } = codeFlow(webhookTrigger);
    const tm = new TriggerManager({ eventBus: new WorkflowEventBus(), log: silent });
    await tm.start();
    expect((await hook(tm, flowId)).status).toBe(200);
    await settleTicks();
    expect(queueStats().queued).toBe(1);

    // The revoke, before anything refreshes the registration.
    setFlowCodeStepsEnabled(flowId, false);
    const res = await hook(tm, flowId);
    await settleTicks();
    expect(res.status).toBe(404);
    expect(queueStats().queued).toBe(1);

    await hook(tm, flowId);
    const rows = fires(flowId);
    expect(rows.map((r) => r.outcome)).toEqual(["started", "blocked"]);
    const blocked = rows[1]!;
    expect(blocked.repeats).toBe(1); // the second refused delivery is counted on the same row
    const detail = JSON.parse(blocked.detail) as { reason: string; code: string };
    expect(detail.code).toBe("CODE_STEPS_NOT_ENABLED");
    expect(detail.reason).toContain("compute_totals");
    expect(detail.reason).toContain("not allowed for it any more");
    expect(detail.reason).toContain("Allow CODE steps");
    await tm.stop();
  });

  test("the grant route refreshes registrations: revoke removes the subscription, grant brings it back", async () => {
    const { flowId } = codeFlow(webhookTrigger);
    const tm = new TriggerManager({ eventBus: new WorkflowEventBus(), log: silent });
    await tm.start();
    expect(tm.list().map((s) => s.flowId)).toEqual([flowId]);
    const routes = createWorkflowRoutes({ triggerManager: tm });
    const grant = async (enabled: boolean) => {
      const req = new Request("http://localhost/api/workflows/x/code-steps", { method: "POST", body: JSON.stringify({ enabled }),
        headers: { "Content-Type": "application/json" } }) as Request & { params: Record<string, string> };
      req.params = { id: flowId };
      const response = await routes["/api/workflows/:id/code-steps"]!.POST!(req);
      await new Promise((r) => setTimeout(r, 20));
      return response.status;
    };
    expect(await grant(false)).toBe(200);
    expect(getFlow(flowId)!.code_steps_enabled).toBe(0);
    expect(tm.list()).toEqual([]);
    expect((await hook(tm, flowId)).status).toBe(404);
    expect(await grant(true)).toBe(200);
    expect(tm.list().map((s) => s.flowId)).toEqual([flowId]);
    expect((await hook(tm, flowId)).status).toBe(200);
    await tm.stop();
  });

  test("a scheduled time after the revoke is recorded as blocked with the reason, and runs nothing", async () => {
    const { flowId } = codeFlow({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } } });
    const jobs = new Map<string, () => void>();
    const cron = { schedule: (id: string, _e: string, cb: () => void) => { jobs.set(id, cb); }, cancel: (id: string) => { jobs.delete(id); }, cancelAll: () => jobs.clear() };
    const tm = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron as unknown as import("./cron").CronScheduler, log: silent });
    await tm.start();
    jobs.get(`flow:${flowId}`)!();
    await settleTicks();
    expect(queueStats().queued).toBe(1);
    setFlowCodeStepsEnabled(flowId, false);
    jobs.get(`flow:${flowId}`)!();
    await settleTicks();
    expect(queueStats().queued).toBe(1);
    const blocked = fires(flowId).filter((r) => r.outcome === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.source).toBe("schedule");
    expect(JSON.parse(blocked[0]!.detail).reason).toContain("CODE");
    await tm.stop();
  });

  test("an event poll for a revoked flow does not poll the source at all", async () => {
    const { flowId } = codeFlow({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: { eventType: "x" } } });
    let polls = 0;
    const handle = { async executeTriggerHook(hook: string) {
      if (hook === "ON_ENABLE") return { listeners: [], scheduleOptions: { cronExpression: "*/7 * * * *" } };
      if (hook === "RUN") { polls++; return { output: [{ id: 1 }] }; }
      return {};
    }, async release() {} };
    const jobs = new Map<string, () => void>();
    const cron = { schedule: (id: string, _e: string, cb: () => void) => { jobs.set(id, cb); }, cancel: (id: string) => { jobs.delete(id); }, cancelAll: () => jobs.clear() };
    const tm = new TriggerManager({ eventBus: new WorkflowEventBus(), engineRuntime: { acquire: async () => handle } as never,
      cronScheduler: cron as unknown as import("./cron").CronScheduler, log: silent });
    await tm.start();
    jobs.get(`flow:${flowId}`)!();
    await new Promise((r) => setTimeout(r, 30));
    expect(polls).toBe(1);
    setFlowCodeStepsEnabled(flowId, false);
    jobs.get(`flow:${flowId}`)!();
    await new Promise((r) => setTimeout(r, 30));
    expect(polls).toBe(1);
    await tm.stop();
  });

  test("a flow that keeps the grant is untouched", async () => {
    const { flowId } = codeFlow(webhookTrigger);
    const tm = new TriggerManager({ eventBus: new WorkflowEventBus(), log: silent });
    await tm.start();
    for (let i = 0; i < 3; i++) expect((await hook(tm, flowId)).status).toBe(200);
    await settleTicks();
    expect(queueStats().queued).toBe(3);
    expect(fires(flowId).every((r) => r.outcome === "started")).toBe(true);
    await tm.stop();
  });
});
