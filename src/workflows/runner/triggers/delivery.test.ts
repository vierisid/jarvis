/**
 * Q-06: real trigger delivery through the real queue. Schedules fire through
 * the real CronScheduler in Jarvis's configured time zone (daylight-saving
 * transitions included), webhooks through the real ingress, events through
 * the bus; every delivery is claimed once, missed and blocked work is
 * recorded, and a workflow turned off cannot start anything.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../db/index";
import { setEncryptionKey } from "../../db/encryption";
import { createFlow, getFlow, setPublishedVersion, updateFlowStatus } from "../../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../../db/repos/flow-version";
import { listRuns, updateRun } from "../../db/repos/flow-run";
import { claimNextJob, queueStats } from "../../db/repos/job-queue";
import { configureWorkflowReadiness } from "../../db/repos/flow-readiness";
import { deleteConnection, upsertConnection } from "../../db/repos/app-connection";
import { listFlowFires, pruneFires, FIRE_RETENTION_MS } from "../../db/repos/trigger-fire";
import { PieceCatalog } from "../../runtime/piece-catalog";
import { WorkflowEventBus } from "../../runtime/event-bus";
import { WorkflowEventBuffer } from "../../runtime/event-buffer";
import { CronScheduler, setCronTimezone } from "../../../lib/cron-scheduler";
import type { EngineRuntime } from "../engine-runtime/engine-runtime";
import { TriggerManager } from "./manager";

const silent = () => undefined;
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  initWorkflowDb(":memory:");
  configureWorkflowReadiness({ pieces: new PieceCatalog([
    { name: "jarvis-trigger", displayName: "", description: "", actions: {}, triggers: { on_event: { name: "on_event", displayName: "", description: "" } } },
    { name: "private-piece", displayName: "", description: "", auth: { type: "SECRET_TEXT" }, actions: { send: { name: "send", displayName: "", description: "" } } },
  ]) });
});
afterEach(() => {
  setSystemTime();
  setCronTimezone(null);
  setEncryptionKey(null);
  closeWorkflowDb();
});

function publish(trigger: Record<string, unknown>): { flowId: string; versionId: string } {
  const flow = createFlow();
  const v = createDraftVersion({ flowId: flow.id, displayName: "Delivery" });
  updateDraftVersion(v.id, { trigger });
  lockVersion(v.id);
  setPublishedVersion(flow.id, v.id);
  updateFlowStatus(flow.id, "ENABLED");
  return { flowId: flow.id, versionId: v.id };
}
const schedule = (expression: string, input: Record<string, unknown> = {}) =>
  publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: expression, ...input } } });
const webhook = (input: Record<string, unknown> = {}, next?: Record<string, unknown>) =>
  publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "webhook", input }, ...(next ? { nextAction: next } : {}) });

/** A manager on a real CronScheduler, started at the mocked time. */
async function daemon(now: number) {
  setSystemTime(new Date(now));
  const cron = new CronScheduler();
  const bus = new WorkflowEventBus();
  const manager = new TriggerManager({ eventBus: bus, cronScheduler: cron, log: silent });
  await manager.start();
  return {
    cron, bus, manager,
    tick: (flowId: string, iso: string) => { setSystemTime(new Date(at(iso))); cron.runDue(`flow:${flowId}`, at(iso)); },
    stop: async () => { await manager.stop(); cron.cancelAll(); },
  };
}
const runsOf = (flowId: string) => listRuns({ flowId, limit: 100 });
const finishAll = (flowId: string) => { for (const run of runsOf(flowId)) updateRun(run.id, { status: "SUCCEEDED", finishTime: Date.now() }); };
const labels = (flowId: string) => listFlowFires(flowId).map(f => f.label);

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("schedules, in Jarvis's configured time zone", () => {
  test("the autumn hour that happens twice fires its 01:30 once, also across a restart", async () => {
    setCronTimezone("America/New_York");
    const { flowId } = schedule("30 1 * * *");
    let d = await daemon(at("2026-11-01T05:29:30Z")); // 01:29:30 EDT
    d.tick(flowId, "2026-11-01T05:30:10Z"); // 01:30 EDT
    expect(runsOf(flowId)).toHaveLength(1);
    finishAll(flowId);
    d.tick(flowId, "2026-11-01T06:30:10Z"); // 01:30 again, now EST
    expect(runsOf(flowId)).toHaveLength(1);
    // A restart between the two passes does not make it a new occurrence.
    await d.stop();
    d = await daemon(at("2026-11-01T06:29:50Z"));
    d.tick(flowId, "2026-11-01T06:30:10Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ dedupeKey: "2026-11-01T01:30", repeats: 1, label: "completed" });
    await d.stop();
  });

  test("a time skipped by the spring-forward jump fires once, right after it", async () => {
    setCronTimezone("America/New_York");
    const { flowId } = schedule("30 2 * * *");
    const d = await daemon(at("2026-03-08T06:58:30Z")); // 01:58:30 EST
    d.tick(flowId, "2026-03-08T06:59:10Z"); // 01:59 EST
    expect(runsOf(flowId)).toHaveLength(0);
    d.tick(flowId, "2026-03-08T07:00:10Z"); // 03:00 EDT: 02:00-02:59 never existed
    d.tick(flowId, "2026-03-08T07:01:10Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ dedupeKey: "2026-03-08T02:30", outcome: "started",
      detail: { reason: expect.stringContaining("did not exist when clocks moved forward") } });
    await d.stop();
  });

  test("a schedule that names another zone still fires in Jarvis's zone, and says so", async () => {
    setCronTimezone("Europe/Rome");
    const { flowId } = schedule("0 9 * * *", { timezone: "UTC" });
    const d = await daemon(at("2026-10-07T06:59:00Z"));
    expect(d.manager.list()).toEqual([expect.objectContaining({ flowId,
      warning: 'This schedule says UTC, but schedules run in Jarvis\'s time zone (Europe/Rome): "0 9 * * *" fires at that time in Europe/Rome.' })]);
    d.tick(flowId, "2026-10-07T07:00:10Z"); // 09:00 in Rome
    expect(runsOf(flowId)).toHaveLength(1);
    await d.stop();
  });

  test("a restart inside the firing minute does not run it twice", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("0 9 * * *");
    let d = await daemon(at("2026-10-07T08:59:50Z"));
    d.tick(flowId, "2026-10-07T09:00:10Z");
    finishAll(flowId);
    await d.stop();
    d = await daemon(at("2026-10-07T09:00:30Z"));
    d.tick(flowId, "2026-10-07T09:00:40Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ repeats: 1 });
    await d.stop();
  });

  test("times owed while Jarvis was off are recorded as missed and never run late", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("0 9 * * *");
    let d = await daemon(at("2026-10-07T08:00:00Z"));
    await d.stop();
    d = await daemon(at("2026-10-07T10:30:00Z"));
    d.tick(flowId, "2026-10-07T10:30:10Z");
    expect(runsOf(flowId)).toHaveLength(0);
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ label: "missed", scheduledFor: at("2026-10-07T09:00:00Z"),
      detail: { reason: "Jarvis was not running at that time" } })]);
    // Recorded once: another restart does not record it again.
    await d.stop();
    d = await daemon(at("2026-10-07T10:40:00Z"));
    expect(listFlowFires(flowId)).toHaveLength(1);
    await d.stop();
  });

  test("a sleep or stall skips what it slept through, and a slightly late tick still fires, marked delayed", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("*/5 * * * *");
    const d = await daemon(at("2026-10-07T09:00:40Z"));
    d.tick(flowId, "2026-10-07T09:01:50Z"); // 09:00 is 110s late: still within grace
    expect(listFlowFires(flowId)[0]).toMatchObject({ label: "delayed", lateMs: 110_000 });
    finishAll(flowId);
    d.tick(flowId, "2026-10-07T09:11:00Z"); // asleep since 09:01:50
    expect(runsOf(flowId)).toHaveLength(2); // 09:10, 60s late
    expect(listFlowFires(flowId).map(f => [f.label, f.dedupeKey])).toEqual([
      ["queued", "2026-10-07T09:10"],
      ["missed", "2026-10-07T09:05"],
      ["completed late", "2026-10-07T09:00"],
    ]);
    await d.stop();
  });

  test("a time whose previous run has not started yet is skipped, not stacked behind it", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("* * * * *");
    const d = await daemon(at("2026-10-07T09:00:00Z"));
    d.tick(flowId, "2026-10-07T09:00:10Z");
    d.tick(flowId, "2026-10-07T09:01:10Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(queueStats().queued).toBe(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ label: "skipped", detail: { reason: "The run from the previous time had not started yet." } });
    await d.stop();
  });

  test("a broken every-minute schedule is one failed run and one counted blocked row, not one per minute", async () => {
    setEncryptionKey(Buffer.alloc(32, 0x61));
    const save = () => upsertConnection({ externalId: "account", pieceName: "private-piece", displayName: "Synthetic", pieceVersion: "1", type: "SECRET_TEXT", value: { secret_text: "x" } });
    const connection = save();
    setCronTimezone("UTC");
    const { flowId } = publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "* * * * *" } },
      nextAction: { name: "send", type: "PIECE", settings: { pieceName: "private-piece", actionName: "send", input: { auth: "{{connections.account}}" } } } });
    const d = await daemon(at("2026-10-07T09:00:00Z"));
    deleteConnection(connection.id);
    for (const minute of ["00", "01", "02"]) d.tick(flowId, `2026-10-07T09:${minute}:10Z`);
    expect(runsOf(flowId).filter(r => r.status === "FAILED")).toHaveLength(1);
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ label: "blocked", repeats: 2,
      scheduledFor: at("2026-10-07T09:02:00Z"), detail: expect.objectContaining({ reason: expect.stringContaining("Connection is missing") }) })]);
    save();
    d.tick(flowId, "2026-10-07T09:03:10Z");
    expect(queueStats().queued).toBe(1);
    await d.stop();
  });

  test("a workflow turned off cannot start a run, even before its subscription is torn down", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("* * * * *");
    const d = await daemon(at("2026-10-07T09:00:00Z"));
    updateFlowStatus(flowId, "DISABLED"); // the refresh has not run yet
    d.tick(flowId, "2026-10-07T09:00:10Z");
    expect(runsOf(flowId)).toHaveLength(0);
    expect(listFlowFires(flowId)[0]).toMatchObject({ label: "blocked", detail: { reason: "The workflow is turned off." } });
    await d.stop();
  });

  test("an edited live draft replaces its schedule", async () => {
    setCronTimezone("UTC");
    const flow = createFlow();
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Live", trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } } } as any });
    updateFlowStatus(flow.id, "ENABLED");
    const d = await daemon(at("2026-10-07T08:58:00Z"));
    updateDraftVersion(draft.id, { trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 10 * * *" } } } as any });
    await d.manager.refresh(flow.id);
    d.tick(flow.id, "2026-10-07T09:00:10Z");
    expect(runsOf(flow.id)).toHaveLength(0);
    d.tick(flow.id, "2026-10-07T10:00:10Z");
    expect(runsOf(flow.id)).toHaveLength(1);
    await d.stop();
  });
});

describe("webhooks", () => {
  const post = (d: Awaited<ReturnType<typeof daemon>>, flowId: string, body: string, headers: Record<string, string> = {}) =>
    d.manager.webhookManager().handleRequest(flowId, new Request(`http://localhost/api/webhooks/${flowId}`, { method: "POST", body, headers }));

  test("a provider retrying the same delivery gets one run and its id back", async () => {
    const { flowId } = webhook();
    const d = await daemon(Date.now());
    const first = await (await post(d, flowId, '{"n":1}', { "X-GitHub-Delivery": "d-1" })).json() as Record<string, unknown>;
    const retry = await post(d, flowId, '{"n":1}', { "X-GitHub-Delivery": "d-1" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, outcome: "duplicate", duplicate: true, runId: first.runId, fireId: first.fireId });
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ repeats: 1, detail: { delivery: "x-github-delivery" } });
    await d.stop();
  });

  test("an event id in the body names the delivery too (Stripe, Slack)", async () => {
    const { flowId } = webhook();
    const d = await daemon(Date.now());
    await post(d, flowId, '{"id":"evt_1","object":"event"}');
    await post(d, flowId, '{"id":"evt_1","object":"event"}');
    await post(d, flowId, '{"event_id":"Ev1","type":"event_callback"}');
    await post(d, flowId, '{"event_id":"Ev1","type":"event_callback"}');
    expect(runsOf(flowId)).toHaveLength(2);
    await d.stop();
  });

  test("an identical signed request is one delivery for ten minutes; identical unsigned pings are not deduplicated", async () => {
    const signed = webhook({ secret: "s3cret" });
    const plain = webhook();
    const start = Date.now();
    const d = await daemon(start);
    const body = '{"ping":true}';
    const sig = await hmacHex("s3cret", body);
    expect((await post(d, signed.flowId, body, { "X-Jarvis-Signature": sig })).status).toBe(200);
    expect(await (await post(d, signed.flowId, body, { "X-Jarvis-Signature": sig })).json()).toMatchObject({ outcome: "duplicate" });
    setSystemTime(new Date(start + 11 * 60_000));
    expect(await (await post(d, signed.flowId, body, { "X-Jarvis-Signature": sig })).json()).toMatchObject({ outcome: "started" });
    expect(runsOf(signed.flowId)).toHaveLength(2);
    await post(d, plain.flowId, body);
    await post(d, plain.flowId, body);
    expect(runsOf(plain.flowId)).toHaveLength(2);
    await d.stop();
  });

  test("a workflow turned off answers 404 and starts nothing", async () => {
    const { flowId } = webhook();
    const d = await daemon(Date.now());
    updateFlowStatus(flowId, "DISABLED"); // the refresh has not run yet
    const response = await post(d, flowId, "{}", { "Idempotency-Key": "k-1" });
    expect(response.status).toBe(404);
    expect(runsOf(flowId)).toHaveLength(0);
    // Turned back on, the sender's retry of the same delivery runs.
    updateFlowStatus(flowId, "ENABLED");
    expect(await (await post(d, flowId, "{}", { "Idempotency-Key": "k-1" })).json()).toMatchObject({ outcome: "started" });
    await d.stop();
  });

  test("a delivery refused by readiness is kept for a person, and its retries do not pile up failed runs", async () => {
    setEncryptionKey(Buffer.alloc(32, 0x62));
    const connection = upsertConnection({ externalId: "account", pieceName: "private-piece", displayName: "S", pieceVersion: "1", type: "SECRET_TEXT", value: { secret_text: "x" } });
    const { flowId } = webhook({}, { name: "send", type: "PIECE", settings: { pieceName: "private-piece", actionName: "send", input: { auth: "{{connections.account}}" } } });
    const d = await daemon(Date.now());
    deleteConnection(connection.id);
    const refused = await post(d, flowId, '{"order":7}', { "Idempotency-Key": "o-7" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ ok: true, outcome: "blocked" });
    expect(await (await post(d, flowId, '{"order":7}', { "Idempotency-Key": "o-7" })).json()).toMatchObject({ outcome: "duplicate" });
    const failed = runsOf(flowId);
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.steps)).toContain('"order":7');
    await d.stop();
  });
});

describe("events", () => {
  const onEvent = (eventType: string) => publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: { eventType } } });

  test("an email announced again after a restart runs its workflow once", async () => {
    const { flowId } = onEvent("observer.email_received");
    let d = await daemon(Date.now());
    d.bus.publish("observer.email_received", { id: "m-1", subject: "Invoice" });
    await d.stop();
    d = await daemon(Date.now()); // email sync starts over and announces it again
    d.bus.publish("observer.email_received", { id: "m-1", subject: "Invoice" });
    d.bus.publish("observer.email_received", { id: "m-2", subject: "Other" });
    expect(runsOf(flowId)).toHaveLength(2);
    expect(claimNextJob<{ payload: { _eventKey: string } }>()?.payload.payload._eventKey).toBe("email:m-1");
    await d.stop();
  });

  test("a commitment re-announced as overdue runs once; rescheduled, it is a new event", async () => {
    const { flowId } = onEvent("commitment.overdue");
    const d = await daemon(Date.now());
    d.bus.publish("commitment.overdue", { id: "c-1", what: "Call", when_due: 1000 });
    d.bus.publish("commitment.overdue", { id: "c-1", what: "Call", when_due: 1000 });
    d.bus.publish("commitment.overdue", { id: "c-1", what: "Call", when_due: 2000 });
    expect(runsOf(flowId)).toHaveLength(2);
    await d.stop();
  });

  test("event ids start from a boot-unique base, so a cursor saved before a restart hides nothing", () => {
    const before = new WorkflowEventBuffer({ firstId: 1_000 });
    before.publish("x", {});
    const savedCursor = before.poll({ eventType: "x" }).cursor;
    const after = new WorkflowEventBuffer({ firstId: 2_000 });
    after.publish("x", { n: 1 });
    expect(after.poll({ eventType: "x", since: savedCursor }).events).toHaveLength(1);
  });

  test("a workflow deleted while its source is being polled does not take the daemon down", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = {
      acquire: async () => ({
        executeTriggerHook: async (hook: string) => {
          if (hook === "ON_ENABLE") return { listeners: [], scheduleOptions: { cronExpression: "* * * * *" } };
          await gate;
          return { output: [{ id: 1, eventType: "x", payload: {}, _dedupe_key: "1" }] };
        },
        release: async () => undefined,
      }),
    } as unknown as EngineRuntime;
    const { flowId } = onEvent("x");
    const cron = new CronScheduler();
    const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), cronScheduler: cron, engineRuntime: engine, log: silent });
    await manager.start();
    cron.runDue(`flow:${flowId}`, Date.now() + 60_000);
    getWorkflowDb().run("DELETE FROM flow WHERE id = ?", [flowId]);
    release();
    await new Promise((r) => setTimeout(r, 25));
    expect(listFlowFires(flowId)[0]).toMatchObject({ outcome: "blocked", detail: { reason: "The workflow no longer exists." } });
    await manager.stop();
  });
});

describe("the delivery ledger", () => {
  test("rows older than the retention are pruned", () => {
    const { flowId } = webhook();
    getWorkflowDb().run(`INSERT INTO workflow_trigger_fire (id, flow_id, source, observed_at, outcome) VALUES ('old', ?, 'webhook', ?, 'missed')`,
      [flowId, Date.now() - FIRE_RETENTION_MS - 1]);
    expect(pruneFires()).toBe(1);
    expect(getFlow(flowId)).not.toBeNull();
  });
});
