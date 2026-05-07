import { describe, expect, test } from "bun:test";
import {
  JarvisActionInputError,
  JarvisPieceRegistry,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
  type PieceLlmClient,
  type PieceLlmInput,
  type PieceLlmResponse,
  type PieceToolDescription,
  type PieceToolRegistry,
} from "./types";
import { askAction, jarvisAskPiece, parseJsonReply } from "./jarvis-ask";
import { invokeAction, jarvisToolPiece } from "./jarvis-tool";
import { jarvisNotifyPiece, notifyAction } from "./jarvis-notify";
import {
  awarenessRecentAction,
  commitmentsListAction,
  jarvisContextPiece,
  vaultGetEntityAction,
  vaultSearchAction,
} from "./jarvis-context";
import { delegateAction, jarvisAgentPiece } from "./jarvis-agent";
import {
  jarvisTriggerPiece,
  onEventTrigger,
  runWorkflowAction,
} from "./jarvis-trigger";
import type {
  JarvisTriggerContext,
  PieceEventBus,
  PieceWorkflowRunner,
  PieceWorkflowStartInput,
  PieceWorkflowStartResult,
  PieceAgentDelegateInput,
  PieceAgentDelegateResult,
  PieceAgentDelegator,
  AwarenessActivitySnapshot,
  AwarenessRecentInput,
  CommitmentSnapshot,
  CommitmentsListInput,
  PieceContextProvider,
  PieceNotifier,
  PieceNotifyInput,
  PieceNotifyResult,
  VaultEntitySnapshot,
  VaultSearchInput,
} from "./types";

class StubLlm implements PieceLlmClient {
  public calls: PieceLlmInput[] = [];
  constructor(private readonly reply: PieceLlmResponse) {}
  async chat(input: PieceLlmInput): Promise<PieceLlmResponse> {
    this.calls.push(input);
    return this.reply;
  }
}

function makeCtx(llm?: PieceLlmClient): JarvisPieceContext {
  return { services: llm ? { llm } : {} };
}

class StubToolRegistry implements PieceToolRegistry {
  public calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  constructor(
    private readonly tools: Record<string, PieceToolDescription>,
    private readonly impl: (name: string, params: Record<string, unknown>) => Promise<unknown> = async () => "ok",
  ) {}
  has(name: string): boolean {
    return name in this.tools;
  }
  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, params });
    return this.impl(name, params);
  }
  describe(name: string): PieceToolDescription | null {
    return this.tools[name] ?? null;
  }
  listNames(category?: string): string[] {
    return Object.values(this.tools)
      .filter((t) => !category || t.category === category)
      .map((t) => t.name);
  }
}

function makeToolCtx(registry: PieceToolRegistry): JarvisPieceContext {
  return { services: { toolRegistry: registry } };
}

// ---------------------------------------------------------------- registry

describe("JarvisPieceRegistry", () => {
  test("register + get + list", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    expect(r.get("jarvis-ask")?.name).toBe("jarvis-ask");
    expect(r.list().map((p) => p.name)).toEqual(["jarvis-ask"]);
    expect(r.get("nope")).toBeNull();
  });

  test("duplicate registration throws", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    expect(() => r.register(jarvisAskPiece)).toThrow(/already registered/);
  });

  test("rejects piece with duplicate field names in a schema", () => {
    const r = new JarvisPieceRegistry();
    const piece: JarvisPiece = {
      name: "bad",
      displayName: "Bad",
      description: "",
      actions: {
        broken: {
          name: "broken",
          displayName: "Broken",
          description: "",
          inputSchema: {
            fields: [
              { name: "x", label: "X", type: "string", required: false },
              { name: "x", label: "X again", type: "string", required: false },
            ],
          },
          parseInput: () => ({}),
          execute: async () => ({}),
        },
      },
    };
    expect(() => r.register(piece)).toThrow(/duplicate field name "x"/);
  });

  test("rejects enum field with no options", () => {
    const r = new JarvisPieceRegistry();
    const piece: JarvisPiece = {
      name: "bad-enum",
      displayName: "Bad enum",
      description: "",
      actions: {
        a: {
          name: "a",
          displayName: "A",
          description: "",
          inputSchema: {
            fields: [{ name: "f", label: "F", type: "enum", required: false }],
          },
          parseInput: () => ({}),
          execute: async () => ({}),
        },
      },
    };
    expect(() => r.register(piece)).toThrow(/requires options/);
  });

  test("rejects enum with duplicate option values", () => {
    const r = new JarvisPieceRegistry();
    const piece: JarvisPiece = {
      name: "dup-opt",
      displayName: "Dup",
      description: "",
      actions: {
        a: {
          name: "a",
          displayName: "A",
          description: "",
          inputSchema: {
            fields: [
              {
                name: "f",
                label: "F",
                type: "enum",
                required: false,
                options: [
                  { value: "x", label: "X1" },
                  { value: "x", label: "X2" },
                ],
              },
            ],
          },
          parseInput: () => ({}),
          execute: async () => ({}),
        },
      },
    };
    expect(() => r.register(piece)).toThrow(/duplicate option value "x"/);
  });

  test("resolveAction parses 'piece:action' references", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    expect(r.resolveAction("jarvis-ask:ask")?.name).toBe("ask");
    expect(r.resolveAction("jarvis-ask:nonexistent")).toBeNull();
    expect(r.resolveAction("ghost:ask")).toBeNull();
    expect(r.resolveAction("malformed-no-colon")).toBeNull();
  });
});

// ------------------------------------------------------------- jarvis-ask

describe("jarvis-ask: parseInput", () => {
  test("accepts a minimal prompt", () => {
    expect(askAction.parseInput({ prompt: "hi" })).toEqual({ prompt: "hi" });
  });

  test("accepts all optional fields", () => {
    const got = askAction.parseInput({
      prompt: "hi",
      system: "You are concise.",
      model: "claude-haiku-4-5",
      temperature: 0.2,
      outputSchema: "json",
    });
    expect(got).toEqual({
      prompt: "hi",
      system: "You are concise.",
      model: "claude-haiku-4-5",
      temperature: 0.2,
      outputSchema: "json",
    });
  });

  test("rejects missing/empty prompt", () => {
    expect(() => askAction.parseInput({})).toThrow(JarvisActionInputError);
    expect(() => askAction.parseInput({ prompt: "" })).toThrow(JarvisActionInputError);
    expect(() => askAction.parseInput(null)).toThrow(JarvisActionInputError);
  });

  test("rejects bad types", () => {
    expect(() => askAction.parseInput({ prompt: "x", system: 1 })).toThrow();
    expect(() => askAction.parseInput({ prompt: "x", model: true })).toThrow();
    expect(() => askAction.parseInput({ prompt: "x", temperature: "warm" })).toThrow();
    expect(() => askAction.parseInput({ prompt: "x", outputSchema: "yaml" })).toThrow();
    expect(() => askAction.parseInput({ prompt: "x", temperature: NaN })).toThrow();
  });
});

describe("jarvis-ask: execute", () => {
  test("forwards prompt + options to the LLM and returns text", async () => {
    const llm = new StubLlm({ text: "ok" });
    const out = await askAction.execute(
      { prompt: "hello", system: "be brief", model: "m1", temperature: 0.3 },
      makeCtx(llm),
    );
    expect(out.text).toBe("ok");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toEqual({
      prompt: "hello",
      system: "be brief",
      model: "m1",
      temperature: 0.3,
    });
  });

  test("does not pass undefined fields to the LLM client", async () => {
    const llm = new StubLlm({ text: "ok" });
    await askAction.execute({ prompt: "hi" }, makeCtx(llm));
    expect(llm.calls[0]).toEqual({ prompt: "hi" });
  });

  test("propagates usage stats when present", async () => {
    const llm = new StubLlm({ text: "ok", usage: { promptTokens: 5, completionTokens: 7 } });
    const out = await askAction.execute({ prompt: "hi" }, makeCtx(llm));
    expect(out.usage).toEqual({ promptTokens: 5, completionTokens: 7 });
  });

  test("outputSchema='json' parses the reply", async () => {
    const llm = new StubLlm({ text: '{"score": 0.7, "label": "happy"}' });
    const out = await askAction.execute(
      { prompt: "classify", outputSchema: "json" },
      makeCtx(llm),
    );
    expect(out.json).toEqual({ score: 0.7, label: "happy" });
    expect(out.text).toBe('{"score": 0.7, "label": "happy"}');
  });

  test("outputSchema='json' strips a markdown fence", async () => {
    const llm = new StubLlm({ text: "```json\n{\"a\": 1}\n```" });
    const out = await askAction.execute(
      { prompt: "x", outputSchema: "json" },
      makeCtx(llm),
    );
    expect(out.json).toEqual({ a: 1 });
  });

  test("outputSchema='json' on bad JSON throws a clear error", async () => {
    const llm = new StubLlm({ text: "I think it's 42" });
    await expect(
      askAction.execute({ prompt: "x", outputSchema: "json" }, makeCtx(llm)),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("throws when the LLM service is missing from the context", async () => {
    await expect(
      askAction.execute({ prompt: "x" }, makeCtx(undefined)),
    ).rejects.toThrow(/llm is not configured/);
  });
});

describe("parseJsonReply (helper)", () => {
  test("strips ```json fences", () => {
    expect(parseJsonReply("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });
  test("strips bare ``` fences", () => {
    expect(parseJsonReply("```\n[1,2,3]\n```")).toEqual([1, 2, 3]);
  });
  test("accepts plain JSON without fences", () => {
    expect(parseJsonReply('{"k":"v"}')).toEqual({ k: "v" });
  });
  test("throws on garbage", () => {
    expect(() => parseJsonReply("not json")).toThrow(/not valid JSON/);
  });
});

// Type-level smoke check: registering the piece and resolving its action
// returns a callable handler with the right shape.
describe("integration: registry + jarvis-ask", () => {
  test("resolveAction returns a working handler", async () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    const handler = r.resolveAction("jarvis-ask:ask");
    expect(handler).not.toBeNull();
    const llm = new StubLlm({ text: "from-registry" });
    const parsed = handler!.parseInput({ prompt: "hi" });
    const result = await handler!.execute(parsed, makeCtx(llm));
    expect((result as { text: string }).text).toBe("from-registry");
  });
});

// ----------------------------------------------------------- jarvis-tool

describe("jarvis-tool: parseInput", () => {
  test("requires a toolName, defaults params to empty object", () => {
    expect(invokeAction.parseInput({ toolName: "search" })).toEqual({
      toolName: "search",
      params: {},
    });
  });

  test("accepts an explicit params object", () => {
    expect(
      invokeAction.parseInput({ toolName: "run_command", params: { command: "ls" } }),
    ).toEqual({ toolName: "run_command", params: { command: "ls" } });
  });

  test("rejects missing/empty toolName", () => {
    expect(() => invokeAction.parseInput({})).toThrow(JarvisActionInputError);
    expect(() => invokeAction.parseInput({ toolName: "" })).toThrow(JarvisActionInputError);
  });

  test("rejects non-object params", () => {
    expect(() => invokeAction.parseInput({ toolName: "x", params: "no" })).toThrow();
    expect(() => invokeAction.parseInput({ toolName: "x", params: [] })).toThrow();
    expect(() => invokeAction.parseInput({ toolName: "x", params: 1 })).toThrow();
  });
});

describe("jarvis-tool: execute", () => {
  const greetTool: PieceToolDescription = {
    name: "greet",
    description: "say hi",
    category: "demo",
    parameters: { name: { type: "string", description: "who", required: true } },
  };

  test("invokes the tool through the registry and echoes toolName", async () => {
    const registry = new StubToolRegistry(
      { greet: greetTool },
      async (_name, params) => `hi ${(params as { name: string }).name}`,
    );
    const out = await invokeAction.execute(
      { toolName: "greet", params: { name: "Vieri" } },
      makeToolCtx(registry),
    );
    expect(out).toEqual({ result: "hi Vieri", toolName: "greet" });
    expect(registry.calls).toEqual([{ name: "greet", params: { name: "Vieri" } }]);
  });

  test("throws a clear error when the tool is not registered", async () => {
    const registry = new StubToolRegistry({});
    await expect(
      invokeAction.execute({ toolName: "ghost", params: {} }, makeToolCtx(registry)),
    ).rejects.toThrow(/tool not found: ghost/);
  });

  test("throws when the tool registry is missing from the context", async () => {
    await expect(
      invokeAction.execute({ toolName: "x", params: {} }, { services: {} }),
    ).rejects.toThrow(/toolRegistry is not configured/);
  });

  test("propagates errors thrown by the underlying tool", async () => {
    const registry = new StubToolRegistry(
      { boom: { ...greetTool, name: "boom" } },
      async () => {
        throw new Error("kaboom");
      },
    );
    await expect(
      invokeAction.execute({ toolName: "boom", params: {} }, makeToolCtx(registry)),
    ).rejects.toThrow(/kaboom/);
  });

  test("registers cleanly alongside jarvis-ask", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    r.register(jarvisToolPiece);
    expect(r.list().map((p) => p.name).sort()).toEqual(["jarvis-ask", "jarvis-tool"]);
    expect(r.resolveAction("jarvis-tool:invoke")?.name).toBe("invoke");
  });
});

// --------------------------------------------------------- jarvis-notify

class StubNotifier implements PieceNotifier {
  public calls: PieceNotifyInput[] = [];
  constructor(private readonly result: PieceNotifyResult) {}
  async notify(input: PieceNotifyInput): Promise<PieceNotifyResult> {
    this.calls.push(input);
    return this.result;
  }
}

describe("jarvis-notify: parseInput", () => {
  test("requires a non-empty message; defaults channels=['auto'] priority='normal'", () => {
    expect(notifyAction.parseInput({ message: "hi" })).toEqual({
      message: "hi",
      channels: ["auto"],
      priority: "normal",
    });
  });

  test("accepts explicit channels and priority", () => {
    expect(
      notifyAction.parseInput({ message: "hi", channels: ["telegram", "voice"], priority: "high" }),
    ).toEqual({ message: "hi", channels: ["telegram", "voice"], priority: "high" });
  });

  test("rejects unknown channels and priorities", () => {
    expect(() =>
      notifyAction.parseInput({ message: "hi", channels: ["sms"] }),
    ).toThrow(/channels\[\] must contain only/);
    expect(() => notifyAction.parseInput({ message: "hi", priority: "urgent" })).toThrow();
  });

  test("rejects missing/empty message", () => {
    expect(() => notifyAction.parseInput({})).toThrow();
    expect(() => notifyAction.parseInput({ message: "" })).toThrow();
  });

  test("empty channels array is normalized to ['auto']", () => {
    expect(notifyAction.parseInput({ message: "hi", channels: [] })).toEqual({
      message: "hi",
      channels: ["auto"],
      priority: "normal",
    });
  });
});

describe("jarvis-notify: execute", () => {
  test("forwards message + channels + priority to the notifier", async () => {
    const notifier = new StubNotifier({ delivered: ["telegram"], failed: [] });
    const out = await notifyAction.execute(
      { message: "hello world", channels: ["telegram"], priority: "high" },
      { services: { notifier } },
    );
    expect(out).toEqual({ delivered: ["telegram"], failed: [] });
    expect(notifier.calls).toEqual([
      { message: "hello world", channels: ["telegram"], priority: "high" },
    ]);
  });

  test("returns the notifier's failure report verbatim", async () => {
    const notifier = new StubNotifier({
      delivered: ["dashboard"],
      failed: [{ channel: "telegram", error: "rate limited" }],
    });
    const out = await notifyAction.execute(
      { message: "x", channels: ["auto"], priority: "normal" },
      { services: { notifier } },
    );
    expect(out.failed).toEqual([{ channel: "telegram", error: "rate limited" }]);
  });

  test("throws when the notifier service is missing", async () => {
    await expect(
      notifyAction.execute(
        { message: "x", channels: ["auto"], priority: "normal" },
        { services: {} },
      ),
    ).rejects.toThrow(/notifier is not configured/);
  });

  test("registers cleanly alongside the other pieces", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    r.register(jarvisToolPiece);
    r.register(jarvisNotifyPiece);
    expect(r.list().map((p) => p.name).sort()).toEqual([
      "jarvis-ask",
      "jarvis-notify",
      "jarvis-tool",
    ]);
    expect(r.resolveAction("jarvis-notify:notify")?.name).toBe("notify");
  });
});

// -------------------------------------------------------- jarvis-context

class StubContextProvider implements PieceContextProvider {
  public vaultSearchCalls: VaultSearchInput[] = [];
  public awarenessRecentCalls: AwarenessRecentInput[] = [];
  public commitmentsListCalls: CommitmentsListInput[] = [];
  public vaultGetEntityCalls: string[] = [];

  constructor(
    private readonly fixtures: {
      entities?: VaultEntitySnapshot[];
      activities?: AwarenessActivitySnapshot[];
      commitments?: CommitmentSnapshot[];
      entityById?: Record<string, VaultEntitySnapshot>;
    } = {},
  ) {}

  async vaultSearch(input: VaultSearchInput): Promise<VaultEntitySnapshot[]> {
    this.vaultSearchCalls.push(input);
    return this.fixtures.entities ?? [];
  }

  async vaultGetEntity(id: string): Promise<VaultEntitySnapshot | null> {
    this.vaultGetEntityCalls.push(id);
    return this.fixtures.entityById?.[id] ?? null;
  }

  async awarenessRecent(input: AwarenessRecentInput): Promise<AwarenessActivitySnapshot[]> {
    this.awarenessRecentCalls.push(input);
    return this.fixtures.activities ?? [];
  }

  async commitmentsList(input: CommitmentsListInput): Promise<CommitmentSnapshot[]> {
    this.commitmentsListCalls.push(input);
    return this.fixtures.commitments ?? [];
  }
}

describe("jarvis-context: vault_search", () => {
  test("strips unset fields and dispatches to the provider", async () => {
    const provider = new StubContextProvider({
      entities: [
        { id: "e1", type: "project", name: "Jarvis", properties: null, createdAt: 1, updatedAt: 1 },
      ],
    });
    const parsed = vaultSearchAction.parseInput({ query: "ja", type: "project", limit: 10 });
    const out = await vaultSearchAction.execute(parsed, { services: { context: provider } });
    expect(out).toHaveLength(1);
    expect(provider.vaultSearchCalls).toEqual([{ query: "ja", type: "project", limit: 10 }]);
  });

  test("rejects bad type / negative limit", () => {
    expect(() => vaultSearchAction.parseInput({ type: "alien" })).toThrow();
    expect(() => vaultSearchAction.parseInput({ limit: -1 })).toThrow();
    expect(() => vaultSearchAction.parseInput({ query: 5 })).toThrow();
  });

  test("requires a context provider in the services context", async () => {
    await expect(
      vaultSearchAction.execute({ query: "x" }, { services: {} }),
    ).rejects.toThrow(/context is not configured/);
  });
});

describe("jarvis-context: vault_get_entity", () => {
  test("returns the entity by id", async () => {
    const ent: VaultEntitySnapshot = {
      id: "e1",
      type: "person",
      name: "Vieri",
      properties: { role: "user" },
      createdAt: 1,
      updatedAt: 2,
    };
    const provider = new StubContextProvider({ entityById: { e1: ent } });
    const parsed = vaultGetEntityAction.parseInput({ id: "e1" });
    const got = await vaultGetEntityAction.execute(parsed, { services: { context: provider } });
    expect(got).toEqual(ent);
  });

  test("rejects empty id", () => {
    expect(() => vaultGetEntityAction.parseInput({})).toThrow();
    expect(() => vaultGetEntityAction.parseInput({ id: "" })).toThrow();
  });
});

describe("jarvis-context: awareness_recent", () => {
  test("supports limit and since cutoffs", async () => {
    const provider = new StubContextProvider();
    const parsed = awarenessRecentAction.parseInput({ limit: 5, since: 1_700_000_000_000 });
    await awarenessRecentAction.execute(parsed, { services: { context: provider } });
    expect(provider.awarenessRecentCalls).toEqual([{ limit: 5, since: 1_700_000_000_000 }]);
  });
});

describe("jarvis-context: commitments_list", () => {
  test("filters by status when provided; null returns when no provider", async () => {
    const provider = new StubContextProvider();
    const parsed = commitmentsListAction.parseInput({ status: "pending", limit: 3 });
    await commitmentsListAction.execute(parsed, { services: { context: provider } });
    expect(provider.commitmentsListCalls).toEqual([{ status: "pending", limit: 3 }]);
  });

  test("rejects bad status", () => {
    expect(() => commitmentsListAction.parseInput({ status: "later" })).toThrow();
  });
});

describe("jarvis-context registration", () => {
  test("all four actions resolve via the registry", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisContextPiece);
    expect(r.resolveAction("jarvis-context:vault_search")?.name).toBe("vault_search");
    expect(r.resolveAction("jarvis-context:vault_get_entity")?.name).toBe("vault_get_entity");
    expect(r.resolveAction("jarvis-context:awareness_recent")?.name).toBe("awareness_recent");
    expect(r.resolveAction("jarvis-context:commitments_list")?.name).toBe("commitments_list");
  });
});

// ---------------------------------------------------------- jarvis-agent

class StubAgentDelegator implements PieceAgentDelegator {
  public calls: PieceAgentDelegateInput[] = [];
  constructor(private readonly result: PieceAgentDelegateResult) {}
  async delegate(input: PieceAgentDelegateInput): Promise<PieceAgentDelegateResult> {
    this.calls.push(input);
    return this.result;
  }
}

describe("jarvis-agent: parseInput", () => {
  test("requires a goal; supports optional role + maxIterations", () => {
    expect(delegateAction.parseInput({ goal: "summarize my inbox" })).toEqual({
      goal: "summarize my inbox",
    });
    expect(
      delegateAction.parseInput({ goal: "x", role: "researcher", maxIterations: 5 }),
    ).toEqual({ goal: "x", role: "researcher", maxIterations: 5 });
  });

  test("rejects bad inputs", () => {
    expect(() => delegateAction.parseInput({})).toThrow();
    expect(() => delegateAction.parseInput({ goal: "" })).toThrow();
    expect(() => delegateAction.parseInput({ goal: "x", role: "" })).toThrow();
    expect(() => delegateAction.parseInput({ goal: "x", maxIterations: 0 })).toThrow();
    expect(() => delegateAction.parseInput({ goal: "x", maxIterations: 2.5 })).toThrow();
    expect(() => delegateAction.parseInput({ goal: "x", maxIterations: -3 })).toThrow();
  });
});

describe("jarvis-agent: execute", () => {
  test("dispatches to the delegator and returns the agent's result", async () => {
    const delegator = new StubAgentDelegator({
      finalMessage: "Done. 3 emails summarized.",
      toolCalls: [
        { name: "gmail_list", args: '{"query":"in:inbox"}', result: "[3 messages]" },
        { name: "vault_save", args: "{}" },
      ],
      status: "completed",
    });
    const out = await delegateAction.execute(
      { goal: "summarize my inbox", role: "researcher", maxIterations: 4 },
      { services: { agentDelegator: delegator } },
    );
    expect(out.status).toBe("completed");
    expect(out.toolCalls).toHaveLength(2);
    expect(out.finalMessage).toMatch(/3 emails/);
    expect(delegator.calls).toEqual([
      { goal: "summarize my inbox", role: "researcher", maxIterations: 4 },
    ]);
  });

  test("propagates a non-completed status verbatim", async () => {
    const delegator = new StubAgentDelegator({
      finalMessage: "",
      toolCalls: [],
      status: "max_iterations",
    });
    const out = await delegateAction.execute(
      { goal: "g" },
      { services: { agentDelegator: delegator } },
    );
    expect(out.status).toBe("max_iterations");
  });

  test("throws when the delegator service is missing", async () => {
    await expect(
      delegateAction.execute({ goal: "x" }, { services: {} }),
    ).rejects.toThrow(/agentDelegator is not configured/);
  });

  test("registers cleanly alongside the other pieces", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    r.register(jarvisToolPiece);
    r.register(jarvisNotifyPiece);
    r.register(jarvisContextPiece);
    r.register(jarvisAgentPiece);
    expect(r.list().map((p) => p.name).sort()).toEqual([
      "jarvis-agent",
      "jarvis-ask",
      "jarvis-context",
      "jarvis-notify",
      "jarvis-tool",
    ]);
    expect(r.resolveAction("jarvis-agent:delegate")?.name).toBe("delegate");
  });
});

// -------------------------------------------------------- jarvis-trigger

class StubEventBus implements PieceEventBus {
  private subs: Map<string, Set<(p: Record<string, unknown>) => void>> = new Map();
  subscribe(eventType: string, handler: (p: Record<string, unknown>) => void) {
    if (!this.subs.has(eventType)) this.subs.set(eventType, new Set());
    this.subs.get(eventType)!.add(handler);
    return () => this.subs.get(eventType)?.delete(handler);
  }
  listEventTypes(): string[] {
    return Array.from(this.subs.keys());
  }
  publish(eventType: string, payload: Record<string, unknown>): void {
    for (const h of this.subs.get(eventType) ?? new Set()) h(payload);
  }
  subscribersOf(eventType: string): number {
    return this.subs.get(eventType)?.size ?? 0;
  }
}

class StubWorkflowRunner implements PieceWorkflowRunner {
  public calls: PieceWorkflowStartInput[] = [];
  constructor(private readonly result: PieceWorkflowStartResult = { runId: "run_stub" }) {}
  async start(input: PieceWorkflowStartInput): Promise<PieceWorkflowStartResult> {
    this.calls.push(input);
    return this.result;
  }
}

function makeTriggerCtx(
  bus: PieceEventBus,
  onFire: (p: Record<string, unknown>) => Promise<void>,
): JarvisTriggerContext {
  return { services: { eventBus: bus }, onFire };
}

describe("jarvis-trigger.on_event: parseInput", () => {
  test("requires eventType; supports optional filter", () => {
    expect(onEventTrigger.parseInput({ eventType: "awareness.context_changed" })).toEqual({
      eventType: "awareness.context_changed",
    });
    expect(
      onEventTrigger.parseInput({ eventType: "x", filter: { app: "VS Code" } }),
    ).toEqual({ eventType: "x", filter: { app: "VS Code" } });
  });

  test("rejects bad inputs", () => {
    expect(() => onEventTrigger.parseInput({})).toThrow();
    expect(() => onEventTrigger.parseInput({ eventType: "" })).toThrow();
    expect(() => onEventTrigger.parseInput({ eventType: "x", filter: 5 })).toThrow();
    expect(() => onEventTrigger.parseInput({ eventType: "x", filter: [] })).toThrow();
  });
});

describe("jarvis-trigger.on_event: subscribe + fire", () => {
  test("subscribes on the bus and fires on matching events", async () => {
    const bus = new StubEventBus();
    const fires: Record<string, unknown>[] = [];
    const onFire = async (p: Record<string, unknown>) => { fires.push(p); };
    const sub = await onEventTrigger.subscribe(
      { eventType: "awareness.context_changed" },
      makeTriggerCtx(bus, onFire),
    );
    expect(bus.subscribersOf("awareness.context_changed")).toBe(1);
    bus.publish("awareness.context_changed", { app: "VS Code" });
    bus.publish("awareness.context_changed", { app: "Slack" });
    bus.publish("commitment.due", { id: "c1" });
    expect(fires).toEqual([{ app: "VS Code" }, { app: "Slack" }]);
    await sub.unsubscribe();
    expect(bus.subscribersOf("awareness.context_changed")).toBe(0);
  });

  test("filter narrows which events fire the workflow", async () => {
    const bus = new StubEventBus();
    const fires: Record<string, unknown>[] = [];
    const onFire = async (p: Record<string, unknown>) => { fires.push(p); };
    const sub = await onEventTrigger.subscribe(
      { eventType: "tool.executed", filter: { name: "vault_search" } },
      makeTriggerCtx(bus, onFire),
    );
    bus.publish("tool.executed", { name: "vault_search", ms: 5 });
    bus.publish("tool.executed", { name: "browser_screenshot" });
    bus.publish("tool.executed", { name: "vault_search", ms: 7 });
    expect(fires).toEqual([
      { name: "vault_search", ms: 5 },
      { name: "vault_search", ms: 7 },
    ]);
    await sub.unsubscribe();
  });

  test("subscribe throws when the event bus is missing", async () => {
    const onFire = async () => { /* noop */ };
    await expect(
      onEventTrigger.subscribe(
        { eventType: "x" },
        { services: {}, onFire },
      ),
    ).rejects.toThrow(/eventBus is not configured/);
  });
});

describe("jarvis-trigger.run_workflow: parseInput", () => {
  test("requires flowId or flowName", () => {
    expect(() => runWorkflowAction.parseInput({})).toThrow(/requires flowId or flowName/);
    expect(runWorkflowAction.parseInput({ flowId: "f1" })).toEqual({ flowId: "f1" });
    expect(runWorkflowAction.parseInput({ flowName: "Morning briefing" })).toEqual({
      flowName: "Morning briefing",
    });
  });

  test("rejects empty strings and bad payload types", () => {
    expect(() => runWorkflowAction.parseInput({ flowId: "" })).toThrow();
    expect(() => runWorkflowAction.parseInput({ flowName: "" })).toThrow();
    expect(() => runWorkflowAction.parseInput({ flowId: "f", payload: 5 })).toThrow();
    expect(() => runWorkflowAction.parseInput({ flowId: "f", payload: [] })).toThrow();
  });
});

describe("jarvis-trigger.run_workflow: execute", () => {
  test("dispatches to the workflow runner and returns the run id", async () => {
    const runner = new StubWorkflowRunner({ runId: "run_started" });
    const out = await runWorkflowAction.execute(
      { flowName: "morning", payload: { tone: "brief" } },
      { services: { workflowRunner: runner } },
    );
    expect(out).toEqual({ runId: "run_started" });
    expect(runner.calls).toEqual([{ flowName: "morning", payload: { tone: "brief" } }]);
  });

  test("throws when the workflowRunner service is missing", async () => {
    await expect(
      runWorkflowAction.execute({ flowId: "f" }, { services: {} }),
    ).rejects.toThrow(/workflowRunner is not configured/);
  });
});

describe("jarvis-trigger registration", () => {
  test("piece exposes the action AND the trigger; registry resolves both", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisTriggerPiece);
    expect(r.resolveAction("jarvis-trigger:run_workflow")?.name).toBe("run_workflow");
    expect(r.resolveTrigger("jarvis-trigger:on_event")?.name).toBe("on_event");
    // Negative cases:
    expect(r.resolveTrigger("jarvis-trigger:run_workflow")).toBeNull();
    expect(r.resolveAction("jarvis-trigger:on_event")).toBeNull();
  });

  test("all six Jarvis pieces register cleanly together", () => {
    const r = new JarvisPieceRegistry();
    r.register(jarvisAskPiece);
    r.register(jarvisToolPiece);
    r.register(jarvisNotifyPiece);
    r.register(jarvisContextPiece);
    r.register(jarvisAgentPiece);
    r.register(jarvisTriggerPiece);
    expect(r.list().map((p) => p.name).sort()).toEqual([
      "jarvis-agent",
      "jarvis-ask",
      "jarvis-context",
      "jarvis-notify",
      "jarvis-tool",
      "jarvis-trigger",
    ]);
  });
});

// Smoke: the JarvisPiece type tolerates pieces with no actions (degenerate).
describe("JarvisPiece shape", () => {
  test("a piece with no actions resolves to null on any action lookup", () => {
    const empty: JarvisPiece = {
      name: "empty",
      displayName: "Empty",
      description: "",
      actions: {} as Record<string, JarvisAction>,
    };
    const r = new JarvisPieceRegistry();
    r.register(empty);
    expect(r.resolveAction("empty:anything")).toBeNull();
  });
});
