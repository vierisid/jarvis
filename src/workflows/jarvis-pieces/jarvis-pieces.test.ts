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
} from "./types";
import { askAction, jarvisAskPiece, parseJsonReply } from "./jarvis-ask";

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
