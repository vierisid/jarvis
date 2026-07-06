import { describe, expect, test } from "bun:test";
import { composeFlow } from "./workflow-composer";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures";
import { PieceCatalog, type PieceCatalogEntry, type PieceLookup } from "../../workflows/runtime/piece-catalog";
import type {
  ComposerChatMessage,
  ComposerChatReply,
  ComposerLibraryEntry,
  ComposerLlmClient,
  ComposerToolCall,
  ComposerToolDef,
  ComposerToolSpec,
} from "./workflow-composer";

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

  test("system prompt spells out the {{trigger.payload.<field>}} access path for on_event triggers", async () => {
    // Guards the headline of the prompt fix: small models were dropping
    // the `.payload.` prefix and writing {{trigger.content}}. The rule
    // bullet that prevents this MUST appear verbatim or the regression
    // surfaces silently in user-facing flows.
    const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
    await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "anything" },
    );
    const sys = llm.calls[0]?.system ?? "";
    expect(sys).toContain("{{trigger.payload.<field>}}");
    expect(sys).toContain("jarvis-trigger:on_event");
    // The wiring example for clipboard text should be present in the
    // rule bullet to anchor the pattern.
    expect(sys).toContain("{{trigger.payload.content}}");
  });

  test("system prompt emits per-eventType output samples when the trigger declares dynamicSampleData", async () => {
    // The future-proof channel: any trigger whose envelope shape depends
    // on a configured input value surfaces a per-value sample block in
    // the catalog. Without this rendering, the LLM only sees the static
    // sampleData and has to mentally splice the envelope with the
    // payload-example catalog -- the exact mistake the prompt fix
    // tries to prevent.
    const onEventCatalog = new PieceCatalog([
      {
        name: "@jarvispieces/piece-jarvis-trigger",
        displayName: "Jarvis: Trigger",
        description: "",
        actions: {},
        triggers: {
          on_event: {
            name: "on_event",
            displayName: "On event",
            description: "Fires on a Jarvis event.",
            sampleData: { id: "s", eventType: "awareness.context_changed", payload: { app: "x" }, timestamp: 0 },
            dynamicSampleData: {
              propName: "eventType",
              samples: {
                "observer.clipboard_changed": {
                  id: "s",
                  eventType: "observer.clipboard_changed",
                  payload: { content: "https://example.com", length: 19 },
                  timestamp: 0,
                },
                "observer.email_received": {
                  id: "s",
                  eventType: "observer.email_received",
                  payload: { from: "a@b", snippet: "..." },
                  timestamp: 0,
                },
              },
            },
          },
        },
      },
    ]);
    const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
    await composeFlow(
      { llm, pieceRegistry: onEventCatalog },
      { name: "X", description: "anything" },
    );
    const sys = llm.calls[0]?.system ?? "";
    expect(sys).toContain("output samples by eventType");
    expect(sys).toContain("observer.clipboard_changed");
    expect(sys).toContain("observer.email_received");
    // The rendered sample is the full envelope, not just the payload --
    // confirms the LLM sees the wrapper it should wire against.
    expect(sys).toContain('"payload":{"content":"https://example.com","length":19}');
  });

  test("flow_ref fields land in the prompt with a 'user picks via editor' hint and pass validation when empty", async () => {
    // The composer can't know the user's flow list, so a `flow_ref`
    // field is special: the LLM must emit an empty string for it,
    // validation must accept that empty value, and the user fills it
    // in via the editor's flow picker after the flow is composed.
    const registry = new PieceCatalog([
      {
        name: "@jarvispieces/piece-jarvis-trigger",
        displayName: "Jarvis: Trigger",
        description: "",
        actions: {
          run_workflow: {
            name: "run_workflow",
            displayName: "Run another workflow",
            description: "",
            inputSchema: {
              fields: [
                { name: "flow", label: "Flow", type: "flow_ref", required: true },
                { name: "payload", label: "Payload", type: "json", required: false },
              ],
            },
            outputSample: { runId: "run_01HX..." },
          },
        },
        triggers: {},
      },
    ]);
    const reply = JSON.stringify({
      displayName: "X",
      trigger: {
        name: "trigger",
        type: "EMPTY",
        nextAction: {
          name: "step_1",
          type: "PIECE",
          settings: {
            pieceName: "@jarvispieces/piece-jarvis-trigger",
            actionName: "run_workflow",
            // The model emits an empty string per the prompt hint.
            // Validation MUST accept this even though the field is
            // declared required -- otherwise the composer retries and
            // the LLM eventually hallucinates a flow id to satisfy
            // validation, which is the failure mode we wanted to
            // prevent.
            input: { flow: "" },
          },
        },
      },
    });
    const llm = new StubLlm(reply);
    const result = await composeFlow(
      { llm, pieceRegistry: registry },
      { name: "X", description: "run the morning briefing workflow" },
    );
    expect(result.ok).toBe(true);
    const sys = llm.calls[0]?.system ?? "";
    // Prompt should tell the LLM what to do with flow_ref.
    expect(sys).toContain("user picks the target workflow via the editor");
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

  describe("jarvis-tool invoke param validation", () => {
    function toolCatalog(): PieceLookup {
      const entries: PieceCatalogEntry[] = [
        {
          name: "@jarvispieces/piece-jarvis-tool",
          displayName: "Jarvis: Tool",
          description: "Invoke a registered Jarvis tool.",
          actions: {
            invoke: {
              name: "invoke",
              displayName: "Invoke",
              description: "Call a tool.",
              inputSchema: {
                fields: [
                  { name: "toolName", label: "Tool", type: "string", required: true },
                  { name: "params", label: "Params", type: "json", required: false },
                ],
              },
            },
          },
        },
      ];
      return new PieceCatalog(entries);
    }

    const tools: ComposerToolSpec[] = [
      {
        name: "content_pipeline",
        description: "Manage the content pipeline.",
        params: [
          { name: "action", type: "string", required: true, description: "list, get, create, ..." },
          { name: "id", type: "string", required: false },
        ],
      },
      { name: "vault_search", description: "Search the vault.", params: [{ name: "query", type: "string", required: false }] },
    ];

    const invokeFlow = (toolName: string, params: Record<string, unknown>) =>
      JSON.stringify({
        displayName: "Tooly",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "jarvis-tool", actionName: "invoke", input: { toolName, params } },
          },
        },
      });

    test("lists each tool's params (required flagged) in the prompt", async () => {
      const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
      await composeFlow({ llm, pieceRegistry: toolCatalog(), tools }, { name: "X", description: "x" });
      const sys = llm.calls[0]?.system ?? "";
      expect(sys).toContain("content_pipeline");
      expect(sys).toMatch(/param action \(string, REQUIRED\)/);
    });

    test("rejects an invoke that omits a required param (the content_pipeline/action bug)", async () => {
      const llm = new StubLlm(invokeFlow("content_pipeline", { query: "tag:project-x" }));
      const result = await composeFlow(
        { llm, pieceRegistry: toolCatalog(), tools, maxAttempts: 1 },
        { name: "Tooly", description: "list project-x content" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /missing required param\(s\): action/.test(e))).toBe(true);
      }
    });

    test("self-corrects when the retry supplies the required param", async () => {
      const llm = new StubLlm([
        invokeFlow("content_pipeline", { query: "x" }),
        invokeFlow("content_pipeline", { action: "list" }),
      ]);
      const result = await composeFlow(
        { llm, pieceRegistry: toolCatalog(), tools, maxAttempts: 4 },
        { name: "Tooly", description: "list content" },
      );
      expect(result.ok).toBe(true);
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[1]?.prompt).toMatch(/missing required param/);
    });

    test("accepts a templated required param value", async () => {
      const llm = new StubLlm(invokeFlow("content_pipeline", { action: "{{trigger.action}}" }));
      const result = await composeFlow(
        { llm, pieceRegistry: toolCatalog(), tools },
        { name: "Tooly", description: "x" },
      );
      expect(result.ok).toBe(true);
    });

    test("rejects an unknown toolName", async () => {
      const llm = new StubLlm(invokeFlow("not_a_tool", { action: "list" }));
      const result = await composeFlow(
        { llm, pieceRegistry: toolCatalog(), tools, maxAttempts: 1 },
        { name: "Tooly", description: "x" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /invokes unknown tool "not_a_tool"/.test(e))).toBe(true);
      }
    });

    test("does not enforce params when only tool names are supplied", async () => {
      // toolNames (no schemas) -> can't validate; back-compat path stays open.
      const llm = new StubLlm(invokeFlow("content_pipeline", { query: "x" }));
      const result = await composeFlow(
        { llm, pieceRegistry: toolCatalog(), toolNames: ["content_pipeline"] },
        { name: "Tooly", description: "x" },
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("internal pieces are excluded from composition", () => {
    function catalogWithTestPiece(): PieceLookup {
      const entries: PieceCatalogEntry[] = [
        {
          name: "jarvis-ask",
          displayName: "Jarvis: Ask",
          description: "Send a prompt to the LLM.",
          actions: { ask: { name: "ask", displayName: "Ask", description: "Ask.", inputSchema: { fields: [{ name: "prompt", label: "Prompt", type: "long_text", required: true }] } } },
        },
        {
          name: "@jarvispieces/piece-jarvis-test",
          displayName: "Jarvis: Test",
          description: "Internal test piece.",
          actions: { echo: { name: "echo", displayName: "Echo", description: "Echo input.", inputSchema: { fields: [{ name: "value", label: "Value", type: "json", required: false }] } } },
        },
      ];
      return new PieceCatalog(entries);
    }

    test("jarvis-test is hidden from the prompt catalog", async () => {
      const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
      await composeFlow({ llm, pieceRegistry: catalogWithTestPiece() }, { name: "X", description: "x" });
      const sys = llm.calls[0]?.system ?? "";
      expect(sys).toContain("jarvis-ask");
      expect(sys).not.toContain("jarvis-test");
    });

    test("rejects a step that uses jarvis-test:echo even if the model names it directly", async () => {
      const reply = JSON.stringify({
        displayName: "X",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "jarvis-test", actionName: "echo", input: { value: "ignored" } },
          },
        },
      });
      const result = await composeFlow(
        { llm: new StubLlm(reply), pieceRegistry: catalogWithTestPiece(), maxAttempts: 1 },
        { name: "X", description: "x" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /internal piece "jarvis-test"/.test(e))).toBe(true);
      }
    });
  });

  describe("router regex condition validation", () => {
    const routerFlow = (operator: string, secondValue: string) =>
      JSON.stringify({
        displayName: "Rx",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "jarvis-ask", actionName: "ask", input: { prompt: "hi" } },
            nextAction: {
              name: "router_1",
              type: "ROUTER",
              settings: {
                executionType: "EXECUTE_FIRST_MATCH",
                branches: [
                  { branchName: "match", branchType: "CONDITION", conditions: [[{ firstValue: "{{step_1.text}}", operator, secondValue }]] },
                  { branchName: "fallback", branchType: "FALLBACK" },
                ],
              },
              children: [
                { name: "b_match", type: "PIECE", settings: { pieceName: "jarvis-notify", actionName: "notify", input: { message: "hit" } } },
                null,
              ],
            },
          },
        },
      });

    test("rejects an inline-flag regex like (?i)... (the engine throws InvalidRegexError on these)", async () => {
      const llm = new StubLlm(routerFlow("TEXT_DOES_NOT_MATCH_REGEX", "(?i)no documents found|^\\s*$"));
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 1 },
        { name: "Rx", description: "branch on text" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /invalid regex/.test(e))).toBe(true);
        expect(result.errors.some((e) => /inline flags like \(\?i\)/.test(e))).toBe(true);
      }
    });

    test("self-corrects to a valid pattern on retry", async () => {
      const llm = new StubLlm([
        routerFlow("TEXT_MATCHES_REGEX", "(?i)urgent"),
        routerFlow("TEXT_MATCHES_REGEX", "[Uu]rgent"),
      ]);
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry(), maxAttempts: 4 },
        { name: "Rx", description: "branch on urgency" },
      );
      expect(result.ok).toBe(true);
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[1]?.prompt).toMatch(/invalid regex/);
    });

    test("accepts a valid JS regex pattern", async () => {
      const llm = new StubLlm(routerFlow("TEXT_MATCHES_REGEX", "[Uu]rgent|important"));
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry() },
        { name: "Rx", description: "branch on urgency" },
      );
      expect(result.ok).toBe(true);
    });

    test("skips a templated regex value (resolved at runtime)", async () => {
      const llm = new StubLlm(routerFlow("TEXT_MATCHES_REGEX", "{{trigger.pattern}}"));
      const result = await composeFlow(
        { llm, pieceRegistry: makeRegistry() },
        { name: "Rx", description: "dynamic pattern" },
      );
      expect(result.ok).toBe(true);
    });

    test("prompt warns that inline regex flags are unsupported", async () => {
      const llm = new StubLlm(JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } }));
      await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "X", description: "x" });
      const sys = llm.calls[0]?.system ?? "";
      expect(sys).toMatch(/does NOT support inline/i);
    });
  });

  describe("control-flow bodies survive validation", () => {
    test("LOOP_ON_ITEMS keeps its firstLoopAction body (and the chain inside it)", async () => {
      const reply = JSON.stringify({
        displayName: "Loopy",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: { pieceName: "jarvis-ask", actionName: "ask", input: { prompt: "list things" } },
            nextAction: {
              name: "loop_1",
              type: "LOOP_ON_ITEMS",
              settings: { items: "{{step_1.text}}" },
              firstLoopAction: {
                name: "body_1",
                type: "PIECE",
                settings: { pieceName: "jarvis-notify", actionName: "notify", input: { message: "{{loop_1.item}}" } },
                nextAction: {
                  name: "body_2",
                  type: "PIECE",
                  settings: { pieceName: "jarvis-ask", actionName: "ask", input: { prompt: "{{loop_1.item}}" } },
                },
              },
            },
          },
        },
      });
      const result = await composeFlow(
        { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
        { name: "Loopy", description: "loop over things" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const loop = result.flow.trigger.nextAction?.nextAction;
        expect(loop?.type).toBe("LOOP_ON_ITEMS");
        // The whole point of the fix: the body is present, not dropped.
        expect(loop?.firstLoopAction?.name).toBe("body_1");
        expect(loop?.firstLoopAction?.nextAction?.name).toBe("body_2");
      }
    });

    test("ROUTER keeps its children subgraphs (one per branch, nulls preserved)", async () => {
      const reply = JSON.stringify({
        displayName: "Routey",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "router_1",
            type: "ROUTER",
            settings: {
              executionType: "EXECUTE_FIRST_MATCH",
              branches: [
                { branchName: "hit", branchType: "CONDITION", conditions: [[{ firstValue: "{{trigger.x}}", operator: "TEXT_CONTAINS", secondValue: "y" }]] },
                { branchName: "fallback", branchType: "FALLBACK" },
              ],
            },
            children: [
              {
                name: "branch_hit",
                type: "PIECE",
                settings: { pieceName: "jarvis-notify", actionName: "notify", input: { message: "matched" } },
              },
              null,
            ],
          },
        },
      });
      const result = await composeFlow(
        { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
        { name: "Routey", description: "branch on x" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const router = result.flow.trigger.nextAction;
        expect(router?.type).toBe("ROUTER");
        expect(router?.children).toHaveLength(2);
        expect(router?.children?.[0]?.name).toBe("branch_hit");
        expect(router?.children?.[1]).toBeNull();
      }
    });

    test("a step after a top-level loop is still reachable", async () => {
      const reply = JSON.stringify({
        displayName: "After",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "loop_1",
            type: "LOOP_ON_ITEMS",
            settings: { items: "{{trigger.list}}" },
            firstLoopAction: {
              name: "body_1",
              type: "PIECE",
              settings: { pieceName: "jarvis-notify", actionName: "notify", input: { message: "{{loop_1.item}}" } },
            },
            nextAction: {
              name: "after_1",
              type: "PIECE",
              settings: { pieceName: "jarvis-ask", actionName: "ask", input: { prompt: "done" } },
            },
          },
        },
      });
      const result = await composeFlow(
        { llm: new StubLlm(reply), pieceRegistry: makeRegistry() },
        { name: "After", description: "loop then a final step" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const loop = result.flow.trigger.nextAction;
        expect(loop?.firstLoopAction?.name).toBe("body_1");
        expect(loop?.nextAction?.name).toBe("after_1");
      }
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

describe("tool-loop composer", () => {
  type ToolReply = {
    content?: string;
    tool_calls?: ComposerToolCall[];
    finish_reason?: ComposerChatReply["finish_reason"];
  };

  /**
   * Stub with a tool-capable entrypoint. `replies` are consumed per turn
   * (extra turns reuse the last entry); "throw" makes every chatTools call
   * fail, modeling a provider that rejects the tools parameter. The plain
   * `chat` path returns `oneShotReply` so tests can assert fallback.
   */
  class StubToolLlm implements ComposerLlmClient {
    public toolTurns: Array<{ messages: ComposerChatMessage[]; tools: ComposerToolDef[] }> = [];
    public chatCalls: Array<{ prompt: string; system?: string }> = [];
    constructor(
      private readonly replies: ToolReply[] | "throw",
      private readonly oneShotReply = "",
    ) {}
    async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
      this.chatCalls.push(input);
      return { text: this.oneShotReply };
    }
    async chatTools(
      messages: ComposerChatMessage[],
      tools: ComposerToolDef[],
    ): Promise<ComposerChatReply> {
      this.toolTurns.push({ messages: [...messages], tools });
      if (this.replies === "throw") throw new Error("tools not supported");
      const idx = Math.min(this.toolTurns.length - 1, this.replies.length - 1);
      const r = this.replies[idx]!;
      return { content: r.content ?? "", tool_calls: r.tool_calls ?? [], finish_reason: r.finish_reason };
    }
  }

  const tc = (id: string, name: string, args: Record<string, unknown> = {}): ComposerToolCall => ({
    id,
    name,
    arguments: args,
  });

  const validFlowArgs = () => ({
    displayName: "Notify me",
    trigger: {
      name: "trigger",
      type: "EMPTY",
      nextAction: {
        name: "step_1",
        type: "PIECE",
        settings: { pieceName: "jarvis-notify", actionName: "notify", input: { message: "hi" } },
      },
    },
  });

  const ghostFlowArgs = () => ({
    displayName: "Ghost",
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

  const library: ComposerLibraryEntry[] = [
    {
      id: "discord",
      npmPackage: "@activepieces/piece-discord",
      displayName: "Discord",
      description: "Send messages and manage channels on Discord.",
    },
    {
      id: "google-sheets",
      npmPackage: "@activepieces/piece-google-sheets",
      displayName: "Google Sheets",
      description: "Read and write spreadsheet rows.",
    },
  ];

  test("explores with tools then submits a valid flow", async () => {
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "list_pieces")] },
      { tool_calls: [tc("2", "get_piece_details", { pieceName: "jarvis-notify" })] },
      { tool_calls: [tc("3", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "Notify me", description: "notify me with hi" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.displayName).toBe("Notify me");
      expect(result.flow.trigger.nextAction?.name).toBe("step_1");
    }
    // No fallback to the one-shot path.
    expect(llm.chatCalls).toHaveLength(0);
    // Turn 2 saw the list_pieces result: a compact index, not full schemas.
    const listResult = llm.toolTurns[1]!.messages.at(-1)!;
    expect(listResult.role).toBe("tool");
    expect(listResult.tool_call_id).toBe("1");
    expect(listResult.content).toContain("Installed pieces");
    expect(listResult.content).toContain("jarvis-notify");
    expect(listResult.content).toContain("schedule");
    expect(listResult.content.includes("input.message")).toBe(false);
    // Turn 3 saw the piece details, including the input schema.
    const detailsResult = llm.toolTurns[2]!.messages.at(-1)!;
    expect(detailsResult.content).toContain("input.message");
  });

  test("feeds validation errors back as the submit_flow tool result", async () => {
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "submit_flow", ghostFlowArgs())] },
      { tool_calls: [tc("2", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    const feedback = llm.toolTurns[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("tool");
    expect(feedback.content).toMatch(/unknown piece "ghost"/);
    expect(feedback.content).toMatch(/call submit_flow again/);
  });

  test("maxAttempts caps submit_flow attempts", async () => {
    const llm = new StubToolLlm([{ tool_calls: [tc("1", "submit_flow", ghostFlowArgs())] }]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), maxAttempts: 2 },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /unknown piece "ghost"/.test(e))).toBe(true);
    }
    expect(llm.toolTurns).toHaveLength(2);
    // The exhausted loop must NOT fall back to one-shot (the model engaged
    // with tools; the flow itself is what's wrong).
    expect(llm.chatCalls).toHaveLength(0);
  });

  test("search_library + report_blocked yield suggestedInstalls", async () => {
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "search_library", { query: "discord" })] },
      {
        tool_calls: [
          tc("2", "report_blocked", {
            reason: "No installed piece can post to Discord.",
            suggestedPieces: [{ id: "discord", reason: "Posts messages to Discord channels." }],
          }),
        ],
      },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), library },
      { name: "Discord post", description: "post to my discord channel" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/Discord/);
      expect(result.suggestedInstalls).toEqual([
        { id: "discord", displayName: "Discord", reason: "Posts messages to Discord channels." },
      ]);
    }
    const searchResult = llm.toolTurns[1]!.messages.at(-1)!;
    expect(searchResult.content).toContain("discord (Discord)");
    expect(searchResult.content).toContain("[not installed]");
    expect(searchResult.content.includes("google-sheets")).toBe(false);
  });

  test("report_blocked drops suggestedPieces ids that aren't in the library catalog", async () => {
    // A model can hallucinate a slug; since the primary agent relays
    // suggestedInstalls to the user as installable, an id with no catalog
    // entry must be filtered out. Here a real id (discord) is kept and a
    // made-up one is dropped.
    const llm = new StubToolLlm([
      {
        tool_calls: [
          tc("1", "report_blocked", {
            reason: "No installed piece can post to Discord or Notion.",
            suggestedPieces: [
              { id: "discord", reason: "Posts messages to Discord channels." },
              { id: "not-a-real-piece", reason: "Hallucinated slug." },
            ],
          }),
        ],
      },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), library },
      { name: "Blocked", description: "post to discord and notion" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestedInstalls).toEqual([
        { id: "discord", displayName: "Discord", reason: "Posts messages to Discord channels." },
      ]);
    }
  });

  test("report_blocked with only hallucinated ids yields no suggestedInstalls", async () => {
    const llm = new StubToolLlm([
      {
        tool_calls: [
          tc("1", "report_blocked", {
            reason: "Nothing installed fits.",
            suggestedPieces: [{ id: "totally-made-up", reason: "not in the catalog" }],
          }),
        ],
      },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), library },
      { name: "Blocked", description: "do the impossible" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestedInstalls).toBeUndefined();
    }
  });

  test("search_library is only offered when a library is wired", async () => {
    const llm = new StubToolLlm([{ tool_calls: [tc("1", "submit_flow", validFlowArgs())] }]);
    await composeFlow({ llm, pieceRegistry: makeRegistry() }, { name: "X", description: "x" });
    const toolNames = llm.toolTurns[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("list_pieces");
    expect(toolNames).toContain("submit_flow");
    expect(toolNames).toContain("report_blocked");
    expect(toolNames.includes("search_library")).toBe(false);
    expect(toolNames.includes("get_tool_details")).toBe(false);
  });

  test("get_tool_details returns the tool's param contract", async () => {
    const tools: ComposerToolSpec[] = [
      {
        name: "gmail_send",
        description: "Send an email via Gmail.",
        params: [
          { name: "to", type: "string", required: true },
          { name: "subject", type: "string", required: false },
        ],
      },
    ];
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "get_tool_details", { toolName: "gmail_send" })] },
      { tool_calls: [tc("2", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry(), tools },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    const details = llm.toolTurns[1]!.messages.at(-1)!;
    expect(details.content).toContain("gmail_send");
    expect(details.content).toContain("param to (string, REQUIRED)");
  });

  test("unknown get_piece_details name returns a corrective error result", async () => {
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "get_piece_details", { pieceName: "ghost" })] },
      { tool_calls: [tc("2", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    const errResult = llm.toolTurns[1]!.messages.at(-1)!;
    expect(errResult.content).toMatch(/unknown piece "ghost"/);
    expect(errResult.content).toMatch(/list_pieces/);
  });

  test("accepts an inline JSON flow answered without a tool call", async () => {
    const llm = new StubToolLlm([{ content: JSON.stringify(validFlowArgs()) }]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    expect(llm.chatCalls).toHaveLength(0);
  });

  test("falls back to one-shot when the model answers prose on turn 1", async () => {
    const oneShot = JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } });
    const llm = new StubToolLlm([{ content: "Sure! I'd build a flow like this: ..." }], oneShot);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    expect(llm.toolTurns).toHaveLength(1);
    expect(llm.chatCalls).toHaveLength(1);
  });

  test("falls back to one-shot when chatTools throws on the first call", async () => {
    const oneShot = JSON.stringify({ displayName: "X", trigger: { name: "trigger", type: "EMPTY" } });
    const llm = new StubToolLlm("throw", oneShot);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    expect(llm.chatCalls).toHaveLength(1);
  });

  test("gives up after the turn budget when the model never submits", async () => {
    const llm = new StubToolLlm([{ tool_calls: [tc("1", "list_pieces")] }]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/tool-call budget/);
    }
    expect(llm.toolTurns).toHaveLength(12);
    expect(llm.chatCalls).toHaveLength(0);
  });

  test("feeds concrete validation errors back when an inline JSON flow fails (turn >= 2)", async () => {
    // Past turn 1 the model can't fall back to one-shot, so an inline JSON
    // flow that fails validation must feed the specific errors back (like
    // submit_flow does) instead of a generic prose nudge.
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "list_pieces")] },
      { content: JSON.stringify(ghostFlowArgs()) },
      { tool_calls: [tc("3", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    // The feedback pushed after the bad inline JSON (seen on the next turn)
    // names the concrete error and steers back to submit_flow.
    const feedback = llm.toolTurns[2]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toMatch(/inline JSON failed validation/);
    expect(feedback.content).toMatch(/unknown piece "ghost"/);
    expect(feedback.content).toMatch(/submit_flow/);
  });

  test("resets the consecutive-prose nudge counter when a reply calls a tool", async () => {
    // TOOL_LOOP_MAX_NUDGES counts CONSECUTIVE prose replies. Interleaving a
    // tool call resets the count, so a total of 3 prose replies split by a
    // tool call must NOT trip the (cumulative) budget before submit_flow.
    const llm = new StubToolLlm([
      { tool_calls: [tc("1", "list_pieces")] },
      { content: "thinking out loud 1" },
      { tool_calls: [tc("3", "list_pieces")] }, // resets the nudge counter
      { content: "thinking out loud 2" },
      { content: "thinking out loud 3" },
      { tool_calls: [tc("6", "submit_flow", validFlowArgs())] },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(true);
    expect(llm.toolTurns).toHaveLength(6);
  });

  test("fails with a truncation error when a reply is cut at the token cap", async () => {
    // finish_reason 'length' means the provider stopped mid-reply (often a
    // submit_flow whose JSON got dropped to no tool call). Fail with a clear
    // message rather than misreading it as prose or falling back.
    const llm = new StubToolLlm([
      { content: '{"displayName":"X","trigger":{"name":"trigger","type', finish_reason: "length" },
    ]);
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/truncated/);
    }
    // No fallback to one-shot -- truncation isn't a "no tool support" signal.
    expect(llm.chatCalls).toHaveLength(0);
  });

  test("turn-1 transient/auth errors fail fast instead of falling back to one-shot", async () => {
    // A 429 on the first tool call isn't a rejected-tools-param signal;
    // dropping tools won't help and would hide the real cause. Surface it.
    let oneShotCalls = 0;
    const llm: ComposerLlmClient = {
      async chat() {
        oneShotCalls++;
        return { text: "{}" };
      },
      async chatTools() {
        throw new Error("429 Too Many Requests: rate limit exceeded");
      },
    };
    const result = await composeFlow(
      { llm, pieceRegistry: makeRegistry() },
      { name: "X", description: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/LLM call failed/);
    }
    // Did NOT silently fall back to the one-shot path.
    expect(oneShotCalls).toBe(0);
  });

  test("tool-loop system prompt teaches the process and lists roles inline", async () => {
    const llm = new StubToolLlm([{ tool_calls: [tc("1", "submit_flow", validFlowArgs())] }]);
    await composeFlow(
      {
        llm,
        pieceRegistry: makeRegistry(),
        library,
        specialistRoles: [{ id: "research-analyst", name: "Research Analyst" }],
      },
      { name: "X", description: "x" },
    );
    const sys = llm.toolTurns[0]!.messages[0]!;
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("## Process");
    expect(sys.content).toContain("list_pieces");
    expect(sys.content).toContain("submit_flow");
    expect(sys.content).toContain("search_library");
    expect(sys.content).toContain("## Examples");
    expect(sys.content).toContain("{{trigger.payload.<field>}}");
    expect(sys.content).toContain("research-analyst");
    expect(sys.content).toMatch(/MUST be one of the specialist role ids/);
    // The catalog is NOT dumped inline -- that's what the tools are for.
    expect(sys.content.includes("input.message")).toBe(false);
  });
});
