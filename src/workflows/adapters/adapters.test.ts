import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { createFlow, setPublishedVersion, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion, lockVersion } from "../db/repos/flow-version";
import { queueStats } from "../db/repos/job-queue";
import {
  JarvisEventBusAdapter,
  JarvisLlmClient,
  JarvisNotifierAdapter,
  JarvisToolRegistryAdapter,
  JarvisWorkflowRunnerAdapter,
  LlmOnlyAgentDelegator,
} from "./index";
import type { NotifierBroadcastReport } from "./notifier";
import type { LLMManager } from "../../llm/manager";
import type { LLMMessage, LLMResponse } from "../../llm/provider";
import type { ToolDefinition } from "../../actions/tools/registry";

// ---------------------------------------------------- LLM client adapter

class FakeLlmManager {
  public lastMessages: LLMMessage[] | null = null;
  public lastOptions: unknown = null;
  constructor(private readonly reply: LLMResponse) {}
  async chat(messages: LLMMessage[], options?: unknown): Promise<LLMResponse> {
    this.lastMessages = messages;
    this.lastOptions = options;
    return this.reply;
  }
}

describe("JarvisLlmClient", () => {
  test("builds system+user messages and projects to text", async () => {
    const reply = { content: [{ type: "text", text: "hello" }], usage: { promptTokens: 5, completionTokens: 2 } } as unknown as LLMResponse;
    const manager = new FakeLlmManager(reply);
    const client = new JarvisLlmClient(manager as unknown as LLMManager);
    const got = await client.chat({ system: "be brief", prompt: "hi", model: "m1", temperature: 0.4 });
    expect(got.text).toBe("hello");
    expect(got.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect(manager.lastMessages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(manager.lastOptions).toEqual({ model: "m1", temperature: 0.4 });
  });

  test("omits system message when not provided", async () => {
    const manager = new FakeLlmManager({ content: [{ type: "text", text: "ok" }] } as unknown as LLMResponse);
    const client = new JarvisLlmClient(manager as unknown as LLMManager);
    await client.chat({ prompt: "hi" });
    expect(manager.lastMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("handles 'text' string responses too (provider variation)", async () => {
    const manager = new FakeLlmManager({ text: "direct" } as unknown as LLMResponse);
    const client = new JarvisLlmClient(manager as unknown as LLMManager);
    const got = await client.chat({ prompt: "x" });
    expect(got.text).toBe("direct");
  });

  test("returns empty string when response has no text content", async () => {
    const manager = new FakeLlmManager({ content: [{ type: "tool_use", name: "x" }] } as unknown as LLMResponse);
    const client = new JarvisLlmClient(manager as unknown as LLMManager);
    const got = await client.chat({ prompt: "x" });
    expect(got.text).toBe("");
  });
});

// --------------------------------------------- Tool registry adapter

class FakeToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  add(t: ToolDefinition) { this.tools.set(t.name, t); }
  has(name: string) { return this.tools.has(name); }
  get(name: string) { return this.tools.get(name); }
  list(category?: string) {
    const all = Array.from(this.tools.values());
    return category ? all.filter((t) => t.category === category) : all;
  }
  async execute(name: string, params: Record<string, unknown>) {
    return this.tools.get(name)!.execute(params);
  }
}

describe("JarvisToolRegistryAdapter", () => {
  test("forwards has/execute/describe/listNames", async () => {
    const fake = new FakeToolRegistry();
    fake.add({
      name: "echo",
      description: "echoes input",
      category: "demo",
      parameters: { msg: { type: "string", description: "what to echo", required: true } },
      execute: async (p) => `echoed:${(p as { msg: string }).msg}`,
    });
    const adapter = new JarvisToolRegistryAdapter(fake as unknown as import("../../actions/tools/registry").ToolRegistry);
    expect(adapter.has("echo")).toBe(true);
    expect(adapter.has("nope")).toBe(false);
    expect(adapter.describe("echo")?.description).toBe("echoes input");
    expect(adapter.describe("nope")).toBeNull();
    expect(adapter.listNames()).toEqual(["echo"]);
    expect(adapter.listNames("other")).toEqual([]);
    expect(await adapter.execute("echo", { msg: "hi" })).toBe("echoed:hi");
  });
});

// ------------------------------------------------- Notifier adapter

describe("JarvisNotifierAdapter", () => {
  function makeDeps(): {
    deps: import("./notifier").NotifierDeps;
    dashboardCalls: Array<{ text: string; priority: string }>;
    channelCalls: Array<{ channels: string[]; text: string }>;
    desktopCalls: Array<{ title: string; body: string }>;
    nextReport: () => NotifierBroadcastReport;
  } {
    const dashboardCalls: Array<{ text: string; priority: string }> = [];
    const channelCalls: Array<{ channels: string[]; text: string }> = [];
    const desktopCalls: Array<{ title: string; body: string }> = [];
    let report: NotifierBroadcastReport = { delivered: [], failed: [] };
    const deps: import("./notifier").NotifierDeps = {
      broadcastToDashboard: (text, priority) => { dashboardCalls.push({ text, priority }); },
      broadcastToChannels: async (channels, text) => {
        channelCalls.push({ channels, text });
        return report;
      },
      sendDesktop: async (title, body) => { desktopCalls.push({ title, body }); },
    };
    return { deps, dashboardCalls, channelCalls, desktopCalls, nextReport: () => report };
  }

  test("'auto' fans out to dashboard + telegram + discord", async () => {
    const { deps, dashboardCalls, channelCalls } = makeDeps();
    const notifier = new JarvisNotifierAdapter(deps);
    const result = await notifier.notify({ message: "hi", channels: ["auto"], priority: "normal" });
    expect(dashboardCalls).toHaveLength(1);
    expect(channelCalls).toHaveLength(1);
    expect(channelCalls[0]?.channels.sort()).toEqual(["discord", "telegram"]);
    expect(result.delivered).toContain("dashboard");
  });

  test("explicit telegram + dashboard goes through verbatim", async () => {
    const { deps, dashboardCalls, channelCalls } = makeDeps();
    const notifier = new JarvisNotifierAdapter(deps);
    await notifier.notify({ message: "hi", channels: ["dashboard", "telegram"], priority: "high" });
    expect(dashboardCalls[0]?.priority).toBe("urgent");
    expect(channelCalls[0]?.channels).toEqual(["telegram"]);
  });

  test("voice surfaces as a 'not yet wired' failure", async () => {
    const { deps } = makeDeps();
    const notifier = new JarvisNotifierAdapter(deps);
    const result = await notifier.notify({ message: "x", channels: ["voice"], priority: "normal" });
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([
      { channel: "voice", error: expect.stringMatching(/not yet wired/) },
    ]);
  });

  test("desktop unavailable when no sendDesktop dep", async () => {
    const { deps, dashboardCalls } = makeDeps();
    const noDesktop: import("./notifier").NotifierDeps = {
      broadcastToDashboard: deps.broadcastToDashboard,
      broadcastToChannels: deps.broadcastToChannels,
    };
    const notifier = new JarvisNotifierAdapter(noDesktop);
    const result = await notifier.notify({ message: "x", channels: ["desktop"], priority: "normal" });
    expect(dashboardCalls).toHaveLength(0);
    expect(result.failed).toEqual([
      { channel: "desktop", error: expect.stringMatching(/not available/) },
    ]);
  });

  test("partial failure on M8 channels is reported, not thrown", async () => {
    const { deps, channelCalls } = makeDeps();
    // Override report
    const adaptedDeps = {
      ...deps,
      broadcastToChannels: async (channels: string[], text: string) => {
        channelCalls.push({ channels, text });
        return { delivered: ["telegram"], failed: [{ channel: "discord", error: "rate limited" }] };
      },
    };
    const notifier = new JarvisNotifierAdapter(adaptedDeps);
    const result = await notifier.notify({
      message: "x",
      channels: ["telegram", "discord"],
      priority: "normal",
    });
    expect(result.delivered).toContain("telegram");
    expect(result.failed.find((f) => f.channel === "discord")?.error).toMatch(/rate limited/);
  });
});

// ---------------------------------------------- Workflow runner adapter

describe("JarvisWorkflowRunnerAdapter", () => {
  beforeEach(() => { initWorkflowDb(":memory:"); });
  afterEach(() => { closeWorkflowDb(); });

  test("starts by flowId, enqueues a RUN_FLOW job, returns runId", async () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "Test flow" });
    lockVersion(v.id);
    setPublishedVersion(flow.id, v.id);
    updateFlowStatus(flow.id, "ENABLED");
    const runner = new JarvisWorkflowRunnerAdapter();
    const { runId } = await runner.start({ flowId: flow.id, payload: { x: 1 } });
    expect(typeof runId).toBe("string");
    expect(queueStats().queued).toBe(1);
  });

  test("starts by flowName (case-insensitive on display_name)", async () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "Morning briefing" });
    lockVersion(v.id);
    setPublishedVersion(flow.id, v.id);
    const runner = new JarvisWorkflowRunnerAdapter();
    const { runId } = await runner.start({ flowName: "morning briefing" });
    expect(typeof runId).toBe("string");
    expect(queueStats().queued).toBe(1);
  });

  test("falls back to latest draft when no published version", async () => {
    const flow = createFlow();
    createDraftVersion({ flowId: flow.id, displayName: "draft only" });
    const runner = new JarvisWorkflowRunnerAdapter();
    const { runId } = await runner.start({ flowName: "draft only" });
    expect(typeof runId).toBe("string");
  });

  test("throws on unknown flowId / flowName", async () => {
    const runner = new JarvisWorkflowRunnerAdapter();
    await expect(runner.start({ flowId: "nope" })).rejects.toThrow(/not found/);
    await expect(runner.start({ flowName: "ghost" })).rejects.toThrow(/not found/);
    await expect(runner.start({})).rejects.toThrow(/required/);
  });
});

// ----------------------------------------------- Event bus adapter

describe("JarvisEventBusAdapter", () => {
  test("subscribe + publish + unsubscribe", () => {
    const bus = new JarvisEventBusAdapter();
    const events: Record<string, unknown>[] = [];
    const unsub = bus.subscribe("e1", (p) => events.push(p));
    bus.publish("e1", { a: 1 });
    bus.publish("e2", { b: 2 });
    bus.publish("e1", { a: 3 });
    expect(events).toEqual([{ a: 1 }, { a: 3 }]);
    unsub();
    bus.publish("e1", { a: 4 });
    expect(events).toEqual([{ a: 1 }, { a: 3 }]);
  });

  test("listEventTypes reflects active subscriptions", () => {
    const bus = new JarvisEventBusAdapter();
    bus.subscribe("a.b", () => undefined);
    bus.subscribe("c.d", () => undefined);
    expect(bus.listEventTypes()).toEqual(["a.b", "c.d"]);
  });

  test("handler exceptions are caught (do not break other subscribers)", () => {
    const bus = new JarvisEventBusAdapter();
    let secondCalled = false;
    bus.subscribe("e", () => { throw new Error("boom"); });
    bus.subscribe("e", () => { secondCalled = true; });
    bus.publish("e", {});
    expect(secondCalled).toBe(true);
  });
});

// ----------------------------------------- LlmOnlyAgentDelegator

describe("LlmOnlyAgentDelegator", () => {
  test("dispatches the goal to the LLM and returns final message", async () => {
    const llm = {
      async chat(input: { system?: string; prompt: string }) {
        return { text: `done: ${input.prompt}` };
      },
    };
    const delegator = new LlmOnlyAgentDelegator(llm);
    const result = await delegator.delegate({ goal: "do thing" });
    expect(result.finalMessage).toBe("done: do thing");
    expect(result.toolCalls).toEqual([]);
    expect(result.status).toBe("completed");
  });
});
