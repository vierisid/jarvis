import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, initDatabase } from "../../vault/schema.ts";
import { LLMManager } from "../../llm/manager.ts";
import { classifyErrorString, LLMProviderError } from "../../llm/provider.ts";
import { queryUsage, setUsageDatabase } from "../../llm/usage.ts";
import type {
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
} from "../../llm/provider.ts";
import { createComposerLlmClient } from "./composer-llm.ts";

type Call = { messages: LLMMessage[]; options?: LLMOptions };

/** Records what it was asked, answers with whatever the test supplied. */
class RecordingProvider implements LLMProvider {
  public calls: Call[] = [];
  constructor(
    public readonly name: string,
    private readonly reply: Partial<LLMResponse> | Error = { content: "{}" },
  ) {}
  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    this.calls.push({ messages, options });
    if (this.reply instanceof Error) throw this.reply;
    return { content: "", model: this.name, ...this.reply } as LLMResponse;
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamEvent> {
    throw new Error("not used");
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}

/**
 * A manager whose tiers map to the providers given, by tier name. Real
 * `LLMManager`, fake providers -- so tier resolution, fall-up and failover are
 * the production code, not a stand-in. (Registration order also decides the
 * legacy primary, which only matters to the empty-tier-map test below.)
 */
function managerWith(tiers: Partial<Record<"high" | "medium" | "low", RecordingProvider>>): LLMManager {
  const m = new LLMManager();
  const map: Record<string, { provider: string }> = {};
  for (const [tier, provider] of Object.entries(tiers)) {
    m.registerProvider(provider!);
    map[tier] = { provider: provider!.name };
  }
  m.setTierMap(map);
  return m;
}

/**
 * The usage rows this test file's calls produced, newest first. `groupBy:
 * "none"` returns the ungrouped rows under `raw`; `rows` stays empty.
 */
function usageRows(): Array<Record<string, unknown>> {
  return (queryUsage({}, "none").raw ?? []) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  // recordUsage is best-effort and silently no-ops without a database, so the
  // label assertions below need a real one.
  closeDb();
  const db = initDatabase(":memory:", { quiet: true });
  setUsageDatabase(() => db);
});

afterEach(() => {
  closeDb();
});

describe("createComposerLlmClient: which model writes the workflow", () => {
  test("composes on the high tier, not medium", async () => {
    // The bug this exists to prevent: the composer used the deprecated
    // LLMManager.chat(), which routes to whatever `medium` resolves to.
    const high = new RecordingProvider("high-model");
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await client.chat({ prompt: "every morning at 8, summarize my inbox" });

    expect(high.calls).toHaveLength(1);
    expect(medium.calls).toHaveLength(0);
  });

  test("books the spend to workflow_composer, not legacy", async () => {
    // The other half of the original bug: the deprecated path labels every
    // call `legacy`, so workflow composition was not merely on the wrong
    // model, it was invisible in per-subsystem usage reporting.
    const high = new RecordingProvider("high-model");
    const client = createComposerLlmClient(managerWith({ high }));

    await client.chat({ prompt: "x" });

    const rows = usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subsystem).toBe("workflow_composer");
    expect(rows[0]!.tier).toBe("high");
  });

  test("the tool-calling path uses the high tier too", async () => {
    const high = new RecordingProvider("high-model", { content: "", tool_calls: [] });
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await client.chatTools!([{ role: "user", content: "build it" }], []);

    expect(high.calls).toHaveLength(1);
    expect(medium.calls).toHaveLength(0);
  });

  test("falls up to medium when only a medium tier is configured", async () => {
    // Not the single-model case -- `llm.default` populates low/medium/high
    // with the same ref, so those resolve `high` directly. This is the install
    // that sets only `llm.tiers.medium`, or whose `high` ref names a provider
    // that was never registered and got dropped.
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ medium }));

    await client.chat({ prompt: "x" });

    expect(medium.calls).toHaveLength(1);
    // Requested high, served by medium: a shape only chatTier('high') makes,
    // so this stays load-bearing if someone reverts the routing.
    const [row] = usageRows();
    expect(row?.tier).toBe("high");
    expect(row?.resolved_tier).toBe("medium");
  });

  test("fails loudly, not silently, when no task tier is configured at all", async () => {
    // `configureLLMTiers` can produce an EMPTY tier map (no llm.default, no
    // llm.tiers, or every ref naming an unregistered provider), and nothing
    // calls `validateTierMap` in production. The deprecated `chat()` used to
    // paper over that by dropping to the legacy primary-provider chain.
    //
    // Deliberately not preserved. Composing on whatever provider happened to
    // be first is exactly the invisible routing this module exists to end,
    // every other task-tier subsystem (sub_agent, vault_extractor, goals)
    // already throws on such a config, and the error names the setting to fix.
    //
    // This IS user-visible: an install that registers providers but sets
    // neither `llm.default` nor `llm.tiers` could compose before and now
    // cannot. That is the intended trade, not a regression to fix later.
    const orphan = new RecordingProvider("registered-but-untiered");
    const m = new LLMManager();
    m.registerProvider(orphan);
    m.setTierMap({});
    const client = createComposerLlmClient(m);

    await expect(client.chat({ prompt: "x" })).rejects.toThrow(/No provider configured for tier/);
    expect(orphan.calls).toHaveLength(0);
  });
});

describe("createComposerLlmClient: request shape", () => {
  test("sends system then user, and caps output on both paths", async () => {
    // The cap is load-bearing: Ollama's default num_predict is 128, which
    // truncates every compose reply mid-JSON. Both paths must agree on it or
    // truncation bugs become unreproducible.
    const high = new RecordingProvider("high-model", { content: "{}", tool_calls: [] });
    const client = createComposerLlmClient(managerWith({ high }));

    await client.chat({ system: "you are the composer", prompt: "make a flow" });
    expect(high.calls[0]!.messages).toEqual([
      { role: "system", content: "you are the composer" },
      { role: "user", content: "make a flow" },
    ]);
    expect(high.calls[0]!.options?.max_tokens).toBe(8192);

    await client.chatTools!([{ role: "user", content: "make a flow" }], []);
    expect(high.calls[1]!.options?.max_tokens).toBe(8192);
  });

  test("omits the system message when the composer sends none", async () => {
    const high = new RecordingProvider("high-model");
    const client = createComposerLlmClient(managerWith({ high }));

    await client.chat({ prompt: "just the user turn" });

    expect(high.calls[0]!.messages).toEqual([{ role: "user", content: "just the user turn" }]);
  });

  test("passes the composer's tools through with tool_choice auto", async () => {
    const high = new RecordingProvider("high-model", { content: "", tool_calls: [] });
    const client = createComposerLlmClient(managerWith({ high }));
    const tools = [
      { name: "list_pieces", description: "List installed pieces.", parameters: { type: "object" as const, properties: {} } },
    ];

    await client.chatTools!([{ role: "user", content: "build it" }], tools);

    expect(high.calls[0]!.options?.tools).toEqual(tools);
    expect(high.calls[0]!.options?.tool_choice).toBe("auto");
  });
});

describe("createComposerLlmClient: errors the composer depends on", () => {
  test("a rejected `tools` parameter still reaches the composer, classifiable", async () => {
    // composeWithTools CATCHES this and falls back to the one-shot prompt --
    // but only for codes outside {rate_limit, network, server, auth,
    // forbidden}. So what has to survive the manager's rewrapping is not the
    // wording, it is the CLASSIFICATION. Assert the thing the composer
    // actually branches on.
    const high = new RecordingProvider("high-model", new Error("tools is not supported by this model"));
    const client = createComposerLlmClient(managerWith({ high }));

    let caught: unknown;
    try {
      await client.chatTools!([{ role: "user", content: "build it" }], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LLMProviderError);
    expect((caught as LLMProviderError).code).toBe("unknown");
    expect(classifyErrorString((caught as Error).message)).toBe("unknown");
  });

  test("a request the high model itself rejects is not re-sent to medium", async () => {
    // Quietly re-running a rejected compose on the weaker model would undo
    // the point of routing to `high`. Note this holds for errors the manager
    // classifies as `unknown`; see the next test for the ones where failover
    // is deliberate manager policy.
    const high = new RecordingProvider("high-model", new Error("tools is not supported by this model"));
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await expect(client.chat({ prompt: "x" })).rejects.toThrow();
    expect(medium.calls).toHaveLength(0);
    expect(high.calls).toHaveLength(1); // no retry storm either
  });

  test("but a decommissioned high model DOES fall over to medium", async () => {
    // `shouldFailOver` crosses the provider boundary when the upstream says
    // the MODEL is gone -- otherwise a retired high-tier model would take
    // workflow composition down entirely rather than degrade to medium.
    // Pinned because it is a real hole in "composition always runs on high",
    // and someone reading only the test above would not expect it.
    const high = new RecordingProvider("high-model", new Error("404 model not found: this model has been decommissioned"));
    const medium = new RecordingProvider("medium-model", { content: "{}" });
    const client = createComposerLlmClient(managerWith({ high, medium }));

    expect(await client.chat({ prompt: "x" })).toEqual({ text: "{}" });
    expect(medium.calls).toHaveLength(1);
  });
});

describe("createComposerLlmClient: reply projection", () => {
  test("returns the assistant text from `content`", async () => {
    // An earlier version of this adapter read `reply.text`, which does not
    // exist on the response shape: every compose returned "" and the parse
    // died with EOF.
    const high = new RecordingProvider("high-model", { content: '{"displayName":"X"}' });
    const client = createComposerLlmClient(managerWith({ high }));

    expect(await client.chat({ prompt: "x" })).toEqual({ text: '{"displayName":"X"}' });
  });

  test("yields empty text on a non-string body, and logs why", async () => {
    // A content-block body cannot become a workflow tree, so the compose
    // still fails its parse -- but silently returning "" is what made the
    // original `reply.text` bug take four attempts to even look like a
    // provider problem, so the adapter says so on the way past.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const high = new RecordingProvider("high-model", { content: [{ type: "text" }] as unknown as string });
      const client = createComposerLlmClient(managerWith({ high }));

      expect(await client.chat({ prompt: "x" })).toEqual({ text: "" });
    } finally {
      console.warn = realWarn;
    }
    expect(warnings.join(" ")).toContain("non-string content body");
  });

  test("surfaces tool_calls and finish_reason for the tool loop", async () => {
    // The loop reads finish_reason to tell a reply truncated at the token cap
    // (a dropped submit_flow) from a genuine prose answer.
    const high = new RecordingProvider("high-model", {
      content: "",
      tool_calls: [{ id: "1", name: "submit_flow", arguments: { displayName: "X" } }],
      finish_reason: "tool_use",
    });
    const client = createComposerLlmClient(managerWith({ high }));

    const reply = await client.chatTools!([{ role: "user", content: "build it" }], []);
    expect(reply.tool_calls).toHaveLength(1);
    expect(reply.tool_calls?.[0]?.name).toBe("submit_flow");
    expect(reply.finish_reason).toBe("tool_use");
  });

  test("defaults tool_calls to an empty array when the provider omits them", async () => {
    const high = new RecordingProvider("high-model", { content: "no tools for you" });
    const client = createComposerLlmClient(managerWith({ high }));

    const reply = await client.chatTools!([{ role: "user", content: "build it" }], []);
    expect(reply.tool_calls).toEqual([]);
    expect(reply.content).toBe("no tools for you");
  });
});
