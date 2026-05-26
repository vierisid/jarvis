import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../db/index";
import {
  createFlow,
  setPublishedVersion,
  updateFlowStatus,
} from "../../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../../db/repos/flow-version";
import { queueStats } from "../../db/repos/job-queue";
import { WorkflowEventBus } from "../../runtime/event-bus";
import { TriggerManager } from "./manager";

const silent = () => undefined;

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

function publishFlowWithTrigger(displayName: string, trigger: Record<string, unknown>): { flowId: string; versionId: string } {
  const flow = createFlow();
  const v = createDraftVersion({ flowId: flow.id, displayName });
  updateDraftVersion(v.id, { trigger });
  lockVersion(v.id);
  setPublishedVersion(flow.id, v.id);
  updateFlowStatus(flow.id, "ENABLED");
  return { flowId: flow.id, versionId: v.id };
}

describe("TriggerManager: lifecycle", () => {
  test("start scans ENABLED flows; refresh reconciles status changes", async () => {
    const { flowId } = publishFlowWithTrigger("on event flow", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "test.evt" },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({ eventBus: bus, log: silent });

    await tm.start();
    expect(tm.list()).toEqual([{ flowId, kind: "event" }]);

    updateFlowStatus(flowId, "DISABLED");
    await tm.refresh(flowId);
    expect(tm.list()).toEqual([]);

    updateFlowStatus(flowId, "ENABLED");
    await tm.refresh(flowId);
    expect(tm.list()).toEqual([{ flowId, kind: "event" }]);

    await tm.stop();
    expect(tm.list()).toEqual([]);
  });

  test("EMPTY trigger: nothing registered", async () => {
    publishFlowWithTrigger("manual flow", { name: "trigger", type: "EMPTY", settings: {} });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("refresh on a deleted flow tears down without throwing", async () => {
    const { flowId } = publishFlowWithTrigger("doomed", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "webhook", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toHaveLength(1);
    // Delete is just status -> not enabled; refresh should unregister.
    updateFlowStatus(flowId, "DISABLED");
    await tm.refresh(flowId);
    expect(tm.list()).toEqual([]);
  });
});

describe("TriggerManager: jarvis-trigger on_event", () => {
  test("publishing the configured event fires a flow run", async () => {
    const { flowId } = publishFlowWithTrigger("on app", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "awareness.app_changed" },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({ eventBus: bus, log: silent });
    await tm.start();
    bus.publish("awareness.app_changed", { app: "VS Code" });
    bus.publish("awareness.app_changed", { app: "Slack" });
    bus.publish("commitment.due", { id: "c1" }); // unrelated; should not fire
    // Allow the async fire to complete.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(2);
    void flowId; // silence unused
  });

  test("filter narrows which events fire", async () => {
    publishFlowWithTrigger("only vs code", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "awareness.app_changed", filter: { app: "VS Code" } },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({
      eventBus: bus,
      log: silent,
    });
    await tm.start();
    bus.publish("awareness.app_changed", { app: "Slack" });
    bus.publish("awareness.app_changed", { app: "VS Code" });
    bus.publish("awareness.app_changed", { app: "VS Code" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(2);
  });

  test("malformed eventType is logged and skipped (no throw, no sub)", async () => {
    publishFlowWithTrigger("bad event", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("non-on_event triggerName is skipped", async () => {
    publishFlowWithTrigger("wrong name", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "jarvis-trigger", triggerName: "polling", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });
});

describe("TriggerManager: webhook", () => {
  test("registers a webhook on enable; ingress fires a flow run", async () => {
    const { flowId } = publishFlowWithTrigger("webhook flow", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "webhook", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([{ flowId, kind: "webhook" }]);

    const wm = tm.webhookManager();
    const res = await wm.handleRequest(
      flowId,
      new Request("http://x/webhook", {
        method: "POST",
        body: JSON.stringify({ payload: "hello" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(1);
  });

  test("HMAC-protected webhook rejects unsigned requests", async () => {
    const { flowId } = publishFlowWithTrigger("signed flow", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "webhook", input: { secret: "topsecret" } },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();

    const res = await tm.webhookManager().handleRequest(
      flowId,
      new Request("http://x/webhook", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    expect(queueStats().queued).toBe(0);
  });
});

describe("TriggerManager: integration with canonical event taxonomy", () => {
  test("flow subscribed to observer.clipboard_changed fires when published", async () => {
    publishFlowWithTrigger("clipboard listener", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "observer.clipboard_changed" },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({
      eventBus: bus,
      log: silent,
    });
    await tm.start();
    bus.publish("observer.clipboard_changed", { content: "hi", contentType: "text" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(1);
  });

  test("flow subscribed to awareness.context_changed fires when published", async () => {
    publishFlowWithTrigger("awareness listener", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "awareness.context_changed" },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({
      eventBus: bus,
      log: silent,
    });
    await tm.start();
    bus.publish("awareness.context_changed", { app: "VS Code", project: "jarvis" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(1);
  });

  test("flow with eventType filter fires only on matching commitment.overdue payload", async () => {
    publishFlowWithTrigger("overdue payments", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: {
          eventType: "commitment.overdue",
          filter: { tag: "payment" },
        },
      },
    });
    const bus = new WorkflowEventBus();
    const tm = new TriggerManager({
      eventBus: bus,
      log: silent,
    });
    await tm.start();
    bus.publish("commitment.overdue", { id: "c1", tag: "social" });
    bus.publish("commitment.overdue", { id: "c2", tag: "payment" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(1);
  });
});

describe("TriggerManager: schedule", () => {
  test("registers cron when expression is present (any of the three keys)", async () => {
    publishFlowWithTrigger("cron a", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { cron_expression: "0 * * * *" } },
    });
    publishFlowWithTrigger("cron b", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { cronExpression: "0 8 * * *" } },
    });
    publishFlowWithTrigger("cron c", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { expression: "*/5 * * * *" } },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list().filter((s) => s.kind === "cron")).toHaveLength(3);
    await tm.stop();
  });

  test("missing cron expression is logged and skipped", async () => {
    publishFlowWithTrigger("no cron", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("invalid cron expression is logged but does not destabilize start()", async () => {
    publishFlowWithTrigger("bad cron", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { cron_expression: "not a cron" } },
    });
    publishFlowWithTrigger("good cron", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { cron_expression: "0 * * * *" } },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    // Only the good one registers
    expect(tm.list().filter((s) => s.kind === "cron")).toHaveLength(1);
    await tm.stop();
  });
});

describe("TriggerManager: unknown trigger kinds", () => {
  test("PIECE_TRIGGER with unknown pieceName is skipped", async () => {
    publishFlowWithTrigger("unknown piece", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "gmail", triggerName: "new_email", input: {} },
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("unknown trigger.type is skipped", async () => {
    publishFlowWithTrigger("alien type", {
      name: "trigger",
      type: "ALIEN",
      settings: {},
    });
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      log: silent,
    });
    await tm.start();
    expect(tm.list()).toEqual([]);
  });
});

/**
 * Minimal CronScheduler-shaped stub: captures registered callbacks so tests
 * can fire them deterministically without waiting for real cron ticks.
 */
class FakeCronScheduler {
  private readonly jobs: Map<string, () => void> = new Map();
  schedule(id: string, _expression: string, callback: () => void): void {
    this.jobs.set(id, callback);
  }
  cancel(id: string): void {
    this.jobs.delete(id);
  }
  cancelAll(): void {
    this.jobs.clear();
  }
  fire(id: string): void {
    const cb = this.jobs.get(id);
    if (!cb) throw new Error(`no cron job registered for ${id}`);
    cb();
  }
  has(id: string): boolean {
    return this.jobs.has(id);
  }
}

/**
 * Let a `void`-ed async cron callback settle. `fireEngineTrigger` is now async
 * (it polls the engine's RUN hook before enqueuing), so the cron callback's
 * promise resolves a few turns after `FakeCronScheduler.fire` returns.
 */
const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TriggerManager: engine-managed triggers (Phase J)", () => {
  test("ON_ENABLE persists schedule + registers cron; a cron tick polls the RUN hook and enqueues one run per event", async () => {
    const { flowId, versionId } = publishFlowWithTrigger("engine-managed", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "awareness.context_changed" },
      },
    });

    const calls: Array<{ hookType: string }> = [];
    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        calls.push({ hookType });
        if (hookType === "ON_ENABLE") {
          return { listeners: [], scheduleOptions: { cronExpression: "*/2 * * * *" } };
        }
        if (hookType === "RUN") {
          // Poll yields one event -> the manager should enqueue one run.
          return {
            output: [
              { id: "e1", eventType: "awareness.context_changed", payload: { app: "x" }, timestamp: 1, _dedupe_key: "e1" },
            ],
          };
        }
        return {};
      },
      async release() { /* noop */ },
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();

    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: silent,
    });

    await tm.start();
    expect(calls.length).toBe(1);
    expect(calls[0]?.hookType).toBe("ON_ENABLE");
    expect(tm.list()).toEqual([{ flowId, kind: "engine" }]);
    expect(fakeCron.has(`flow:${flowId}`)).toBe(true);

    const queueBefore = queueStats();
    fakeCron.fire(`flow:${flowId}`);
    await settle();
    const queueAfter = queueStats();
    expect(queueAfter.queued).toBe(queueBefore.queued + 1);
    // The tick polled via the RUN hook (not a blind executeTrigger run).
    expect(calls.some((c) => c.hookType === "RUN")).toBe(true);

    const persisted = (await import("../../db/repos/flow-version")).getFlowVersion(versionId)!;
    expect(persisted.engineSchedule?.cronExpression).toBe("*/2 * * * *");
    expect(persisted.engineListeners).toEqual([]);

    await tm.stop();
    expect(calls.some((c) => c.hookType === "ON_DISABLE")).toBe(true);
    const cleared = (await import("../../db/repos/flow-version")).getFlowVersion(versionId)!;
    expect(cleared.engineSchedule).toBeNull();
  });

  test("ON_ENABLE is idempotent: persisted schedule is reused, no re-call to engine", async () => {
    const { flowId, versionId } = publishFlowWithTrigger("engine-idempotent", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "x" },
      },
    });

    let enableCalls = 0;
    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        if (hookType === "ON_ENABLE") {
          enableCalls++;
          return { listeners: [], scheduleOptions: { cronExpression: "0 * * * *" } };
        }
        return {};
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();

    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: silent,
    });
    await tm.start();
    expect(enableCalls).toBe(1);

    (tm as unknown as { subs: Map<string, unknown> }).subs.clear();
    await tm.refresh(flowId);
    expect(enableCalls).toBe(1);
    expect(tm.list()).toEqual([{ flowId, kind: "engine" }]);

    const v = (await import("../../db/repos/flow-version")).getFlowVersion(versionId)!;
    expect(v.engineSchedule?.cronExpression).toBe("0 * * * *");
  });

  test("ON_ENABLE returning webhook listeners (no schedule) surfaces a warning on tm.list()", async () => {
    const { flowId, versionId } = publishFlowWithTrigger("engine-webhook", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "vendored-webhook",
        triggerName: "on_message",
        input: { app: "gmail" },
      },
    });

    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        if (hookType === "ON_ENABLE") {
          return {
            listeners: [{ events: ["new_message"], identifierValue: "watch-id-123" }],
            // No scheduleOptions -- webhook-strategy trigger.
          };
        }
        return {};
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();

    const logs: string[] = [];
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: (line) => logs.push(line),
    });
    await tm.start();

    const list = tm.list() as Array<{ flowId: string; kind: string; warning?: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.flowId).toBe(flowId);
    expect(list[0]?.kind).toBe("engine");
    // No cron registered for webhook-only triggers.
    expect(fakeCron.has(`flow:${flowId}`)).toBe(false);
    // Listeners persisted on the version.
    const persisted = (await import("../../db/repos/flow-version")).getFlowVersion(versionId)!;
    expect(persisted.engineListeners?.length).toBe(1);
    expect(persisted.engineListeners?.[0]?.identifierValue).toBe("watch-id-123");
    expect(persisted.engineSchedule).toBeNull();
    // Webhook route is registered for /webhooks/<flowId>.
    expect(tm.webhookManager().getRoutes().has(flowId)).toBe(true);
    expect(logs.some((l) => l.includes(`/webhooks/${flowId} active`))).toBe(true);

    // Webhook fire (simulated via a real POST through handleRequest) enqueues
    // RUN_FLOW with `executeTrigger=true` because the registered sub is
    // engine-managed.
    const { queueStats: qs2, claimNextJob: cnj2 } = await import("../../db/repos/job-queue");
    const queuedBefore = qs2().queued;
    const fakeReq = new Request(`http://localhost/webhooks/${flowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    await tm.webhookManager().handleRequest(flowId, fakeReq);
    expect(qs2().queued).toBe(queuedBefore + 1);
    const job = cnj2<{ runId: string; payload?: Record<string, unknown>; executeTrigger?: boolean }>();
    expect(job?.payload.executeTrigger).toBe(true);

    await tm.stop();
  });

  test("concurrent refresh on the same flow serializes -- engine ON_ENABLE called exactly once", async () => {
    const { flowId } = publishFlowWithTrigger("engine-concurrent", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "x" },
      },
    });

    let enableCalls = 0;
    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        if (hookType === "ON_ENABLE") {
          enableCalls++;
          // Tiny delay to widen the race window.
          await new Promise((r) => setTimeout(r, 25));
          return { listeners: [], scheduleOptions: { cronExpression: "*/3 * * * *" } };
        }
        return {};
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();

    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: silent,
    });

    // Fire three refreshes back-to-back; the second + third should observe
    // persisted state and skip the engine round-trip.
    await Promise.all([tm.refresh(flowId), tm.refresh(flowId), tm.refresh(flowId)]);
    expect(enableCalls).toBe(1);
    expect(tm.list()).toEqual([{ flowId, kind: "engine" }]);
  });

  test("triggeredBy follows `trigger:<kind>` for both legacy and engine fires", async () => {
    // Engine trigger -> `trigger:engine`.
    const { flowId: engineFlowId, versionId: engineVersionId } = publishFlowWithTrigger("triggeredby-engine", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "x" },
      },
    });
    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        if (hookType === "ON_ENABLE") {
          return { listeners: [], scheduleOptions: { cronExpression: "*/5 * * * *" } };
        }
        if (hookType === "RUN") {
          return { output: [{ id: "ev", eventType: "x", payload: {}, timestamp: 1, _dedupe_key: "ev" }] };
        }
        return {};
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: silent,
    });
    await tm.start();
    fakeCron.fire(`flow:${engineFlowId}`);
    await settle();

    // Legacy schedule trigger -> `trigger:cron`.
    const { flowId: cronFlowId } = publishFlowWithTrigger("triggeredby-cron", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } },
    });
    await tm.refresh(cronFlowId);
    fakeCron.fire(`flow:${cronFlowId}`);

    const runs = (await import("../../db/repos/flow-run")).listRuns({ limit: 50 });
    const engineRun = runs.find((r) => r.flowId === engineFlowId);
    const cronRun = runs.find((r) => r.flowId === cronFlowId);
    expect(engineRun?.triggeredBy).toBe("trigger:engine");
    expect(cronRun?.triggeredBy).toBe("trigger:cron");
    void engineVersionId;
  });

  test("engine poll enqueues one run per event (payload = event, no executeTrigger); empty poll enqueues nothing", async () => {
    const { flowId } = publishFlowWithTrigger("executetrigger-roundtrip", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "x" },
      },
    });
    // Drives what the RUN hook returns per tick.
    let runOutput: unknown[] = [];
    const fakeHandle = {
      async executeTriggerHook(hookType: string) {
        if (hookType === "ON_ENABLE") {
          return { listeners: [], scheduleOptions: { cronExpression: "*/7 * * * *" } };
        }
        if (hookType === "RUN") {
          return { output: runOutput };
        }
        return {};
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;
    const fakeCron = new FakeCronScheduler();
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: fakeCron as unknown as import("./cron").CronScheduler,
      log: silent,
    });
    await tm.start();

    const { queueStats, claimNextJob } = await import("../../db/repos/job-queue");

    // Empty poll -> no run enqueued (the whole point of the fix).
    const before = queueStats().queued;
    runOutput = [];
    fakeCron.fire(`flow:${flowId}`);
    await settle();
    expect(queueStats().queued).toBe(before);

    // Poll with one event -> exactly one run, with the event as the trigger
    // payload and NO executeTrigger flag (the manager already polled).
    runOutput = [{ id: "x1", eventType: "x", payload: { hello: "world" }, timestamp: 1, _dedupe_key: "x1" }];
    fakeCron.fire(`flow:${flowId}`);
    await settle();
    const job = claimNextJob<{
      runId: string;
      payload?: Record<string, unknown>;
      executeTrigger?: boolean;
    }>();
    expect(job).not.toBeNull();
    expect(job!.flowId).toBe(flowId);
    expect(job!.payload.executeTrigger).toBeUndefined();
    // The event item is passed through verbatim as the run's trigger payload.
    expect((job!.payload.payload as { payload?: { hello?: string } })?.payload?.hello).toBe("world");
  });

  test("engine ON_ENABLE failure is logged; flow stays manually runnable, no crash", async () => {
    publishFlowWithTrigger("engine-fail", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "x" },
      },
    });

    const fakeHandle = {
      async executeTriggerHook() {
        throw new Error("engine down");
      },
      async release() {},
    };
    const fakeEngine = {
      acquire: async () => fakeHandle,
    } as unknown as import("../engine-runtime/engine-runtime").EngineRuntime;

    const logs: string[] = [];
    const tm = new TriggerManager({
      eventBus: new WorkflowEventBus(),
      engineRuntime: fakeEngine,
      cronScheduler: new FakeCronScheduler() as unknown as import("./cron").CronScheduler,
      log: (line) => logs.push(line),
    });

    await tm.start();
    expect(tm.list()).toEqual([]);
    expect(logs.some((l) => l.includes("engine ON_ENABLE failed"))).toBe(true);
  });
});
