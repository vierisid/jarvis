import { describe, expect, test } from "bun:test";
import { composeFlow } from "./workflow-composer";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures";
import { PieceCatalog, type PieceCatalogEntry, type PieceLookup } from "../../workflows/runtime/piece-catalog";
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

  describe("delegate sub-agent role validation", () => {
    // Catalog keyed by the canonical npm name (like production) so the test
    // also exercises the short-name -> canonical resolution path.
    function agentCatalog(): PieceLookup {
      const entries: PieceCatalogEntry[] = [
        {
          name: "@jarvispieces/piece-jarvis-agent",
          displayName: "Jarvis: Agent",
          description: "Run a Jarvis sub-agent with a goal.",
          actions: {
            delegate: {
              name: "delegate",
              displayName: "Delegate",
              description: "Hand a goal to a sub-agent.",
              inputSchema: {
                fields: [
                  { name: "goal", label: "Goal", type: "long_text", required: true },
                  { name: "role", label: "Specialist role", type: "string", required: false },
                ],
              },
            },
          },
        },
      ];
      return new PieceCatalog(entries);
    }

    const roles = [
      { id: "research-analyst", name: "Research Analyst", description: "Investigates topics." },
      { id: "content-writer", name: "Content Writer", description: "Drafts copy." },
    ];

    const delegateFlow = (role?: string) =>
      JSON.stringify({
        displayName: "Delegated",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: {
              pieceName: "jarvis-agent",
              actionName: "delegate",
              input: { goal: "research AI news", ...(role !== undefined ? { role } : {}) },
            },
          },
        },
      });

    test("lists the valid role ids + a verbatim rule in the system prompt", async () => {
      const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
      await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles },
        { name: "X", description: "x" },
      );
      const sys = llm.calls[0]?.system ?? "";
      expect(sys).toContain("Available specialist sub-agent roles");
      expect(sys).toContain("research-analyst");
      expect(sys).toContain("content-writer");
      // The rule steers the model away from invented ids.
      expect(sys).toMatch(/MUST be one of the specialist role ids/);
    });

    test("rejects a delegate step whose role isn't a known specialist", async () => {
      // The exact bug: LLM picks "researcher" (no such role; it's "research-analyst").
      const llm = new StubLlm(delegateFlow("researcher"));
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles, maxAttempts: 1 },
        { name: "Delegated", description: "research AI news and report back" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /unknown specialist role "researcher"/.test(e))).toBe(true);
        // The error enumerates the real ids so the retry can self-correct.
        expect(result.errors.some((e) => /research-analyst/.test(e))).toBe(true);
      }
    });

    test("self-corrects to a valid role on retry", async () => {
      const llm = new StubLlm([delegateFlow("researcher"), delegateFlow("research-analyst")]);
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles, maxAttempts: 4 },
        { name: "Delegated", description: "research AI news" },
      );
      expect(result.ok).toBe(true);
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[1]?.prompt).toMatch(/unknown specialist role "researcher"/);
    });

    test("accepts a valid role id", async () => {
      const llm = new StubLlm(delegateFlow("research-analyst"));
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles },
        { name: "Delegated", description: "research AI news" },
      );
      expect(result.ok).toBe(true);
    });

    test("accepts an omitted role (default agent)", async () => {
      const llm = new StubLlm(delegateFlow(undefined));
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles },
        { name: "Delegated", description: "research AI news" },
      );
      expect(result.ok).toBe(true);
    });

    test("skips validation for a templated role expression", async () => {
      // {{trigger.role}} resolves at runtime; we can't check it at compose time.
      const llm = new StubLlm(delegateFlow("{{trigger.role}}"));
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog(), specialistRoles: roles },
        { name: "Delegated", description: "research" },
      );
      expect(result.ok).toBe(true);
    });

    test("does not enforce roles when the caller supplies none", async () => {
      // Without a role set we can't tell a typo from a real id, so a bogus
      // role passes (back-compat: callers that don't wire roles aren't broken).
      const llm = new StubLlm(delegateFlow("researcher"));
      const result = await composeFlow(
        { llm, pieceRegistry: agentCatalog() },
        { name: "Delegated", description: "research" },
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("system prompt surfaces output samples", () => {
    // A catalog whose two actions cover both shapes: an object output
    // (jarvis-tool.invoke returns { result, toolName }) and a bare-array
    // output (vault_search returns a list). The composer should render
    // both so the LLM has real field names instead of guessing.
    function catalogWithOutputs(): PieceLookup {
      const entries: PieceCatalogEntry[] = [
        {
          name: "jarvis-tool",
          displayName: "Jarvis: Tool",
          description: "Invoke a registered Jarvis tool.",
          actions: {
            invoke: {
              name: "invoke",
              displayName: "Invoke",
              description: "Call a tool.",
              inputSchema: { fields: [{ name: "toolName", label: "Tool", type: "string", required: true }] },
              outputSample: { result: "the actual return value", toolName: "get_clipboard" },
            },
          },
        },
        {
          name: "jarvis-context",
          displayName: "Jarvis: Context",
          description: "Read vault context.",
          actions: {
            vault_search: {
              name: "vault_search",
              displayName: "Vault: search",
              description: "Find entities.",
              inputSchema: { fields: [{ name: "query", label: "Query", type: "string", required: false }] },
              outputSample: [
                { id: "ent_01", type: "person", name: "Alice" },
              ],
            },
          },
        },
      ];
      return new PieceCatalog(entries);
    }

    test("object outputs surface as inline {field: example} so the LLM sees real key names", async () => {
      const llm = new StubLlm(
        JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }),
      );
      await composeFlow(
        { llm, pieceRegistry: catalogWithOutputs() },
        { name: "X", description: "x" },
      );
      const sys = llm.calls[0]?.system ?? "";
      // The line should mention BOTH top-level keys so a wiring like
      // `{{step.result}}` is grounded.
      expect(sys).toMatch(/output: \{ result: ".*", toolName: ".*" \}/);
    });

    test("array outputs surface as `[{...keys...}, ...]` so loop iteration is discoverable", async () => {
      const llm = new StubLlm(
        JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }),
      );
      await composeFlow(
        { llm, pieceRegistry: catalogWithOutputs() },
        { name: "X", description: "x" },
      );
      const sys = llm.calls[0]?.system ?? "";
      expect(sys).toMatch(/output: \[\{ id: .* \}, \.\.\.\] \(array\)/);
    });

    test("prompt explicitly warns against guessing field names from user wording", async () => {
      const llm = new StubLlm(
        JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }),
      );
      await composeFlow(
        { llm, pieceRegistry: catalogWithOutputs() },
        { name: "X", description: "x" },
      );
      const sys = llm.calls[0]?.system ?? "";
      // The specific failure mode -- model picks `.content` because the
      // user said "content" -- is called out by name in the rules.
      expect(sys).toMatch(/MUST exist on that step's declared `output`/);
      expect(sys).toMatch(/'content'/);
    });

    test("pieces without declared outputs emit no `- output:` line", async () => {
      const llm = new StubLlm(
        JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }),
      );
      // makeRegistry() is the default sampleCatalog which declares no
      // outputs. The catalog section should NOT contain `- output:` lines.
      await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "X", description: "x" });
      const sys = llm.calls[0]?.system ?? "";
      expect(sys.includes("- output:")).toBe(false);
    });
  });
});
