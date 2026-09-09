import { describe, expect, test } from "bun:test";
import { LLMManager } from "../../llm/manager.ts";
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

/** A manager whose tiers map to the providers given, by tier name. */
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

describe("createComposerLlmClient: which model writes the workflow", () => {
  test("composes on the high tier, not medium", async () => {
    // The bug this exists to prevent: the composer used the deprecated
    // LLMManager.chat(), which routes every call to the medium tier.
    const high = new RecordingProvider("high-model");
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await client.chat({ prompt: "every morning at 8, summarize my inbox" });

    expect(high.calls).toHaveLength(1);
    expect(medium.calls).toHaveLength(0);
  });

  test("the tool-calling path uses the high tier too", async () => {
    const high = new RecordingProvider("high-model", { content: "", tool_calls: [] });
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await client.chatTools!([{ role: "user", content: "build it" }], []);

    expect(high.calls).toHaveLength(1);
    expect(medium.calls).toHaveLength(0);
  });

  test("falls up to medium when no high tier is configured", async () => {
    // A single-model install must keep working with no tier wiring at all.
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ medium }));

    await client.chat({ prompt: "x" });

    expect(medium.calls).toHaveLength(1);
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
  test("a rejected `tools` parameter still reaches the composer", async () => {
    // composeWithTools CATCHES this and falls back to the one-shot prompt.
    // If tier routing ever swallowed it, a model without tool support would
    // dead-end instead of composing.
    const high = new RecordingProvider("high-model", new Error("tools is not supported by this model"));
    const client = createComposerLlmClient(managerWith({ high }));

    let caught: unknown;
    try {
      await client.chatTools!([{ role: "user", content: "build it" }], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // The composer classifies the failure off the message text.
    expect((caught as Error).message).toContain("tools is not supported");
  });

  test("does not fail over to the medium tier on a non-retryable error", async () => {
    // Falling back to the weaker model on a bad request would silently undo
    // the whole point of routing composition to `high`.
    const high = new RecordingProvider("high-model", new Error("tools is not supported by this model"));
    const medium = new RecordingProvider("medium-model");
    const client = createComposerLlmClient(managerWith({ high, medium }));

    await expect(client.chat({ prompt: "x" })).rejects.toThrow();
    expect(medium.calls).toHaveLength(0);
    expect(high.calls).toHaveLength(1); // no retry storm either
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

  test("yields empty text rather than a non-string body", async () => {
    const high = new RecordingProvider("high-model", { content: [{ type: "text" }] as unknown as string });
    const client = createComposerLlmClient(managerWith({ high }));

    expect(await client.chat({ prompt: "x" })).toEqual({ text: "" });
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
