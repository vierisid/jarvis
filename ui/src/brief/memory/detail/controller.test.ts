import { test, expect } from "bun:test";
import { MemoryDetailController } from "./controller";
import { makeMemoryDetailFixture } from "./fixtures";
import { memoryDetailHttpPort } from "./http";
import type { DetailRead, HistoryRead } from "./model";
const id = "fixture-memory-0";
async function setup(
  example: Parameters<typeof makeMemoryDetailFixture>[0] = "ready",
  delay = 0,
) {
  const fixture = makeMemoryDetailFixture(example, delay);
  fixture.stream.setAccess(true);
  fixture.controller.setAccess(true);
  await fixture.controller.open(id);
  return fixture;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("late detail and history cannot replace another canonical selection", async () => {
  const f = await setup();
  const slow = deferred<DetailRead>(),
    history = deferred<HistoryRead>();
  const first = structuredClone(f.facts.get(id)!);
  const originalRead = f.port.read;
  f.port.read = (key, signal) =>
    key === id ? slow.promise : originalRead(key, signal);
  f.port.history = () => history.promise;
  const pendingHistory = f.controller.loadHistory();
  const pendingRead = f.controller.open(id);
  await f.controller.open("fixture-memory-1");
  slow.resolve({ state: "ready", data: first });
  history.resolve({ state: "ready", items: [first.item] });
  await Promise.all([pendingRead, pendingHistory]);
  expect(f.controller.snapshot().factId).toBe("fixture-memory-1");
  expect(f.controller.snapshot().history.state).toBe("idle");
});
test("a malformed or mismatched canonical read is never rendered", async () => {
  const f = await setup();
  f.port.read = async () => ({
    state: "ready",
    data: f.facts.get("fixture-memory-1")!,
  });
  await f.controller.open(id);
  expect(f.controller.snapshot().read.state).toBe("error");
});
test("access loss clears drafts, provenance and pending late reads", async () => {
  const f = await setup();
  f.controller.begin("correct");
  f.controller.setDraft({ object: "private draft", reason: "private source" });
  f.controller.origin = { factId: id, ids: [id], offset: 0, scrollTop: 0 };
  const slow = deferred<DetailRead>();
  f.port.read = () => slow.promise;
  const pending = f.controller.open(id);
  f.controller.setAccess(false);
  slow.resolve({ state: "ready", data: f.facts.get(id)! });
  await pending;
  expect(f.controller.snapshot().read.state).toBe("unavailable");
  expect(f.controller.snapshot().object).toBe("");
  expect(f.controller.origin).toBeNull();
  await f.controller.open(id);
  expect(f.controller.snapshot().factId).toBeNull();
});
test("read-only permissions prevent correction and Forget", async () => {
  const f = await setup("read-only");
  f.controller.begin("correct");
  await f.controller.beginForget();
  await f.controller.save();
  await f.controller.confirmForget();
  expect(f.controller.snapshot().panel).toBeNull();
  expect(f.writes()).toBe(0);
});
test("history access loss clears visible content, drafts and cached stream rows", async () => {
  const f = await setup();
  f.controller.begin("correct");
  f.controller.setDraft({ object: "private draft", reason: "private source" });
  f.port.history = async () => ({
    state: "unavailable",
    reason: "Memory access ended.",
  });
  await f.controller.loadHistory();
  expect(f.controller.snapshot().read.state).toBe("unavailable");
  expect(f.controller.snapshot().object).toBe("");
  expect(f.controller.snapshot().reason).toBe("");
  expect(f.controller.snapshot().panel).toBeNull();
  expect(f.controller.dirty).toBe(true);
  expect(f.stream.snapshot().read.state).toBe("loading");
});
for (const status of [401, 403, 503]) {
  for (const stage of ["detail", "prepare", "recheck"] as const) {
    test(`${status} during ${stage} purges detail and the cached stream`, async () => {
      const f = await setup();
      await f.stream.refresh();
      await f.controller.loadHistory();
      f.controller.begin("correct");
      f.controller.setDraft({
        object: "private draft",
        reason: "private source",
      });
      const denied = memoryDetailHttpPort(
        "scope",
        Object.assign(async () => Response.json({}, { status }), {
          preconnect: fetch.preconnect,
        }),
      );
      if (stage === "prepare") f.port.prepareForget = denied.prepareForget;
      else f.port.read = denied.read;
      if (stage === "detail") await f.controller.open(id);
      else await f.controller.beginForget();
      const state = f.controller.snapshot();
      expect(state.read.state).toBe("unavailable");
      expect(state.history.state).toBe("idle");
      expect(state.object).toBe("");
      expect(state.reason).toBe("");
      expect(state.panel).toBeNull();
      expect(state.prepared).toBeNull();
      expect(f.controller.dirty).toBe(true);
      expect(f.stream.snapshot().read.state).toBe("loading");
      f.controller.close();
      expect(f.stream.snapshot().read.state).toBe("loading");
      expect(f.writes()).toBe(0);
    });
  }
}
for (const action of ["cancel", "forget", "rejected-save"] as const) {
  test(`${action} resets canceled history so it can be retried`, async () => {
    const f = await setup("save-error");
    const slow = deferred<HistoryRead>();
    const history = f.port.history;
    f.port.history = () => slow.promise;
    f.controller.begin("correct");
    f.controller.setDraft({ object: "New value", reason: "Checked" });
    const pending = f.controller.loadHistory();
    if (action === "cancel") f.controller.cancelPanel();
    else if (action === "forget") await f.controller.beginForget();
    else await f.controller.save();
    expect(f.controller.snapshot().history.state).toBe("idle");
    slow.resolve({ state: "ready", items: [f.facts.get(id)!.item] });
    await pending;
    expect(f.controller.snapshot().history.state).toBe("idle");
    f.port.history = history;
    await f.controller.loadHistory();
    expect(f.controller.snapshot().history.state).toBe("ready");
    f.controller.cancelPanel();
    expect(f.controller.snapshot().history.state).toBe("ready");
  });
}
test("cancel preserves fact, evidence and filters without a write", async () => {
  const f = await setup();
  const before = structuredClone(f.facts.get(id));
  f.stream.setFilters({ search: "emails", source: "Conversation" }, 0);
  f.controller.begin("correct");
  f.controller.setDraft({ object: "changed", reason: "source" });
  f.controller.cancelPanel();
  expect(f.facts.get(id)).toEqual(before);
  expect(f.writes()).toBe(0);
  expect(f.stream.snapshot().filters.search).toBe("emails");
});
test("correction follows replacement ID, retains earlier evidence, and invalidates stream text", async () => {
  const f = await setup();
  f.controller.begin("correct");
  f.controller.setDraft({
    object: "Use short email paragraphs.",
    reason: "Checked with the owner",
  });
  await f.controller.save();
  const next = f.controller.snapshot();
  expect(next.read.state).toBe("ready");
  expect(next.factId).not.toBe(id);
  expect(f.controller.returnId).toBe(next.factId);
  expect(f.facts.get(id)!.fact.evidence[0]!.quote).toBe(
    "An illustrative owner preference.",
  );
  expect(f.facts.get(id)!.fact.status).toBe("superseded");
  expect(f.stream.snapshot().read.state).toBe("loading");
  expect(f.controller.dirty).toBe(true);
  expect(f.facts.get(next.factId!)!.fact.evidence[0]!.source_ref).toBe(
    `fact:${id}`,
  );
});
test("explicit confirmation keeps identity and old evidence", async () => {
  const f = await setup();
  f.controller.begin("confirm");
  f.controller.setDraft({ reason: "The owner confirmed this" });
  await f.controller.save();
  expect(f.controller.snapshot().factId).toBe(id);
  expect(f.facts.get(id)!.fact.evidence).toHaveLength(2);
  expect(f.facts.get(id)!.fact.basis).toBe("confirmed");
});
test("validation and repeated submit do not duplicate writes", async () => {
  const f = await setup("ready", 5);
  f.controller.begin("correct");
  await f.controller.save();
  expect(f.writes()).toBe(0);
  f.controller.setDraft({ object: "New value", reason: "Checked" });
  const first = f.controller.save();
  await f.controller.save();
  expect(f.controller.close()).toBe(false);
  await first;
  expect(f.writes()).toBe(1);
});
test("conflict preserves draft but requires reload before resubmission", async () => {
  const f = await setup("conflict");
  f.controller.begin("correct");
  f.controller.setDraft({ object: "New value", reason: "Checked" });
  await f.controller.save();
  expect(f.controller.snapshot().read.state).toBe("conflict");
  expect(f.controller.snapshot().object).toBe("New value");
  await f.controller.save();
  expect(f.writes()).toBe(1);
});
test("a definite rejection keeps the editable draft", async () => {
  const f = await setup("save-error");
  f.controller.begin("correct");
  f.controller.setDraft({ object: "New value", reason: "Checked" });
  await f.controller.save();
  expect(f.controller.snapshot().read.state).toBe("ready");
  expect(f.controller.snapshot().phase).toBe("idle");
  expect(f.controller.snapshot().object).toBe("New value");
});
test("lost correction response is unknown, never retried automatically, and reload reveals supersession", async () => {
  const f = await setup("lost-save");
  f.controller.begin("correct");
  f.controller.setDraft({ object: "New value", reason: "Checked" });
  await f.controller.save();
  expect(f.controller.snapshot().phase).toBe("unknown");
  expect(f.controller.snapshot().read.state).toBe("unavailable");
  await f.controller.save();
  expect(f.writes()).toBe(1);
  await f.controller.reload();
  const read = f.controller.snapshot().read;
  expect(read.state).toBe("ready");
  if (read.state === "ready") expect(read.data.item.supersededBy).toBeTruthy();
});
test("Forget preparation and cancel send no mutation", async () => {
  const f = await setup();
  await f.controller.beginForget();
  expect(f.controller.snapshot().prepared?.revision).toHaveLength(64);
  expect(f.controller.snapshot().prepared?.revision).not.toBe(
    f.facts.get(id)!.item.revision,
  );
  f.controller.cancelPanel();
  await f.controller.confirmForget();
  expect(f.writes()).toBe(0);
  expect(f.facts.has(id)).toBe(true);
});
test("a changed fact between display and Forget preparation requires a new review", async () => {
  const f = await setup();
  f.facts.get(id)!.item.revision = "changed";
  await f.controller.beginForget();
  expect(f.controller.snapshot().read.state).toBe("conflict");
  expect(f.controller.snapshot().prepared).toBeNull();
  await f.controller.confirmForget();
  expect(f.writes()).toBe(0);
});
test("an unknown future Forget scope fails closed", async () => {
  const f = await setup();
  const prepare = f.port.prepareForget;
  f.port.prepareForget = async (key, signal) => {
    const result = await prepare(key, signal);
    if (result.state === "ready") result.scope.retained = [];
    return result;
  };
  await f.controller.beginForget();
  expect(f.controller.snapshot().prepared).toBeNull();
  await f.controller.confirmForget();
  expect(f.writes()).toBe(0);
});
test("confirmed Forget purges detail/history/draft and keeps one receipt under repeated click", async () => {
  const f = await setup("ready", 3);
  await f.controller.loadHistory();
  await f.controller.beginForget();
  const first = f.controller.confirmForget();
  await f.controller.confirmForget();
  await first;
  expect(f.writes()).toBe(1);
  expect(f.facts.has(id)).toBe(false);
  expect(f.receipts.size).toBe(1);
  expect(f.controller.snapshot().read.state).toBe("forgotten");
  expect(f.controller.snapshot().history.state).toBe("idle");
  expect(f.controller.snapshot().prepared).toBeNull();
});
test("unknown Forget clears text and recovers only through a read receipt", async () => {
  const f = await setup("lost-forget");
  await f.controller.beginForget();
  await f.controller.confirmForget();
  expect(f.controller.snapshot().phase).toBe("unknown");
  expect(JSON.stringify(f.controller.snapshot())).not.toContain(
    "Keep emails short",
  );
  await f.controller.confirmForget();
  expect(f.writes()).toBe(1);
  await f.controller.checkForget();
  expect(f.controller.snapshot().read.state).toBe("forgotten");
  expect(f.writes()).toBe(1);
});
test("retiring during a mutation prevents a late success from restoring content", async () => {
  const f = await setup("ready", 5);
  f.controller.begin("correct");
  f.controller.setDraft({ object: "New", reason: "Checked" });
  const work = f.controller.save();
  f.controller.retire();
  await work;
  expect(f.controller.snapshot().read.state).toBe("unavailable");
  expect(f.controller.snapshot().factId).toBeNull();
});
test("missing detail removes potentially stale stream content", async () => {
  const f = await setup();
  await f.controller.open("missing-id");
  expect(f.controller.snapshot().read.state).toBe("missing");
  expect(f.controller.dirty).toBe(true);
});
