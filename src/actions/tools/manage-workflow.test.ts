import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../workflows/db/index.ts";
import { queueStats } from "../../workflows/db/repos/job-queue.ts";
import { createManageWorkflowTool } from "./manage-workflow.ts";

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
    const created = (await call("create", { name: "Morning briefing" })) as { id: string; name: string; status: string };
    expect(created.name).toBe("Morning briefing");
    expect(created.status).toBe("DISABLED");

    const list = (await call("list")) as Array<{ id: string }>;
    expect(list.map((f) => f.id)).toContain(created.id);
  });

  test("get accepts display name (case-insensitive) and id", async () => {
    const created = (await call("create", { name: "Test Flow" })) as { id: string };
    const byName = (await call("get", { flow: "test flow" })) as { id: string; latestDraft: { displayName: string } };
    expect(byName.id).toBe(created.id);
    expect(byName.latestDraft.displayName).toBe("Test Flow");
    const byId = (await call("get", { flow: created.id })) as { id: string };
    expect(byId.id).toBe(created.id);
  });

  test("run enqueues a RUN_FLOW job and returns run_id", async () => {
    const created = (await call("create", { name: "runme" })) as { id: string };
    const out = (await call("run", { flow: "runme", payload: { foo: "bar" } })) as { run_id: string; status: string };
    expect(typeof out.run_id).toBe("string");
    expect(out.status).toBe("QUEUED");
    expect(queueStats().queued).toBe(1);
  });

  test("enable / disable round-trip", async () => {
    await call("create", { name: "toggle" });
    let st = (await call("enable", { flow: "toggle" })) as { status: string };
    expect(st.status).toBe("ENABLED");
    st = (await call("disable", { flow: "toggle" })) as { status: string };
    expect(st.status).toBe("DISABLED");
  });

  test("publish locks the latest draft and ENABLES the flow", async () => {
    await call("create", { name: "pubme" });
    const published = (await call("publish", { flow: "pubme" })) as {
      status: string;
      publishedVersionId: string | null;
    };
    expect(published.status).toBe("ENABLED");
    expect(published.publishedVersionId).not.toBeNull();
  });

  test("delete removes the flow", async () => {
    const created = (await call("create", { name: "doomed" })) as { id: string };
    const out = (await call("delete", { flow: "doomed" })) as { id: string; deleted: boolean };
    expect(out).toEqual({ id: created.id, deleted: true });
    await expect(call("get", { flow: "doomed" })).rejects.toThrow(/not found/);
  });

  test("list_runs filters by flow ref + caps to limit", async () => {
    await call("create", { name: "a" });
    await call("create", { name: "b" });
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
    await call("create", { name: "rr" });
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
});
