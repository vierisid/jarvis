import { expect, test } from "bun:test";
import { WorkflowManagementController } from "./controller";
import { makeManagementFixture, MANAGEMENT_SCOPE } from "./fixtures";
import {
  validateList,
  validateResult,
  type WorkflowManagementPort,
  type ManageResult,
  type ManageCommand,
  type WorkflowList,
} from "./model";
import type { BriefReadState } from "../../contracts";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
async function ready(
  example: Parameters<typeof makeManagementFixture>[0] = "normal",
) {
  const f = makeManagementFixture(example);
  f.controller.setAccess(true);
  await f.controller.load();
  return f;
}
const visible = (c: WorkflowManagementController) =>
  c
    .getSnapshot()
    .rows.filter((r) => !r.removed)
    .map((r) => r.item.flowId);
const remove = async (c: WorkflowManagementController, id: string) => {
  c.confirm(id);
  await c.remove(id);
};
test("load/commands are default off and retirement prevents new or late writes", async () => {
  const f = makeManagementFixture();
  await f.controller.load();
  await f.controller.activate("meeting", false);
  expect(f.stats()).toEqual({ calls: 0, reads: 0, checks: 0 });
  const pending = deferred<BriefReadState<WorkflowList>>();
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", {
    read: () => pending.promise,
  });
  c.setAccess(true);
  const work = c.load();
  c.retire();
  pending.resolve({
    status: "ready",
    data: { scopeId: MANAGEMENT_SCOPE, items: [...f.records.values()] },
  });
  await work;
  expect(c.getSnapshot().rows).toHaveLength(0);
});
test("same identity, revision and operation are sent; acknowledgement changes only that row", async () => {
  const f = await ready(),
    before = structuredClone(f.controller.getSnapshot().rows);
  await f.controller.activate("meeting", false);
  expect(f.controller.getRow("meeting")!.item.activation).toBe("DISABLED");
  expect(f.controller.getSnapshot().rows.slice(1)).toEqual(before.slice(1));
  expect(visible(f.controller)).toEqual([
    "meeting",
    "inbox",
    "competitor",
    "investor",
  ]);
  expect([...f.outcomes.values()][0]).toMatchObject({
    scopeId: MANAGEMENT_SCOPE,
    flowId: "meeting",
    action: "activation",
    status: "accepted",
  });
});
test("failed enable keeps paused value and the exact blocker", async () => {
  const f = await ready("blocked enable");
  await f.controller.activate("investor", true);
  expect(f.controller.getRow("investor")).toMatchObject({
    item: { activation: "DISABLED" },
    phase: "idle",
    message: "Connect Notion before enabling.",
  });
});
test("cancel does not mutate anything or submit; confirmation required", async () => {
  const f = await ready();
  const original = structuredClone(f.controller.getRow("meeting")!.item);
  await f.controller.remove("meeting");
  f.controller.confirm("meeting");
  f.controller.cancel("meeting");
  expect(f.controller.getRow("meeting")!.item).toEqual(original);
  expect(f.stats().calls).toBe(0);
});
test("two removals and reverse-order Undo restore exact slots and version/run identity, paused", async () => {
  const f = await ready();
  const before = f.controller
    .getSnapshot()
    .rows.map((r) => structuredClone(r.item));
  await remove(f.controller, "meeting");
  await remove(f.controller, "competitor");
  expect(visible(f.controller)).toEqual(["inbox", "investor"]);
  await f.controller.restore("competitor");
  expect(visible(f.controller)).toEqual(["inbox", "competitor", "investor"]);
  await f.controller.restore("meeting");
  expect(visible(f.controller)).toEqual(before.map((w) => w.flowId));
  for (const id of ["meeting", "competitor"]) {
    const w = f.controller.getRow(id)!.item,
      old = before.find((w) => w.flowId === id)!;
    expect(w).toMatchObject({
      flowId: id,
      versionId: old.versionId,
      latestRun: old.latestRun,
      activation: "DISABLED",
    });
  }
});
test("refresh retains pending Undo and order despite provider timestamp sorting", async () => {
  const f = await ready();
  await remove(f.controller, "inbox");
  const first = f.records.get("meeting")!;
  f.records.delete("meeting");
  f.records.set("meeting", first);
  await f.controller.refresh();
  expect(visible(f.controller)).toEqual(["meeting", "competitor", "investor"]);
  await f.controller.restore("inbox");
  expect(visible(f.controller)).toEqual([
    "meeting",
    "inbox",
    "competitor",
    "investor",
  ]);
});
test("rejected delete and restore never change visibility", async () => {
  const f = await ready("rejected delete");
  await remove(f.controller, "meeting");
  expect(f.controller.getRow("meeting")!.removed).toBe(false);
  f.setMode("normal");
  await remove(f.controller, "meeting");
  f.setMode("rejected restore");
  await f.controller.restore("meeting");
  expect(f.controller.getRow("meeting")).toMatchObject({
    removed: true,
    phase: "idle",
    message: "Restoration is temporarily unavailable. Try Undo again.",
  });
});
test("expired receipt never restores locally or dispatches another command", async () => {
  const f = makeManagementFixture();
  let clock = Date.now();
  const c = new WorkflowManagementController(
    MANAGEMENT_SCOPE,
    "fixture",
    f.port,
    () => clock,
  );
  c.setAccess(true);
  await c.load();
  await remove(c, "meeting");
  clock = c.getRow("meeting")!.receipt!.expiresAt + 1;
  await c.restore("meeting");
  expect(c.getRow("meeting")).toMatchObject({
    removed: true,
    message: "Undo has expired.",
  });
  expect(f.stats().calls).toBe(1);
});
test("uncertain delete locks row; refresh cannot clear it; reconciliation does not replay", async () => {
  const f = await ready("lost response");
  await remove(f.controller, "meeting");
  expect(f.controller.getRow("meeting")).toMatchObject({
    removed: false,
    phase: "uncertain",
  });
  await remove(f.controller, "meeting");
  await f.controller.activate("meeting", false);
  await f.controller.refresh();
  expect(f.stats()).toEqual({ calls: 1, reads: 1, checks: 0 });
  await f.controller.reconcile("meeting");
  expect(f.controller.getRow("meeting")!.removed).toBe(true);
  expect(f.stats()).toEqual({ calls: 1, reads: 1, checks: 1 });
});
test("uncertain restore retains receipt and resolves once into paused original identity", async () => {
  const f = await ready();
  await remove(f.controller, "meeting");
  f.setMode("lost response");
  await f.controller.restore("meeting");
  expect(f.controller.getRow("meeting")).toMatchObject({
    removed: true,
    phase: "uncertain",
  });
  await f.controller.restore("meeting");
  await f.controller.reconcile("meeting");
  expect(f.controller.getRow("meeting")).toMatchObject({
    removed: false,
    phase: "idle",
    item: { flowId: "meeting", activation: "DISABLED" },
  });
  expect(f.stats().calls).toBe(2);
});
test("concurrent row requests settle independently and repeated actions submit once", async () => {
  const f = makeManagementFixture(),
    wait = deferred<void>();
  let calls = 0;
  const port: WorkflowManagementPort = {
    ...f.port,
    change: async (c) => {
      calls++;
      await wait.promise;
      return f.port.change!(c);
    },
  };
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", port);
  c.setAccess(true);
  await c.load();
  const a = c.activate("meeting", false),
    b = c.activate("inbox", false);
  await c.activate("meeting", false);
  await c.remove("meeting");
  expect(calls).toBe(2);
  expect(c.getRow("meeting")!.item.activation).toBe("ENABLED");
  wait.resolve();
  await Promise.all([a, b]);
  expect(c.getRow("meeting")!.item.activation).toBe("DISABLED");
  expect(c.getRow("inbox")!.item.activation).toBe("DISABLED");
});
test("access loss blocks new commands while keeping submitted acknowledgement", async () => {
  const f = makeManagementFixture(),
    wait = deferred<void>();
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", {
    ...f.port,
    change: async (x) => {
      await wait.promise;
      return f.port.change!(x);
    },
  });
  c.setAccess(true);
  await c.load();
  const op = c.activate("meeting", false);
  c.setAccess(false);
  await c.activate("inbox", false);
  wait.resolve();
  await op;
  expect(c.getRow("meeting")!.item.activation).toBe("DISABLED");
  expect(f.stats().calls).toBe(1);
});
test("stale, unavailable, unsupported and empty are distinct; stale actions fail closed", async () => {
  for (const mode of [
    "stale",
    "unavailable",
    "unsupported",
    "empty",
  ] as const) {
    const f = await ready(mode);
    expect(f.controller.getSnapshot().read.status).toBe(mode);
    await f.controller.activate("meeting", false);
    expect(f.stats().calls).toBe(0);
  }
});
test("read rejects mismatched owner and duplicate IDs without a partial list", async () => {
  const f = makeManagementFixture(),
    items = [...f.records.values()];
  expect(() =>
    validateList({ scopeId: "wrong", items }, MANAGEMENT_SCOPE),
  ).toThrow();
  expect(() =>
    validateList(
      { scopeId: MANAGEMENT_SCOPE, items: [items[0]!, items[0]!] },
      MANAGEMENT_SCOPE,
    ),
  ).toThrow();
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", {
    read: async () => ({ status: "ready", data: { scopeId: "wrong", items } }),
  });
  c.setAccess(true);
  await c.load();
  expect(c.getSnapshot().read.status).toBe("unavailable");
  expect(c.getSnapshot().rows).toHaveLength(0);
});
test("wrong request/owner/flow/action/version or enabled restoration cannot acknowledge", async () => {
  const f = await ready();
  const item = f.controller.getRow("meeting")!.item;
  const c: ManageCommand = {
    scopeId: MANAGEMENT_SCOPE,
    flowId: item.flowId,
    versionId: item.versionId,
    requestId: "r",
    action: "restore",
    expectedRevision: item.revision,
    receiptId: "t",
  };
  const valid: ManageResult = {
    ...c,
    status: "accepted",
    item: { ...item, activation: "DISABLED" },
  };
  for (const patch of [
    { requestId: "x" },
    { flowId: "x" },
    { scopeId: "x" },
    { action: "remove" },
    { item: { ...item, activation: "ENABLED" } },
    { item: { ...item, versionId: "x" } },
  ])
    expect(() =>
      validateResult({ ...valid, ...patch } as ManageResult, c),
    ).toThrow();
  expect(validateResult(valid, c)).toBe(valid);
});
test("invalid acknowledgement becomes uncertain and cannot unlock a second attempt", async () => {
  const f = makeManagementFixture();
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", {
    ...f.port,
    change: async (q) => ({ ...(await f.port.change!(q)), requestId: "wrong" }),
  });
  c.setAccess(true);
  await c.load();
  await c.activate("meeting", false);
  expect(c.getRow("meeting")!.phase).toBe("uncertain");
  await c.activate("meeting", false);
  expect(f.stats().calls).toBe(1);
});
test("newest read wins even when a provider ignores abort", async () => {
  const f = makeManagementFixture(),
    pending = deferred<BriefReadState<WorkflowList>>();
  let reads = 0;
  const c = new WorkflowManagementController(MANAGEMENT_SCOPE, "fixture", {
    read: () =>
      ++reads === 1 ? pending.promise : Promise.resolve({ status: "empty" }),
  });
  c.setAccess(true);
  const old = c.load();
  await c.refresh();
  pending.resolve({
    status: "ready",
    data: { scopeId: MANAGEMENT_SCOPE, items: [...f.records.values()] },
  });
  await old;
  expect(c.getSnapshot().read.status).toBe("empty");
  expect(c.getSnapshot().rows).toHaveLength(0);
});
test("all removed and empty refresh still permit receipt-backed restoration", async () => {
  const f = await ready();
  for (const id of visible(f.controller)) await remove(f.controller, id);
  f.setMode("empty");
  await f.controller.refresh();
  await f.controller.restore("inbox");
  expect(visible(f.controller)).toEqual(["inbox"]);
  expect(f.controller.canChange("inbox")).toBe(true);
});
test("list position/selection persist independently of row actions", async () => {
  const f = await ready();
  f.controller.savePosition(840, "competitor");
  await remove(f.controller, "meeting");
  await f.controller.restore("meeting");
  expect(f.controller.getSnapshot()).toMatchObject({
    scrollTop: 840,
    selectedId: "competitor",
  });
});

test("a loading projection can be refreshed later without a stuck busy state", async () => {
  const f = await ready("loading");
  expect(f.controller.getSnapshot()).toMatchObject({
    read: { status: "loading" },
    refreshing: false,
  });
  f.setMode("normal");
  await f.controller.refresh();
  expect(visible(f.controller)).toHaveLength(4);
});

for (const activation of ["DISABLED", "ENABLED"] as const)
  test(`R1: a ready snapshot restores an externally ${activation} workflow to its reserved slot`, async () => {
    const f = await ready();
    const original = structuredClone(f.records.get("inbox")!);
    f.controller.savePosition(840, "competitor");
    await remove(f.controller, "inbox");
    // Another client restores the same identity; the provider's list order has
    // changed, but this controller must recover its original slot and new data.
    f.tombstones.delete("inbox");
    f.records.set("inbox", { ...original, revision: "3", activation });
    const calls = f.stats().calls;
    await f.controller.refresh();
    expect(visible(f.controller)).toEqual([
      "meeting",
      "inbox",
      "competitor",
      "investor",
    ]);
    expect(f.controller.getRow("inbox")).toMatchObject({
      item: { ...original, revision: "3", activation },
      removed: false,
      receipt: null,
      message: null,
      phase: "idle",
      command: null,
    });
    expect(f.controller.getSnapshot()).toMatchObject({
      scrollTop: 840,
      selectedId: "competitor",
    });
    expect(f.stats().calls).toBe(calls);
    expect(f.controller.canChange("inbox")).toBe(true);
    await f.controller.activate("inbox", activation !== "ENABLED");
    expect(f.controller.getRow("inbox")!.item.activation).toBe(
      activation === "ENABLED" ? "DISABLED" : "ENABLED",
    );
  });

test("R1: a stale pre-deletion snapshot cannot resurrect a removed workflow or clear its receipt", async () => {
  const f = await ready();
  const original = structuredClone(f.records.get("inbox")!);
  await remove(f.controller, "inbox");
  const removedRow = structuredClone(f.controller.getRow("inbox"));
  f.records.set("inbox", original);
  f.setMode("stale");
  await f.controller.refresh();
  expect(f.controller.getRow("inbox")).toEqual(removedRow);
  expect(visible(f.controller)).toEqual(["meeting", "competitor", "investor"]);
  expect(f.controller.canChange("inbox")).toBe(false);
  f.records.delete("inbox");
  f.setMode("normal");
  await f.controller.refresh();
  expect(f.controller.getRow("inbox")).toEqual(removedRow);
  expect(f.controller.canChange("inbox")).toBe(true);
});

test("R2: fresh external activation supersedes the previous local status message", async () => {
  const f = await ready();
  await f.controller.activate("meeting", false);
  expect(f.controller.getRow("meeting")!.message).toBe("Workflow paused.");
  f.records.set("meeting", {
    ...f.records.get("meeting")!,
    activation: "ENABLED",
    revision: "3",
  });
  await f.controller.refresh();
  expect(f.controller.getRow("meeting")).toMatchObject({
    item: { activation: "ENABLED", revision: "3" },
    message: null,
  });
});

test("R2: a fresh ready snapshot clears a resolved blocker and permits enabling with its new revision", async () => {
  const f = await ready("blocked enable");
  await f.controller.activate("investor", true);
  expect(f.controller.getRow("investor")!.message).toBe(
    "Connect Notion before enabling.",
  );
  f.records.set("investor", {
    ...f.records.get("investor")!,
    revision: "2",
    readiness: { state: "ready", reason: null },
  });
  f.setMode("normal");
  await f.controller.refresh();
  expect(f.controller.getRow("investor")).toMatchObject({
    item: { readiness: { state: "ready", reason: null } },
    message: null,
  });
  await f.controller.activate("investor", true);
  expect(f.controller.getRow("investor")!.item.activation).toBe("ENABLED");
});

test("R2: unchanged fresh data clears transient command feedback, but a stale response does not", async () => {
  const f = await ready();
  await f.controller.activate("meeting", false);
  f.setMode("stale");
  await f.controller.refresh();
  expect(f.controller.getRow("meeting")!.message).toBe("Workflow paused.");
  f.setMode("normal");
  await f.controller.refresh();
  expect(f.controller.getRow("meeting")!.message).toBeNull();
  expect(f.controller.getRow("meeting")!.item.activation).toBe("DISABLED");
});
