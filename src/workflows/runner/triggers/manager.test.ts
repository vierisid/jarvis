import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../db/index";
import {
  createFlow,
  setPublishedVersion,
  updateFlowStatus,
} from "../../db/repos/flow";
import { createDraftVersion, lockVersion, updateDraftVersion } from "../../db/repos/flow-version";
import { queueStats } from "../../db/repos/job-queue";
import { JarvisEventBusAdapter } from "../../adapters/event-bus";
import { JarvisWorkflowRunnerAdapter } from "../../adapters/workflow-runner";
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
  test("start scans ENABLED flows; refresh reconciles status changes", () => {
    const { flowId } = publishFlowWithTrigger("on event flow", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: {
        pieceName: "jarvis-trigger",
        triggerName: "on_event",
        input: { eventType: "test.evt" },
      },
    });
    const bus = new JarvisEventBusAdapter();
    const runner = new JarvisWorkflowRunnerAdapter();
    const tm = new TriggerManager({ workflowRunner: runner, eventBus: bus, log: silent });

    tm.start();
    expect(tm.list()).toEqual([{ flowId, kind: "event" }]);

    updateFlowStatus(flowId, "DISABLED");
    tm.refresh(flowId);
    expect(tm.list()).toEqual([]);

    updateFlowStatus(flowId, "ENABLED");
    tm.refresh(flowId);
    expect(tm.list()).toEqual([{ flowId, kind: "event" }]);

    tm.stop();
    expect(tm.list()).toEqual([]);
  });

  test("EMPTY trigger: nothing registered", () => {
    publishFlowWithTrigger("manual flow", { name: "trigger", type: "EMPTY", settings: {} });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("refresh on a deleted flow tears down without throwing", () => {
    const { flowId } = publishFlowWithTrigger("doomed", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "webhook", input: {} },
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toHaveLength(1);
    // Delete is just status -> not enabled; refresh should unregister.
    updateFlowStatus(flowId, "DISABLED");
    tm.refresh(flowId);
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
    const bus = new JarvisEventBusAdapter();
    const runner = new JarvisWorkflowRunnerAdapter();
    const tm = new TriggerManager({ workflowRunner: runner, eventBus: bus, log: silent });
    tm.start();
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
    const bus = new JarvisEventBusAdapter();
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: bus,
      log: silent,
    });
    tm.start();
    bus.publish("awareness.app_changed", { app: "Slack" });
    bus.publish("awareness.app_changed", { app: "VS Code" });
    bus.publish("awareness.app_changed", { app: "VS Code" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queueStats().queued).toBe(2);
  });

  test("malformed eventType is logged and skipped (no throw, no sub)", () => {
    publishFlowWithTrigger("bad event", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "jarvis-trigger", triggerName: "on_event", input: {} },
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("non-on_event triggerName is skipped", () => {
    publishFlowWithTrigger("wrong name", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "jarvis-trigger", triggerName: "polling", input: {} },
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
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
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
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
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();

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

describe("TriggerManager: schedule", () => {
  test("registers cron when expression is present (any of the three keys)", () => {
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
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list().filter((s) => s.kind === "cron")).toHaveLength(3);
    tm.stop();
  });

  test("missing cron expression is logged and skipped", () => {
    publishFlowWithTrigger("no cron", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "schedule", input: {} },
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("invalid cron expression is logged but does not destabilize start()", () => {
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
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    // Only the good one registers
    expect(tm.list().filter((s) => s.kind === "cron")).toHaveLength(1);
    tm.stop();
  });
});

describe("TriggerManager: unknown trigger kinds", () => {
  test("PIECE_TRIGGER with unknown pieceName is skipped", () => {
    publishFlowWithTrigger("unknown piece", {
      name: "trigger",
      type: "PIECE_TRIGGER",
      settings: { pieceName: "gmail", triggerName: "new_email", input: {} },
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toEqual([]);
  });

  test("unknown trigger.type is skipped", () => {
    publishFlowWithTrigger("alien type", {
      name: "trigger",
      type: "ALIEN",
      settings: {},
    });
    const tm = new TriggerManager({
      workflowRunner: new JarvisWorkflowRunnerAdapter(),
      eventBus: new JarvisEventBusAdapter(),
      log: silent,
    });
    tm.start();
    expect(tm.list()).toEqual([]);
  });
});
