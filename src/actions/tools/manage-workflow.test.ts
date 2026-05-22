import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../workflows/db/index.ts";
import { queueStats } from "../../workflows/db/repos/job-queue.ts";
import { createManageWorkflowTool } from "./manage-workflow.ts";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures.ts";
import type { ComposerLlmClient } from "./workflow-composer.ts";

class StubLlm implements ComposerLlmClient {
  public calls: Array<{ prompt: string; system?: string }> = [];
  constructor(private reply: string) {}
  setReply(s: string) { this.reply = s; }
  async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
    this.calls.push(input);
    return { text: this.reply };
  }
}

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

const tool = createManageWorkflowTool();

async function call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const result = await tool.execute({ action, ...params });
  return JSON.parse(result as string);
}

describe("manage_workflow tool", () => {
  test("create then list returns the new flow", async () => {
    const created = (await call("create", { name: "Morning briefing", empty: true })) as { id: string; name: string; status: string };
    expect(created.name).toBe("Morning briefing");
    expect(created.status).toBe("DISABLED");

    const list = (await call("list")) as Array<{ id: string }>;
    expect(list.map((f) => f.id)).toContain(created.id);
  });

  test("get accepts display name (case-insensitive) and id", async () => {
    const created = (await call("create", { name: "Test Flow", empty: true })) as { id: string };
    const byName = (await call("get", { flow: "test flow" })) as { id: string; latestDraft: { displayName: string } };
    expect(byName.id).toBe(created.id);
    expect(byName.latestDraft.displayName).toBe("Test Flow");
    const byId = (await call("get", { flow: created.id })) as { id: string };
    expect(byId.id).toBe(created.id);
  });

  test("run enqueues a RUN_FLOW job and returns run_id", async () => {
    const created = (await call("create", { name: "runme", empty: true })) as { id: string };
    const out = (await call("run", { flow: "runme", payload: { foo: "bar" } })) as { run_id: string; status: string };
    expect(typeof out.run_id).toBe("string");
    expect(out.status).toBe("QUEUED");
    expect(queueStats().queued).toBe(1);
  });

  test("enable / disable round-trip", async () => {
    await call("create", { name: "toggle", empty: true });
    let st = (await call("enable", { flow: "toggle" })) as { status: string };
    expect(st.status).toBe("ENABLED");
    st = (await call("disable", { flow: "toggle" })) as { status: string };
    expect(st.status).toBe("DISABLED");
  });

  test("publish locks the latest draft and ENABLES the flow", async () => {
    await call("create", { name: "pubme", empty: true });
    const published = (await call("publish", { flow: "pubme" })) as {
      status: string;
      publishedVersionId: string | null;
    };
    expect(published.status).toBe("ENABLED");
    expect(published.publishedVersionId).not.toBeNull();
  });

  test("delete removes the flow", async () => {
    const created = (await call("create", { name: "doomed", empty: true })) as { id: string };
    const out = (await call("delete", { flow: "doomed" })) as { id: string; deleted: boolean };
    expect(out).toEqual({ id: created.id, deleted: true });
    await expect(call("get", { flow: "doomed" })).rejects.toThrow(/not found/);
  });

  test("list_runs filters by flow ref + caps to limit", async () => {
    await call("create", { name: "a", empty: true });
    await call("create", { name: "b", empty: true });
    await call("run", { flow: "a" });
    await call("run", { flow: "a" });
    await call("run", { flow: "b" });
    const aRuns = (await call("list_runs", { flow: "a" })) as Array<{ flow_id: string }>;
    expect(aRuns).toHaveLength(2);
    const all = (await call("list_runs")) as unknown[];
    expect(all).toHaveLength(3);
    const capped = (await call("list_runs", { limit: 1 })) as unknown[];
    expect(capped).toHaveLength(1);
  });

  test("get_run returns step output", async () => {
    await call("create", { name: "rr", empty: true });
    const queued = (await call("run", { flow: "rr" })) as { run_id: string };
    const detail = (await call("get_run", { run_id: queued.run_id })) as { id: string; status: string };
    expect(detail.id).toBe(queued.run_id);
    expect(detail.status).toBe("QUEUED");
  });

  test("flow ref required for actions that need one", async () => {
    await expect(call("get", {})).rejects.toThrow(/'flow' parameter/);
    await expect(call("run", {})).rejects.toThrow(/'flow' parameter/);
    await expect(call("delete", {})).rejects.toThrow(/'flow' parameter/);
  });

  test("unknown flow throws clearly", async () => {
    await expect(call("get", { flow: "ghost" })).rejects.toThrow(/not found/);
  });

  test("unknown action throws", async () => {
    await expect(call("nope")).rejects.toThrow(/unknown action "nope"/);
  });

  test("create without `empty: true` or a description refuses with a hint", async () => {
    // The gate: weak LLMs frequently pick `create` because the user's
    // verb says "create", even when they described what the flow should
    // DO. Without an explicit `empty: true`, we error out and point the
    // agent at `compose`.
    await expect(call("create", { name: "should fail" })).rejects.toThrow(
      /refusing to make an empty workflow without confirmation/,
    );
  });

  test("create with a description reroutes to compose", async () => {
    // Stub LLM produces a one-step flow so we can verify the routing
    // result was used rather than the empty-flow path.
    const llm = new StubLlm(
      JSON.stringify({
        displayName: "Routed",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: {
              pieceName: "jarvis-ask",
              actionName: "ask",
              input: { prompt: "hi" },
            },
          },
        },
      }),
    );
    const t = createManageWorkflowTool({ llm, pieceRegistry: sampleCatalog() });
    const out = JSON.parse(
      (await t.execute({
        action: "create",
        name: "Routed",
        description: "ask the LLM about my inbox",
      })) as string,
    ) as { ok: boolean; routedFrom: string };
    expect(out.ok).toBe(true);
    expect(out.routedFrom).toBe("create");
  });
});

describe("manage_workflow: compose", () => {
  const makeReg = () => sampleCatalog();

  test("compose creates a flow when the LLM returns a valid JSON tree", async () => {
    const llm = new StubLlm(
      JSON.stringify({
        displayName: "Inbox summary",
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: {
              pieceName: "jarvis-ask",
              actionName: "ask",
              input: { prompt: "hi" },
            },
          },
        },
      }),
    );
    const t = createManageWorkflowTool({ llm, pieceRegistry: makeReg() });
    const out = JSON.parse(
      (await t.execute({
        action: "compose",
        name: "Inbox summary",
        description: "summarize my inbox manually",
      })) as string,
    ) as { ok: boolean; flow: { id: string; name: string }; versionId: string };
    expect(out.ok).toBe(true);
    expect(out.flow.name).toBe("Inbox summary");
    expect(typeof out.versionId).toBe("string");
  });

  test("compose returns errors + raw response on validation failure", async () => {
    const llm = new StubLlm(
      JSON.stringify({
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
      }),
    );
    const t = createManageWorkflowTool({ llm, pieceRegistry: makeReg() });
    const out = JSON.parse(
      (await t.execute({ action: "compose", name: "X", description: "anything" })) as string,
    ) as { ok: boolean; errors: string[]; rawResponse: string };
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => /unknown piece "ghost"/.test(e))).toBe(true);
    expect(typeof out.rawResponse).toBe("string");
  });

  test("compose without llm dep throws a clear error", async () => {
    const t = createManageWorkflowTool({ pieceRegistry: makeReg() });
    await expect(
      t.execute({ action: "compose", name: "X", description: "x" }),
    ).rejects.toThrow(/LLM client is not configured/);
  });

  test("compose without piece registry throws a clear error", async () => {
    const llm = new StubLlm("{}");
    const t = createManageWorkflowTool({ llm });
    await expect(
      t.execute({ action: "compose", name: "X", description: "x" }),
    ).rejects.toThrow(/piece registry is not configured/);
  });

  test("compose rejects a name that collides with an existing flow", async () => {
    const llm = new StubLlm(
      JSON.stringify({
        displayName: "Inbox",
        trigger: { name: "trigger", type: "EMPTY" },
      }),
    );
    const t = createManageWorkflowTool({ llm, pieceRegistry: makeReg() });
    // First compose succeeds.
    const ok = JSON.parse((await t.execute({ action: "compose", name: "Inbox", description: "x" })) as string);
    expect(ok.ok).toBe(true);
    // Second with same name fails.
    const dup = JSON.parse(
      (await t.execute({ action: "compose", name: "Inbox", description: "y" })) as string,
    ) as { ok: boolean; errors: string[] };
    expect(dup.ok).toBe(false);
    expect(dup.errors.some((e: string) => /already exists/.test(e))).toBe(true);
  });

  test("compose caps oversized rawResponse with a truncation marker", async () => {
    const huge = "x".repeat(8000);
    const llm = new StubLlm(huge); // not JSON; will fail JSON parse
    const t = createManageWorkflowTool({ llm, pieceRegistry: makeReg() });
    const out = JSON.parse(
      (await t.execute({ action: "compose", name: "trunc", description: "x" })) as string,
    ) as { ok: boolean; rawResponse: string };
    expect(out.ok).toBe(false);
    expect(out.rawResponse.length).toBeLessThan(huge.length);
    expect(out.rawResponse).toContain("truncated");
  });
});
