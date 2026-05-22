import { describe, expect, test } from "bun:test";
import { composeFlow } from "./workflow-composer";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures";
import type { ComposerLlmClient } from "./workflow-composer";

class StubLlm implements ComposerLlmClient {
  public calls: Array<{ prompt: string; system?: string }> = [];
  /**
   * Either a fixed string returned for every call, or an array of
   * per-attempt replies (consumed in order; extra calls reuse the
   * last entry). The array form lets tests model the "succeeds on
   * retry" case that the iterative composer is designed to handle.
   */
  private readonly replies: string[];
  constructor(reply: string | string[]) {
    this.replies = Array.isArray(reply) ? reply : [reply];
  }
  async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
    this.calls.push(input);
    const idx = Math.min(this.calls.length - 1, this.replies.length - 1);
    return { text: this.replies[idx]! };
  }
}

const makeRegistry = () => sampleCatalog();

describe("composeFlow", () => {
  test("happy path: parses + validates an inbox-summary flow", async () => {
    const reply = JSON.stringify({
      displayName: "Inbox summary",
      trigger: {
        name: "trigger",
        type: "PIECE_TRIGGER",
        settings: { pieceName: "schedule", input: { cron_expression: "0 8 * * *" } },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          settings: {
            pieceName: "jarvis-ask",
            actionName: "ask",
            input: { prompt: "Summarize my inbox: {{trigger.body}}" },
          },
          nextAction: {
            name: "step_2",
            type: "PIECE",
            settings: {
              pieceName: "jarvis-notify",
              actionName: "notify",
              input: { message: "{{step_1.text}}" },
            },
          },
        },
      },
    });
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "Inbox summary", description: "every morning at 8 summarize my inbox" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.displayName).toBe("Inbox summary");
      expect(result.flow.trigger.name).toBe("trigger");
      expect(result.flow.trigger.nextAction?.name).toBe("step_1");
      expect(result.flow.trigger.nextAction?.nextAction?.name).toBe("step_2");
    }
  });

  test("strips a fenced JSON response from the LLM", async () => {
    const reply = "```json\n" + JSON.stringify({
      displayName: "X",
      trigger: { name: "trigger", type: "EMPTY" },
    }) + "\n```";
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "X", description: "manual one-shot" },
    );
    expect(result.ok).toBe(true);
  });

  test("malformed JSON is reported with rawResponse", async () => {
    const result = await composeFlow(
      { llm: new StubLlm("I think... {something}"), pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/not valid JSON/);
      expect(result.rawResponse).toBe("I think... {something}");
    }
  });

  test("rejects unknown piece references", async () => {
    const reply = JSON.stringify({
      displayName: "X",
      trigger: {
        name: "trigger",
        type: "EMPTY",
        nextAction: {
          name: "step_1",
          type: "PIECE",
          settings: { pieceName: "ghost", actionName: "doit" },
        },
      },
    });
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /unknown piece "ghost"/.test(e))).toBe(true);
    }
  });

  test("rejects PIECE_TRIGGER with no piece name", async () => {
    const reply = JSON.stringify({
      displayName: "X",
      trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: {} },
    });
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /missing settings\.pieceName/.test(e))).toBe(true);
    }
  });

  test("flags missing required input fields", async () => {
    const reply = JSON.stringify({
      displayName: "X",
      trigger: {
        name: "trigger",
        type: "EMPTY",
        nextAction: {
          name: "step_1",
          type: "PIECE",
          settings: { pieceName: "jarvis-ask", actionName: "ask", input: {} }, // prompt is required
        },
      },
    });
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /missing required input "prompt"/.test(e))).toBe(true);
    }
  });

  test("schedule and webhook are accepted as built-in trigger primitives", async () => {
    const replyA = JSON.stringify({
      displayName: "S",
      trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 * * * *" } } },
    });
    const a = await composeFlow(
      { llm: new StubLlm(replyA), pieceRegistry: makeRegistry() },
      { name: "S", description: "hourly" },
    );
    expect(a.ok).toBe(true);

    const replyB = JSON.stringify({
      displayName: "W",
      trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "webhook", input: {} } },
    });
    const b = await composeFlow(
      { llm: new StubLlm(replyB), pieceRegistry: makeRegistry() },
      { name: "W", description: "webhook" },
    );
    expect(b.ok).toBe(true);
  });

  test("system prompt includes the piece catalog and primitives", async () => {
    const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
    await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    const sys = llm.calls[0]?.system ?? "";
    expect(sys).toContain("jarvis-ask");
    expect(sys).toContain("jarvis-notify");
    expect(sys).toContain("jarvis-trigger");
    expect(sys).toContain("schedule");
    expect(sys).toContain("webhook");
  });

  test("missing description / name is reported up front", async () => {
    const llm = new StubLlm("ignored");
    const a = await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: " ", description: "x" });
    expect(a.ok).toBe(false);
    const b = await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "n", description: " " });
    expect(b.ok).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  test("rejects step names that violate STEP_NAME_REGEX", async () => {
    const reply = JSON.stringify({
      displayName: "X",
      trigger: {
        name: "trigger",
        type: "EMPTY",
        nextAction: {
          name: "Step 1",
          type: "PIECE",
          settings: { pieceName: "jarvis-ask", actionName: "ask", input: { prompt: "hi" } },
        },
      },
    });
    const result = await composeFlow(
      { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /must match identifier pattern/.test(e))).toBe(true);
    }
  });

  test("system prompt includes tool names when provided", async () => {
    const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
    await composeFlow(
      { llm, pieceRegistry: makeRegistry(), toolNames: ["gmail_send", "vault_search"] },
      { name: "X", description: "x" },
    );
    const sys = llm.calls[0]?.system ?? "";
    expect(sys).toContain("gmail_send");
    expect(sys).toContain("vault_search");
    expect(sys).toContain("Available Jarvis tools");
  });

  test("system prompt mentions the DISABLED-default contract", async () => {
    const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
    await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    const sys = llm.calls[0]?.system ?? "";
    expect(sys).toMatch(/DISABLED/);
  });

  test("LLM error is surfaced", async () => {
    const llm: ComposerLlmClient = {
      async chat() {
        throw new Error("provider unavailable");
      },
    };
    const result = await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "X", description: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/LLM call failed/);
    }
  });

  test("strips <think> reasoning blocks before JSON.parse", async () => {
    // Qwen3 / DeepSeek-R1 / o1-style models emit a chain-of-thought
    // before the actual answer. The composer must look past it.
    const reply =
      "<think>\nThe user wants a daily inbox brief. I'll use schedule + ask.\n</think>\n\n" +
      JSON.stringify({
        displayName: "Thinky",
        trigger: { name: "trigger", type: "EMPTY" },
      });
    const llm = new StubLlm(reply);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "Thinky", description: "iterate inbox" },
    );
    expect(result.ok).toBe(true);
  });

  test("extracts JSON when wrapped in prose", async () => {
    // Some models ignore "no prose" and surround the JSON with text.
    // We extract the outermost {...} as a last resort.
    const reply =
      'Here is the workflow you requested:\n\n' +
      JSON.stringify({
        displayName: "Wrapped",
        trigger: { name: "trigger", type: "EMPTY" },
      }) +
      '\n\nLet me know if you need anything else!';
    const llm = new StubLlm(reply);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "Wrapped", description: "x" },
    );
    expect(result.ok).toBe(true);
  });

  test("truncated <think> with no closing tag fails cleanly with rawResponse tail", async () => {
    // Reasoning model truncated mid-thought -- never produced JSON.
    // We should fail fast (no "Unexpected token <" from JSON.parse
    // hitting "<think>") and surface the tail so the operator can see
    // what happened. With maxAttempts=1 we don't retry; the test
    // asserts the single-shot failure shape.
    const reply = "<think>\nThe user wants ... and I should plan by first considering ...";
    const llm = new StubLlm(reply);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), maxAttempts: 1 },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/response was not valid JSON/);
      expect(result.errors[0]).toMatch(/rawResponse: \d+ chars/);
    }
  });

  describe("iterative retry loop", () => {
    const goodReply = JSON.stringify({
      displayName: "Recovered",
      trigger: { name: "trigger", type: "EMPTY" },
    });

    test("succeeds on the second attempt after a parse failure", async () => {
      // Attempt 1: garbage. Attempt 2: valid. The loop should call
      // the LLM twice, feed the parse error back, and return ok.
      const llm = new StubLlm(["not json at all { incomplete", goodReply]);
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 4 },
        { name: "Recovered", description: "x" },
      );
      expect(result.ok).toBe(true);
      expect(llm.calls).toHaveLength(2);
      // Retry prompt mentions the parse failure so the model knows
      // what to fix.
      expect(llm.calls[1]?.prompt).toMatch(/previous reply could not be parsed/);
    });

    test("succeeds on the second attempt after a validation failure", async () => {
      const badReply = JSON.stringify({
        displayName: "Bad",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "ghost-piece", actionName: "any" },
          },
        },
      });
      const llm = new StubLlm([badReply, goodReply]);
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 4 },
        { name: "Recovered", description: "x" },
      );
      expect(result.ok).toBe(true);
      expect(llm.calls).toHaveLength(2);
      // Retry prompt enumerates the validation failures so the model
      // can target them.
      expect(llm.calls[1]?.prompt).toMatch(/previous JSON failed validation/);
      expect(llm.calls[1]?.prompt).toMatch(/unknown piece "ghost-piece"/);
    });

    test("exhausts maxAttempts and returns the last error", async () => {
      // Every attempt returns the same invalid JSON. Loop should hit
      // the cap, log "exhausted", and return the latest errors.
      const badReply = "{ not valid json";
      const llm = new StubLlm(badReply);
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 3 },
        { name: "X", description: "x" },
      );
      expect(result.ok).toBe(false);
      expect(llm.calls).toHaveLength(3);
      if (!result.ok) {
        expect(result.errors[0]).toMatch(/response was not valid JSON/);
      }
    });

    test("LLM throw aborts immediately (no retry against unavailable provider)", async () => {
      let n = 0;
      const llm: ComposerLlmClient = {
        async chat() {
          n++;
          throw new Error("provider down");
        },
      };
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 4 },
        { name: "X", description: "x" },
      );
      expect(result.ok).toBe(false);
      // ONE call -- transport failures aren't fixed by re-asking.
      expect(n).toBe(1);
      if (!result.ok) {
        expect(result.errors[0]).toMatch(/LLM call failed/);
      }
    });

    test("defaults to maxAttempts=4 when omitted", async () => {
      // Pure-validation-failure with a non-recovering stub: 4 attempts.
      const badReply = JSON.stringify({
        displayName: "X",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "ghost", actionName: "any" },
          },
        },
      });
      const llm = new StubLlm(badReply);
      await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "X", description: "x" });
      expect(llm.calls).toHaveLength(4);
    });
  });
});
