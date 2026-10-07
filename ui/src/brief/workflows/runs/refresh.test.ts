import { expect, test } from "bun:test";
import { WorkflowRunsController } from "./controller";
import { makeRunsFixture, RUN_SCOPE } from "./fixtures";
import type { BriefReadState } from "../../contracts";
import type { RunDetail, RunPage, WorkflowRunsPort } from "./model";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function historyFixture() {
  const f = makeRunsFixture();
  const record = (id: number) =>
    structuredClone(
      f.records.get(`meeting-run-${String(id).padStart(3, "0")}`)!,
    );
  let ids = [3, 2, 1];
  const reads: Array<string | null> = [];
  const port: WorkflowRunsPort = {
    ...f.port,
    async list(cursor) {
      reads.push(cursor);
      const offset = cursor === null ? 0 : ids.indexOf(Number(cursor)) + 1;
      const page = ids.slice(offset, offset + 2);
      return {
        status: "ready",
        data: {
          items: page.map(record),
          total: ids.length,
          nextCursor: offset + 2 < ids.length ? String(page.at(-1)) : null,
        },
      };
    },
  };
  const store = new WorkflowRunsController(RUN_SCOPE, port);
  const rows = () => {
    const h = store.getSnapshot().history;
    if (h.status !== "ready" && h.status !== "stale") throw Error(h.status);
    return h.data;
  };
  return {
    f,
    record,
    store,
    port,
    reads,
    rows,
    setIds: (next: number[]) => {
      ids = next;
    },
  };
}
test("R1 refresh bridges new head pages after previously exhausted history", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  h.store.select(h.record(2).runId);
  h.setIds([6, 5, 4, 3, 2, 1]);
  await h.store.refresh();
  expect(h.rows().items.map((r) => r.runId)).toEqual(
    [6, 5, 4, 3, 2, 1].map((n) => h.record(n).runId),
  );
  expect(h.rows().nextCursor).toBeNull();
  expect(h.store.getSnapshot().selectedId).toBe(h.record(2).runId);
  h.store.retire();
});
test("R1 refresh keeps the continuation after bridging a partial loaded range", async () => {
  const h = historyFixture();
  h.setIds([6, 5, 4, 3, 2, 1]);
  await h.store.load();
  await h.store.more();
  h.setIds([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  await h.store.refresh();
  await h.store.more();
  expect(h.rows().items.map((r) => r.runId)).toEqual(
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => h.record(n).runId),
  );
  expect(h.rows().nextCursor).toBeNull();
  h.store.retire();
});
test("R2 repeated refreshes do not supersede a slow history read", async () => {
  const h = historyFixture(),
    pending = deferred<BriefReadState<RunPage>>();
  let calls = 0;
  let signal!: AbortSignal;
  h.port.list = async (_, s) => {
    calls++;
    signal = s;
    return pending.promise;
  };
  const a = h.store.refresh();
  const b = h.store.refresh();
  const c = h.store.refresh();
  pending.resolve({
    status: "ready",
    data: { items: [h.record(3)], total: 1, nextCursor: null },
  });
  await Promise.all([a, b, c]);
  expect(calls).toBe(1);
  expect(signal.aborted).toBe(false);
  expect(h.rows().items).toHaveLength(1);
  h.store.retire();
});
test("R2 a selected slow detail survives polling and a genuine selection still cancels it", async () => {
  const h = historyFixture(),
    pending = deferred<BriefReadState<RunDetail>>();
  let calls = 0;
  const signals: AbortSignal[] = [];
  h.port.detail = async (id, s) => {
    calls++;
    signals.push(s);
    return id === h.record(3).runId
      ? pending.promise
      : { status: "ready", data: h.record(2) };
  };
  h.store.select(h.record(3).runId);
  const a = h.store.refresh();
  await tick();
  const b = h.store.refresh();
  await tick();
  const callsBeforeSelection = calls,
    abortedBeforeSelection = signals[0]!.aborted;
  h.store.select(h.record(2).runId);
  await tick();
  pending.resolve({ status: "ready", data: h.record(3) });
  await Promise.all([a, b]);
  expect(callsBeforeSelection).toBe(1);
  expect(abortedBeforeSelection).toBe(false);
  expect(signals[0]!.aborted).toBe(true);
  expect(h.store.getSnapshot().detail).toMatchObject({
    status: "ready",
    data: { runId: h.record(2).runId },
  });
  h.store.retire();
});
test("R2 polling cannot cancel an in-flight older page", async () => {
  const h = historyFixture();
  await h.store.load();
  const pending = deferred<BriefReadState<RunPage>>(),
    original = h.port.list;
  let signal!: AbortSignal;
  h.port.list = async (cursor, s) => {
    if (cursor) {
      signal = s;
      return pending.promise;
    }
    return original(cursor, s);
  };
  const more = h.store.more(),
    refresh = h.store.refresh();
  pending.resolve({
    status: "ready",
    data: { items: [h.record(1)], total: 3, nextCursor: null },
  });
  await Promise.all([more, refresh]);
  expect(signal.aborted).toBe(false);
  expect(h.rows().items).toHaveLength(3);
  h.store.retire();
});
test("R3 selected detail immediately reconciles the matching cached history summary", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  const run = h.f.records.get(h.record(1).runId)!;
  run.status = "failed";
  h.store.select(run.runId);
  await tick();
  expect(h.rows().items.find((r) => r.runId === run.runId)?.status).toBe(
    "failed",
  );
  expect(h.store.getSnapshot().detail).toMatchObject({
    status: "ready",
    data: { status: "failed" },
  });
  h.store.retire();
});
test("R3 refresh also reconciles older unselected nonterminal rows", async () => {
  const h = historyFixture();
  const run = h.f.records.get(h.record(1).runId)!;
  run.status = "paused";
  await h.store.load();
  await h.store.more();
  run.status = "succeeded";
  await h.store.refresh();
  expect(h.rows().items.find((r) => r.runId === run.runId)?.status).toBe(
    "succeeded",
  );
  expect(h.store.getSnapshot().selectedId).toBe(h.record(3).runId);
  h.store.retire();
});

test("R1 a failed gap read keeps stale history recoverable and retries from the head", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  h.setIds([6, 5, 4, 3, 2, 1]);
  const original = h.port.list;
  let fail = true;
  h.port.list = async (cursor, signal) =>
    cursor && fail
      ? { status: "unavailable", reason: "offline" }
      : original(cursor, signal);
  await h.store.refresh();
  expect(h.store.getSnapshot().history.status).toBe("stale");
  expect(h.rows().items).toHaveLength(3);
  fail = false;
  await h.store.refresh();
  expect(h.rows().items.map((r) => r.runId)).toEqual(
    [6, 5, 4, 3, 2, 1].map((n) => h.record(n).runId),
  );
  h.store.retire();
});
test("R1 a repeated cursor fails locally instead of looping or claiming complete history", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  let calls = 0;
  h.port.list = async () => {
    calls++;
    return {
      status: "ready",
      data: { items: [h.record(6)], total: 6, nextCursor: "same" },
    };
  };
  await h.store.refresh();
  expect(calls).toBe(2);
  expect(h.store.getSnapshot().history.status).toBe("stale");
  expect(h.rows().items).toHaveLength(3);
  h.store.retire();
});
test("R1 a large changed range remains bounded with an explicit usable continuation", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  let calls = 0;
  h.port.list = async (cursor) => {
    calls++;
    const n = cursor ? Number(cursor) - 1 : 100;
    return {
      status: "ready",
      data: {
        items: [{ ...h.record(6), runId: `generated-${n}`, label: `Run ${n}` }],
        total: 100,
        nextCursor: n > 1 ? String(n) : null,
      },
    };
  };
  await h.store.refresh();
  expect(calls).toBe(20);
  expect(h.store.getSnapshot().history.status).toBe("stale");
  expect(h.rows().nextCursor).toBe("81");
  await h.store.more();
  expect(h.rows().items.at(-1)?.runId).toBe("generated-80");
  expect(h.rows().nextCursor).toBe("80");
  h.store.retire();
});
test("R3 an in-flight old history snapshot cannot undo a newer detail summary", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.more();
  const pending = deferred<BriefReadState<RunPage>>();
  const before = h.record(3);
  h.port.list = async () => pending.promise;
  const refresh = h.store.refresh();
  await tick();
  h.f.records.get(before.runId)!.status = "failed";
  h.store.select(h.record(2).runId);
  await tick();
  h.store.select(before.runId);
  await tick();
  const states: string[] = [];
  const stop = h.store.subscribe(() => {
    const status = h.rows().items.find((r) => r.runId === before.runId)?.status;
    if (status) states.push(status);
  });
  pending.resolve({
    status: "ready",
    data: {
      items: [before, h.record(2), h.record(1)],
      total: 3,
      nextCursor: null,
    },
  });
  await refresh;
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((s) => s === "failed")).toBe(true);
  stop();
  h.store.retire();
});
test("R3 a stale detail does not overwrite a fresh history status", async () => {
  const h = historyFixture();
  await h.store.load();
  const old = h.record(2);
  old.status = "running";
  h.port.detail = async () => ({
    status: "stale",
    data: old,
    reason: "offline cache",
  });
  h.store.select(old.runId);
  await tick();
  expect(h.rows().items.find((r) => r.runId === old.runId)?.status).toBe(
    "succeeded",
  );
  expect(h.store.getSnapshot().detail.status).toBe("stale");
  h.store.retire();
});
test("accepted receipts survive projection lag, including a request for an older page", async () => {
  const h = historyFixture();
  await h.store.load();
  await h.store.start();
  const id = h.store.getSnapshot().selectedId!;
  await h.store.more();
  await h.store.refresh();
  expect(h.rows().items.filter((r) => r.runId === id)).toHaveLength(1);
  expect(h.store.getSnapshot().selectedId).toBe(id);
  expect(h.rows().total).toBeNull();
  h.store.retire();
});
