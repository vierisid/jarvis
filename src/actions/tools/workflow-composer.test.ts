import { describe, expect, test } from "bun:test";
import { composeFlow } from "./workflow-composer";
import { JarvisPieceRegistry, type PieceLlmClient, type PieceLlmInput, type PieceLlmResponse } from "../../workflows/jarvis-pieces/types";
import { jarvisAskPiece } from "../../workflows/jarvis-pieces/jarvis-ask";
import { jarvisNotifyPiece } from "../../workflows/jarvis-pieces/jarvis-notify";
import { jarvisTriggerPiece } from "../../workflows/jarvis-pieces/jarvis-trigger";

class StubLlm implements PieceLlmClient {
  public calls: PieceLlmInput[] = [];
  constructor(private readonly reply: string) {}
  async chat(input: PieceLlmInput): Promise<PieceLlmResponse> {
    this.calls.push(input);
    return { text: this.reply };
  }
}

function makeRegistry(): JarvisPieceRegistry {
  const r = new JarvisPieceRegistry();
  r.register(jarvisAskPiece);
  r.register(jarvisNotifyPiece);
  r.register(jarvisTriggerPiece);
  return r;
}

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
    const llm: PieceLlmClient = {
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
});
