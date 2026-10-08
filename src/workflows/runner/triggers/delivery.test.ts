/**
 * Q-06: real trigger delivery through the real queue. Schedules fire through
 * the real CronScheduler in Jarvis's configured time zone (daylight-saving
 * transitions included), webhooks through the real ingress, events through
 * the bus and, as production runs them, through a stand-in engine; every
 * delivery is claimed once, missed and blocked work is recorded, and a
 * workflow turned off cannot start anything.
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
import { listFlowFires, pageFlowFires, pruneFires, recordFire, FIRE_RETENTION_MS } from "../../db/repos/trigger-fire";
import { PieceCatalog } from "../../runtime/piece-catalog";
import { WorkflowEventBus } from "../../runtime/event-bus";
import { WorkflowEventBuffer } from "../../runtime/event-buffer";
import { CronScheduler, setCronTimezone } from "../../../lib/cron-scheduler";
import type { EngineRuntime } from "../engine-runtime/engine-runtime";
import { createWorkflowRoutes } from "../../api/routes";
import { Worker } from "../../queue/worker";
import { createRunFlowHandler, RUN_FLOW } from "../handler";
import { scheduleZoneWarning, TriggerManager } from "./manager";
import { EmergencyController, setActiveEmergencyController } from "../../../authority/emergency";

const silent = () => undefined;
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  initWorkflowDb(":memory:");
  configureWorkflowReadiness({ pieces: new PieceCatalog([
    { name: "jarvis-trigger", displayName: "", description: "", actions: {}, triggers: { on_event: { name: "on_event", displayName: "", description: "" } } },
    { name: "private-piece", displayName: "", description: "", auth: { type: "SECRET_TEXT" }, actions: { send: { name: "send", displayName: "", description: "" } } },
    { name: "note-piece", displayName: "", description: "", actions: { add: { name: "add", displayName: "", description: "" } } },
    { name: "@activepieces/piece-schedule", displayName: "", description: "", actions: {}, triggers: { cron_expression: { name: "cron_expression", displayName: "", description: "" } } },
  ]) });
});
afterEach(() => {
  setSystemTime();
  setCronTimezone(null);
  setEncryptionKey(null);
  setActiveEmergencyController(null);
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

/** A manager on a real CronScheduler, started at the mocked time; with an engine, as production runs. */
async function daemon(now: number, engineRuntime?: EngineRuntime) {
  setSystemTime(new Date(now));
  const cron = new CronScheduler();
  const bus = new WorkflowEventBus();
  const manager = new TriggerManager({ eventBus: bus, cronScheduler: cron, log: silent, ...(engineRuntime ? { engineRuntime } : {}) });
  await manager.start();
  const tick = (flowId: string, iso: string) => { setSystemTime(new Date(at(iso))); cron.runDue(`flow:${flowId}`, at(iso)); };
  return {
    cron, bus, manager, tick,
    /** A tick whose engine poll has finished. */
    poll: async (flowId: string, iso: string) => { tick(flowId, iso); await settle(); },
    stop: async () => { await manager.stop(); cron.cancelAll(); },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A stand-in engine: ON_ENABLE answers `enable`, each RUN (a poll) answers `poll()`. */
function stubEngine(opts: { enable: Record<string, unknown>; poll?: () => unknown[] | Promise<unknown[]> }) {
  const hooks: string[] = [];
  const engine = {
    acquire: async () => ({
      executeTriggerHook: async (hook: string) => {
        hooks.push(hook);
        if (hook === "ON_ENABLE") return opts.enable;
        if (hook === "RUN") return { output: await (opts.poll?.() ?? []) };
        return {};
      },
      release: async () => undefined,
    }),
  } as unknown as EngineRuntime;
  return { engine, hooks };
}
const post = (d: { manager: TriggerManager }, flowId: string, body: string, headers: Record<string, string> = {}) =>
  d.manager.webhookManager().handleRequest(flowId, new Request(`http://localhost/api/webhooks/${flowId}`, { method: "POST", body, headers }));
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
      detail: { reason: "The schedule was not running at that time" } })]);
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

  test("a restart just after a scheduled time still runs it, late, and past the grace window it is missed", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("30 9 * * *");
    let d = await daemon(at("2026-10-07T09:00:00Z"));
    await d.stop();
    d = await daemon(at("2026-10-07T09:31:10Z")); // back 70 seconds after 09:30
    d.tick(flowId, "2026-10-07T09:31:20Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ dedupeKey: "2026-10-07T09:30", lateMs: 80_000, label: "delayed" })]);
    await d.stop();
    d = await daemon(at("2026-10-08T09:32:30Z")); // back 150 seconds after 09:30
    d.tick(flowId, "2026-10-08T09:32:40Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)[0]).toMatchObject({ dedupeKey: "2026-10-08T09:30", label: "missed" });
    expect(listFlowFires(flowId)).toHaveLength(2);
    await d.stop();
  });

  test("a long sleep lists the newest 100 missed times, counts the older ones in one row, and runs the one still due", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("* * * * *");
    const d = await daemon(at("2026-10-07T09:00:00Z"));
    d.tick(flowId, "2026-10-07T09:00:10Z");
    finishAll(flowId);
    d.tick(flowId, "2026-10-07T11:31:30Z"); // asleep since 09:00:10
    const fires = listFlowFires(flowId, { limit: 200 });
    const missed = fires.filter(f => f.label === "missed");
    expect(missed).toHaveLength(101);
    expect(missed.filter(f => f.dedupeKey).map(f => f.dedupeKey)).toEqual(
      Array.from({ length: 100 }, (_, i) => new Date(at("2026-10-07T11:29:00Z") - i * 60_000).toISOString().slice(0, 16)));
    expect(missed.find(f => !f.dedupeKey)).toMatchObject({ scheduledFor: at("2026-10-07T09:01:00Z"),
      detail: { reason: "Jarvis was asleep or too busy at that time", count: 49, through: at("2026-10-07T09:49:00Z") } });
    expect(fires[0]).toMatchObject({ label: "skipped", dedupeKey: "2026-10-07T11:31" });
    expect(fires[1]).toMatchObject({ label: "delayed", dedupeKey: "2026-10-07T11:30" });
    await d.stop();
  });

  test("a schedule switched to another trigger and back is not owed the time in between", async () => {
    setCronTimezone("UTC");
    const flow = createFlow();
    const daily = { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } } };
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Switch", trigger: daily as any });
    updateFlowStatus(flow.id, "ENABLED");
    const d = await daemon(at("2026-10-07T08:00:00Z"));
    updateDraftVersion(draft.id, { trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "webhook", input: {} } } as any });
    await d.manager.refresh(flow.id);
    setSystemTime(new Date(at("2026-10-07T10:30:00Z")));
    updateDraftVersion(draft.id, { trigger: daily as any });
    await d.manager.refresh(flow.id);
    expect(listFlowFires(flow.id)).toEqual([]);
    await d.stop();
  });

  test("a schedule refused at registration is not owed the time it stayed refused", async () => {
    setEncryptionKey(Buffer.alloc(32, 0x63));
    const save = () => upsertConnection({ externalId: "account", pieceName: "private-piece", displayName: "S", pieceVersion: "1", type: "SECRET_TEXT", value: { secret_text: "x" } });
    const connection = save();
    setCronTimezone("UTC");
    const { flowId } = publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } },
      nextAction: { name: "send", type: "PIECE", settings: { pieceName: "private-piece", actionName: "send", input: { auth: "{{connections.account}}" } } } });
    let d = await daemon(at("2026-10-07T08:00:00Z"));
    await d.stop();
    deleteConnection(connection.id);
    d = await daemon(at("2026-10-07T08:30:00Z")); // refused: its connection is gone
    await d.stop();
    save();
    d = await daemon(at("2026-10-07T10:30:00Z"));
    expect(listFlowFires(flowId).filter(f => f.label === "missed")).toEqual([]);
    await d.stop();
  });

  test("a run that waits in the queue past a minute reads as delayed, and completed late once it ran", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("0 9 * * *");
    const d = await daemon(at("2026-10-07T08:59:50Z"));
    d.tick(flowId, "2026-10-07T09:00:10Z");
    expect(labels(flowId)).toEqual(["queued"]);
    setSystemTime(new Date(at("2026-10-07T09:05:00Z"))); // the worker was busy
    expect(labels(flowId)).toEqual(["delayed"]);
    await new Worker({ log: silent, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: { execute: async () => ({ steps: {}, stepsCount: 0 }) } }) } }).drain();
    expect(listFlowFires(flowId)[0]).toMatchObject({ label: "completed late", startedAt: at("2026-10-07T09:05:00Z"), lateMs: 10_000 });
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

  test("an event id in the body names the delivery too (Stripe, Slack), and only in that provider's envelope", async () => {
    const { flowId } = webhook();
    const d = await daemon(Date.now());
    await post(d, flowId, '{"id":"evt_1","object":"event"}');
    await post(d, flowId, '{"id":"evt_1","object":"event"}');
    await post(d, flowId, '{"event_id":"Ev1","type":"event_callback","team_id":"T1"}');
    await post(d, flowId, '{"event_id":"Ev1","type":"event_callback","team_id":"T1"}');
    expect(runsOf(flowId)).toHaveLength(2);
    // Another sender's `event_id` need not name one delivery: a relay posting
    // each change to the same calendar event.
    await post(d, flowId, '{"event_id":"cal-123","summary":"Moved"}');
    await post(d, flowId, '{"event_id":"cal-123","summary":"Moved"}');
    expect(runsOf(flowId)).toHaveLength(4);
    await d.stop();
  });

  test("on a signed workflow only what the signature covers names a delivery: a replay under a fresh id header is a repeat", async () => {
    const { flowId } = webhook({ secret: "s3cret" });
    const start = Date.now();
    const d = await daemon(start);
    const body = '{"order":1}';
    const sig = await hmacHex("s3cret", body);
    expect(await (await post(d, flowId, body, { "X-Jarvis-Signature": sig, "Idempotency-Key": "a" })).json()).toMatchObject({ outcome: "started" });
    expect(await (await post(d, flowId, body, { "X-Jarvis-Signature": sig, "Idempotency-Key": "b" })).json()).toMatchObject({ outcome: "duplicate" });
    // An event id inside the signed body names the delivery past the ten minutes.
    const event = '{"id":"evt_9","object":"event"}';
    const eventSig = await hmacHex("s3cret", event);
    await post(d, flowId, event, { "X-Jarvis-Signature": eventSig });
    setSystemTime(new Date(start + 11 * 60_000));
    expect(await (await post(d, flowId, event, { "X-Jarvis-Signature": eventSig })).json()).toMatchObject({ outcome: "duplicate" });
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

describe("through the engine, as production runs triggers", () => {
  const onEvent = (eventType: string) => publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: { eventType } } });
  const pieceSchedule = (expression: string, timezone: string) => ({
    ...publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "@activepieces/piece-schedule", triggerName: "cron_expression", input: { cronExpression: expression, timezone } } }),
    enable: { listeners: [], scheduleOptions: { cronExpression: expression, timezone } },
  });

  test("an email announced again after a restart runs its workflow once", async () => {
    // A restart starts the trigger's cursor over, so the same email comes back under a new buffer id.
    const polls = [
      [{ id: "7", eventType: "observer.email_received", payload: { id: "m-1", _eventKey: "email:m-1" }, timestamp: 1, _dedupe_key: "7" }],
      [{ id: "2000001", eventType: "observer.email_received", payload: { id: "m-1", _eventKey: "email:m-1" }, timestamp: 2, _dedupe_key: "2000001" }],
    ];
    const { engine } = stubEngine({ enable: { listeners: [], scheduleOptions: { cronExpression: "* * * * *" } }, poll: () => polls.shift() ?? [] });
    const { flowId } = onEvent("observer.email_received");
    let d = await daemon(at("2026-10-07T09:00:00Z"), engine);
    await d.poll(flowId, "2026-10-07T09:00:10Z");
    await d.stop();
    d = await daemon(at("2026-10-07T09:05:00Z"), engine);
    await d.poll(flowId, "2026-10-07T09:05:10Z");
    expect(runsOf(flowId)).toHaveLength(1);
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ source: "poll", dedupeKey: "event:email:m-1", repeats: 1 })]);
    await d.stop();
  });

  test("the dashboard's schedule piece keeps the schedule rules: the zone warning, the spring-forward time, overlap and missed times", async () => {
    setCronTimezone("America/New_York");
    const { flowId, enable } = pieceSchedule("30 2 * * *", "UTC");
    const { engine } = stubEngine({ enable, poll: () => [{ firedAt: Date.now() }] });
    let d = await daemon(at("2026-03-08T06:58:30Z"), engine); // 01:58:30 EST
    expect(d.manager.list()).toEqual([expect.objectContaining({ flowId, warning: expect.stringContaining("This schedule says UTC") })]);
    d.tick(flowId, "2026-03-08T06:59:10Z"); // 01:59 EST
    await d.poll(flowId, "2026-03-08T07:00:10Z"); // 03:00 EDT: 02:30 never existed
    expect(listFlowFires(flowId)[0]).toMatchObject({ source: "schedule", dedupeKey: "2026-03-08T02:30", outcome: "started",
      detail: { reason: expect.stringContaining("did not exist when clocks moved forward") } });
    await d.poll(flowId, "2026-03-09T06:30:10Z"); // the next 02:30, with the first run still queued
    expect(runsOf(flowId)).toHaveLength(1);
    await d.stop();
    d = await daemon(at("2026-03-10T07:00:00Z"), engine); // off through the 02:30 after that
    expect(listFlowFires(flowId).map(f => [f.label, f.dedupeKey])).toEqual([
      ["missed", "2026-03-10T02:30"],
      ["skipped", "2026-03-09T02:30"],
      ["delayed", "2026-03-08T02:30"],
    ]);
    await d.stop();
  });

  test("a scheduled time that cannot run still leaves a row: a check still running, an engine failure, a workflow turned off", async () => {
    setCronTimezone("UTC");
    const { flowId, enable } = pieceSchedule("* * * * *", "UTC");
    let mode: "hang" | "fail" = "hang";
    let release!: () => void;
    const { engine } = stubEngine({ enable, poll: async () => {
      if (mode === "hang") await new Promise<void>((resolve) => { release = resolve; });
      if (mode === "fail") throw new Error("engine unavailable");
      return [{}];
    } });
    const d = await daemon(at("2026-10-07T09:00:00Z"), engine);
    d.tick(flowId, "2026-10-07T09:00:10Z"); // its check hangs
    await d.poll(flowId, "2026-10-07T09:01:10Z");
    mode = "fail";
    release();
    await settle();
    await d.poll(flowId, "2026-10-07T09:02:10Z");
    updateFlowStatus(flowId, "DISABLED"); // before the refresh tears it down
    await d.poll(flowId, "2026-10-07T09:03:10Z");
    const byTime = Object.fromEntries(listFlowFires(flowId).map(f => [new Date(f.scheduledFor!).toISOString().slice(11, 16), [f.label, f.detail?.reason]]));
    expect(byTime).toEqual({
      "09:00": ["blocked", "The schedule could not run: engine unavailable"],
      "09:01": ["skipped", "The previous check of this schedule was still running."],
      "09:02": ["blocked", "The schedule could not run: engine unavailable"],
      "09:03": ["blocked", "The workflow is turned off."],
    });
    expect(runsOf(flowId)).toHaveLength(0);
    await d.stop();
  });

  test("saving a step of a live draft keeps its trigger registered; changing the trigger re-registers it", async () => {
    const { engine, hooks } = stubEngine({ enable: { listeners: [], scheduleOptions: { cronExpression: "* * * * *" } } });
    const flow = createFlow();
    const trigger = { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: { eventType: "x" } } };
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Live", trigger: trigger as any });
    updateFlowStatus(flow.id, "ENABLED");
    const d = await daemon(Date.now(), engine);
    const routes = createWorkflowRoutes({ triggerManager: d.manager });
    const save = async (next: Record<string, unknown>) => {
      const response = await routes["/api/workflows/:id/versions/:versionId"]!.PATCH!(Object.assign(
        new Request(`http://localhost/api/workflows/${flow.id}/versions/${draft.id}`, { method: "PATCH",
          body: JSON.stringify({ trigger: next }), headers: { "Content-Type": "application/json" } }),
        { params: { id: flow.id, versionId: draft.id } }));
      expect(response.status).toBe(200);
      await d.manager.refresh(flow.id); // queued behind the refresh the save started
    };
    const enables = () => hooks.filter(h => h === "ON_ENABLE").length;
    expect(enables()).toBe(1);
    await save({ ...trigger, nextAction: { name: "note", type: "PIECE", settings: { pieceName: "note-piece", actionName: "add", input: {} } } });
    expect(enables()).toBe(1);
    await save({ ...trigger, settings: { ...trigger.settings, input: { eventType: "y" } } });
    expect(enables()).toBe(2);
    await d.stop();
  });
});

describe("Pause and Kill (Q-08)", () => {
  function emergency() {
    const controller = new EmergencyController();
    setActiveEmergencyController(controller);
    return controller;
  }

  test("a scheduled time while paused is skipped and shown, and not run late after Resume", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("0 9 * * *");
    const controller = emergency();
    const d = await daemon(at("2026-10-07T08:59:50Z"));
    controller.pause();
    d.tick(flowId, "2026-10-07T09:00:10Z");
    expect(runsOf(flowId)).toHaveLength(0);
    expect(listFlowFires(flowId)).toEqual([expect.objectContaining({ label: "skipped", dedupeKey: "2026-10-07T09:00",
      detail: { reason: "Jarvis was paused, so this did not run." } })]);
    controller.resume();
    // A restart inside the grace window looks at 09:00 again: it is a repeat, not a run.
    await d.stop();
    const again = await daemon(at("2026-10-07T09:01:00Z"));
    again.tick(flowId, "2026-10-07T09:01:10Z");
    expect(runsOf(flowId)).toHaveLength(0);
    await again.stop();
  });

  test("a webhook while paused is told to retry later, and its retry after Resume runs", async () => {
    const { flowId } = webhook();
    const controller = emergency();
    const d = await daemon(Date.now());
    controller.pause();
    const paused = await post(d, flowId, "{}", { "Idempotency-Key": "k-9" });
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("60");
    expect(runsOf(flowId)).toHaveLength(0);
    controller.resume();
    expect(await (await post(d, flowId, "{}", { "Idempotency-Key": "k-9" })).json()).toMatchObject({ outcome: "started" });
    await d.stop();
  });

  test("an event source is not polled while paused, so its items wait for Resume; a schedule piece time is skipped", async () => {
    setCronTimezone("UTC");
    let polls = 0;
    const { engine } = stubEngine({ enable: { listeners: [], scheduleOptions: { cronExpression: "* * * * *" } }, poll: () => { polls++; return []; } });
    const events = publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: { eventType: "x" } } });
    const piece = publish({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "@activepieces/piece-schedule", triggerName: "cron_expression", input: { cronExpression: "* * * * *", timezone: "UTC" } } });
    const controller = emergency();
    const d = await daemon(at("2026-10-07T09:00:00Z"), engine);
    controller.pause();
    await d.poll(events.flowId, "2026-10-07T09:00:10Z");
    await d.poll(piece.flowId, "2026-10-07T09:00:10Z");
    expect(polls).toBe(0);
    expect(listFlowFires(piece.flowId)).toEqual([expect.objectContaining({ label: "skipped", detail: { reason: "Jarvis was paused, so this time was skipped." } })]);
    controller.resume();
    await d.poll(events.flowId, "2026-10-07T09:01:10Z");
    expect(polls).toBe(1);
    await d.stop();
  });

  test("after Kill nothing starts either, saying so", async () => {
    setCronTimezone("UTC");
    const { flowId } = schedule("* * * * *");
    const controller = emergency();
    const d = await daemon(at("2026-10-07T09:00:00Z"));
    controller.kill();
    d.tick(flowId, "2026-10-07T09:00:10Z");
    expect(runsOf(flowId)).toHaveLength(0);
    expect(listFlowFires(flowId)[0]).toMatchObject({ label: "skipped", detail: { reason: "Jarvis was stopped with Kill, so this did not run." } });
    await d.stop();
  });
});

describe("the time-zone warning", () => {
  test("compares when the schedule actually fires in the two zones", () => {
    setCronTimezone("UTC");
    expect(scheduleZoneWarning("0 * * * *", "Asia/Kolkata")).toContain("This schedule says Asia/Kolkata"); // :00 UTC is :30 there
    expect(scheduleZoneWarning("*/15 * * * *", "Asia/Kolkata")).toBeUndefined();
    setCronTimezone("Europe/Rome");
    expect(scheduleZoneWarning("0 * * * *", "UTC")).toBeUndefined();
    // Mondays begin two hours apart, and a two-hourly schedule lines up only in summer.
    expect(scheduleZoneWarning("0 * * * 1", "UTC", at("2026-10-04T21:00:00Z"))).toContain("This schedule says UTC");
    expect(scheduleZoneWarning("0 */2 * * *", "UTC", at("2026-07-01T00:00:00Z"))).toContain("This schedule says UTC");
    expect(scheduleZoneWarning("0 9 * * *", "Europe/Rome")).toBeUndefined();
  });
});

describe("the delivery ledger", () => {
  test("pages newest first without skipping rows handled in the same millisecond", () => {
    const { flowId } = webhook();
    const now = Date.now();
    for (const reason of ["r0", "r1", "r2"]) recordFire({ flowId, source: "webhook", observedAt: now, outcome: "skipped", detail: { reason } });
    const first = pageFlowFires(flowId, { limit: 2.5 }); // a fractional limit is rounded down
    expect(first.fires.map(f => f.detail?.reason)).toEqual(["r2", "r1"]);
    expect(pageFlowFires(flowId, { limit: 2, cursor: first.next })).toEqual({ fires: [expect.objectContaining({ detail: { reason: "r0" } })], next: null });
  });

  test("the API pages the ledger and shows the delivery that started a run", async () => {
    const { flowId } = webhook();
    const d = await daemon(Date.now());
    const first = await (await post(d, flowId, "{}", { "Idempotency-Key": "a" })).json() as { runId: string; fireId: string };
    await post(d, flowId, "{}", { "Idempotency-Key": "b" });
    const routes = createWorkflowRoutes();
    const get = async (route: string, url: string, params: Record<string, string>) =>
      (await routes[route]!.GET!(Object.assign(new Request(`http://localhost${url}`), { params }))).json() as Promise<any>;
    const page = await get("/api/workflows/:id/fires", `/api/workflows/${flowId}/fires?limit=1`, { id: flowId });
    expect(page.fires).toEqual([expect.objectContaining({ dedupeKey: "delivery:idempotency-key:b", label: "queued" })]);
    const older = await get("/api/workflows/:id/fires", `/api/workflows/${flowId}/fires?limit=1&cursor=${page.next}`, { id: flowId });
    expect(older).toEqual({ fires: [expect.objectContaining({ id: first.fireId })], next: null });
    const run = await get("/api/workflow-runs/:runId", `/api/workflow-runs/${first.runId}`, { runId: first.runId });
    expect(run.fire).toMatchObject({ id: first.fireId, source: "webhook", dedupeKey: "delivery:idempotency-key:a" });
    await d.stop();
  });

  test("rows older than the retention are pruned", () => {
    const { flowId } = webhook();
    getWorkflowDb().run(`INSERT INTO workflow_trigger_fire (id, flow_id, source, observed_at, outcome) VALUES ('old', ?, 'webhook', ?, 'missed')`,
      [flowId, Date.now() - FIRE_RETENTION_MS - 1]);
    expect(pruneFires()).toBe(1);
    expect(getFlow(flowId)).not.toBeNull();
  });
});
