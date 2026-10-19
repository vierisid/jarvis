import { test, expect } from "bun:test";
import { UNSAVED_MESSAGE } from "./controller";
import { makeMemoryDetailFixture } from "./fixtures";
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
test("read-only permissions prevent correction", async () => {
  const f = await setup("read-only");
  f.controller.begin("correct");
  f.controller.begin("confirm");
  await f.controller.save();
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
for (const stage of ["detail", "reload"] as const) {
  test(`unavailable access during ${stage} purges detail and the cached stream`, async () => {
    const f = await setup();
    await f.stream.refresh();
    await f.controller.loadHistory();
    f.controller.begin("correct");
    f.controller.setDraft({
      object: "private draft",
      reason: "private source",
    });
    f.port.read = async () => ({
      state: "unavailable",
      reason: "Memory access ended. Sign in again.",
    });
    if (stage === "detail") await f.controller.open(id);
    else await f.controller.reload();
    const state = f.controller.snapshot();
    expect(state.read.state).toBe("unavailable");
    expect(state.history.state).toBe("idle");
    expect(state.object).toBe("");
    expect(state.reason).toBe("");
    expect(state.panel).toBeNull();
    expect(f.controller.dirty).toBe(true);
    expect(f.stream.snapshot().read.state).toBe("loading");
    expect(f.controller.close()).toBe(true);
    expect(f.stream.snapshot().read.state).toBe("loading");
    expect(f.writes()).toBe(0);
  });
}
for (const action of ["cancel", "rejected-save"] as const) {
  test(`${action} resets canceled history so it can be retried`, async () => {
    const f = await setup("save-error");
    const slow = deferred<HistoryRead>();
    const history = f.port.history;
    f.port.history = () => slow.promise;
    f.controller.begin("correct");
    f.controller.setDraft({ object: "New value", reason: "Checked" });
    const pending = f.controller.loadHistory();
    if (action === "cancel") f.controller.cancelPanel();
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
test("leaving with an unsaved edit is refused with a message until Cancel", async () => {
  const f = await setup();
  f.controller.begin("correct");
  expect(f.controller.canLeave()).toBe(true);
  f.controller.setDraft({ object: "Unsaved value" });
  expect(f.controller.close()).toBe(false);
  expect(f.controller.snapshot().object).toBe("Unsaved value");
  expect(f.controller.snapshot().message).toBe(UNSAVED_MESSAGE);
  f.controller.setDraft({ object: f.facts.get(id)!.fact.object, reason: " " });
  expect(f.controller.canLeave()).toBe(true);
  f.controller.setDraft({ reason: "A reason alone is an edit" });
  expect(f.controller.canLeave()).toBe(false);
  f.controller.cancelPanel();
  expect(f.controller.close()).toBe(true);
  expect(f.writes()).toBe(0);
});
test("an unknown save result does not trap the user on the detail", async () => {
  const f = await setup("lost-save");
  f.controller.begin("correct");
  f.controller.setDraft({ object: "New value", reason: "Checked" });
  await f.controller.save();
  expect(f.controller.snapshot().phase).toBe("unknown");
  expect(f.controller.close()).toBe(true);
});
test("reload after a conflict keeps the unsaved draft on the fresh value", async () => {
  const f = await setup();
  f.controller.begin("correct");
  f.controller.setDraft({ object: "My value", reason: "Checked" });
  f.facts.get(id)!.item.revision = "changed elsewhere";
  await f.controller.save();
  expect(f.controller.snapshot().read.state).toBe("conflict");
  await f.controller.reload();
  const state = f.controller.snapshot();
  expect(state.read.state).toBe("ready");
  expect(state.panel).toBe("correct");
  expect(state.object).toBe("My value");
  expect(state.reason).toBe("Checked");
  expect(f.controller.unsaved()).toBe(true);
  await f.controller.save();
  expect(f.writes()).toBe(2);
  expect(f.controller.snapshot().read.state).toBe("ready");
});
