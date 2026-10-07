import { expect, test } from "bun:test";
import { WorkflowRunsController } from "./controller";
import { makeRunsFixture, RUN_SCOPE } from "./fixtures";
import {
  RUN_STATES,
  validateDetail,
  validatePage,
  type RunDetail,
  type RunPage,
  type ManualRunResult,
} from "./model";
import type { BriefReadState } from "../../contracts";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const detail = (fixture: ReturnType<typeof makeRunsFixture>, n = 12) =>
  structuredClone(
    fixture.records.get(`meeting-run-${String(n).padStart(3, "0")}`)!,
  );
const ready = <T>(data: T): BriefReadState<T> => ({ status: "ready", data });

test("all seven states and historical versions retain immutable identities", async () => {
  const f = makeRunsFixture();
  await f.controller.load();
  const h = f.controller.getSnapshot().history;
  expect(h.status).toBe("ready");
  if (h.status !== "ready") throw Error();
  expect(new Set(h.data.items.map((r) => r.status))).toEqual(
    new Set(RUN_STATES),
  );
  f.controller.select("meeting-run-001");
  await tick();
  const d = f.controller.getSnapshot().detail;
  expect(d.status).toBe("ready");
  if (d.status !== "ready") throw Error();
  expect(d.data.versionId).toBe("meeting-v2");
  expect(d.data.context[1]?.availability).toBe("removed");
  f.controller.retire();
});
test("late A cannot replace B, even when the provider ignores cancellation", async () => {
  const f = makeRunsFixture(),
    a = deferred<BriefReadState<RunDetail>>(),
    b = deferred<BriefReadState<RunDetail>>();
  const s = new WorkflowRunsController(RUN_SCOPE, {
    ...f.port,
    detail: (id) => (id.endsWith("012") ? a.promise : b.promise),
  });
  s.select("meeting-run-012");
  s.select("meeting-run-011");
  b.resolve(ready(detail(f, 11)));
  await tick();
  a.resolve(ready(detail(f, 12)));
  await tick();
  expect(s.getSnapshot().selectedId).toBe("meeting-run-011");
  expect(s.getSnapshot().detail).toEqual(ready(detail(f, 11)));
  s.retire();
});
test("changing selection removes the previous result immediately, including on read failure", async () => {
  const f = makeRunsFixture();
  await f.controller.load();
  f.port.detail = async () => {
    throw Error("PRIVATE_CREDENTIAL_ERROR");
  };
  f.controller.select("missing");
  expect(f.controller.getSnapshot().detail.status).toBe("loading");
  await tick();
  expect(f.controller.getSnapshot().detail.status).toBe("unavailable");
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(
    "PRIVATE_CREDENTIAL_ERROR",
  );
  f.controller.retire();
});
test("same-run refresh failure is stale, never a fresh success or another run", async () => {
  const f = makeRunsFixture();
  await f.controller.load();
  f.port.detail = async () => {
    throw Error();
  };
  await f.controller.refresh();
  const d = f.controller.getSnapshot().detail;
  expect(d.status).toBe("stale");
  if (d.status !== "stale") throw Error();
  expect(d.data.runId).toBe("meeting-run-012");
  f.controller.retire();
});
for (const change of ["run", "flow", "scope", "version"] as const)
  test(`reject ${change} identity substitution in selected detail`, async () => {
    const f = makeRunsFixture(),
      wrong = detail(f);
    if (change === "run") wrong.runId = "other";
    if (change === "flow") wrong.flowId = "other";
    if (change === "scope") wrong.scopeId = "other";
    if (change === "version") wrong.versionId = "newer";
    const s = new WorkflowRunsController(RUN_SCOPE, {
      ...f.port,
      detail: async () => ready(wrong),
    });
    await s.load();
    expect(s.getSnapshot().detail.status).toBe("unavailable");
    s.retire();
  });
test("partial receipts and waitpoints remain inspectable without replay actions", async () => {
  const f = makeRunsFixture();
  await f.controller.load();
  let d = f.controller.getSnapshot().detail;
  if (d.status !== "ready") throw Error();
  expect(d.data.waits[0]?.status).toBe("waiting");
  f.controller.select("meeting-run-006");
  await tick();
  d = f.controller.getSnapshot().detail;
  if (d.status !== "ready") throw Error();
  expect(d.data.status).toBe("uncertain");
  expect(d.data.effects[0]?.status).toBe("unknown");
  f.controller.select("meeting-run-007");
  await tick();
  d = f.controller.getSnapshot().detail;
  if (d.status !== "ready") throw Error();
  expect(d.data.status).toBe("cancelled");
  expect(d.data.effects[0]?.status).toBe("succeeded");
  f.controller.retire();
});
test("manual run is single-flight, pinned and selects the returned ID", async () => {
  const f = makeRunsFixture(),
    pending = deferred<ManualRunResult>();
  let calls = 0,
    request: any;
  const s = new WorkflowRunsController(RUN_SCOPE, {
    ...f.port,
    start: async (r) => {
      calls++;
      request = r;
      return pending.promise;
    },
  });
  await s.load();
  const p = s.start();
  void s.start();
  expect(calls).toBe(1);
  expect(s.canRun).toBe(false);
  expect(request).toMatchObject(RUN_SCOPE);
  const run = {
    ...detail(f),
    runId: "returned-run",
    label: "Returned run",
    status: "queued" as const,
  };
  f.records.set(run.runId, run);
  pending.resolve({ status: "accepted", requestId: request.requestId, run });
  await p;
  await tick();
  expect(s.getSnapshot().selectedId).toBe("returned-run");
  expect(s.getSnapshot().submission).toBe("accepted");
  expect(calls).toBe(1);
  s.retire();
});
test("an unconfirmed command stays locked through subsequent reads and subscriptions", async () => {
  const f = makeRunsFixture(),
    s = new WorkflowRunsController(RUN_SCOPE, {
      ...f.port,
      start: async () => {
        throw Error("lost response");
      },
    });
  await s.start();
  const id = s.getSnapshot().request!.requestId;
  const unsubscribe = s.subscribe(() => {});
  unsubscribe();
  await s.refresh();
  await s.start();
  expect(s.canRun).toBe(false);
  expect(s.getSnapshot().submission).toBe("uncertain");
  expect(s.getSnapshot().request?.requestId).toBe(id);
  s.retire();
});
test("definitely not submitted releases the command but a mismatched receipt does not", async () => {
  const f = makeRunsFixture(),
    s = new WorkflowRunsController(RUN_SCOPE, {
      ...f.port,
      start: async (r) => ({ status: "not_submitted", requestId: r.requestId }),
    });
  await s.start();
  expect(s.canRun).toBe(true);
  s.port.start = async () => ({
    status: "not_submitted",
    requestId: "different",
  });
  await s.start();
  expect(s.canRun).toBe(false);
  expect(s.getSnapshot().submission).toBe("uncertain");
  s.retire();
});
test("owner retirement rejects late detail and command results", async () => {
  const f = makeRunsFixture(),
    p = deferred<ManualRunResult>(),
    s = new WorkflowRunsController(RUN_SCOPE, {
      ...f.port,
      start: async () => p.promise,
    });
  const work = s.start();
  const request = s.getSnapshot().request!;
  s.retire();
  p.resolve({
    status: "accepted",
    requestId: request.requestId,
    run: detail(f),
  });
  await work;
  expect(s.getSnapshot().selectedId).toBeNull();
  expect(s.canRun).toBe(false);
});
test("a head-page request started before Run cannot overwrite its new receipt", async () => {
  const f = makeRunsFixture(),
    pending = deferred<BriefReadState<RunPage>>();
  let r: any;
  const s = new WorkflowRunsController(RUN_SCOPE, {
    ...f.port,
    list: () => pending.promise,
    start: async (request) => {
      r = { ...detail(f), runId: "new-run", label: "New run" };
      return { status: "accepted", requestId: request.requestId, run: r };
    },
  });
  const load = s.load();
  await s.start();
  pending.resolve(ready({ items: [detail(f)], total: 12, nextCursor: null }));
  await load;
  const h = s.getSnapshot().history;
  if (h.status !== "ready") throw Error();
  expect(h.data.items.some((run) => run.runId === "new-run")).toBe(true);
  expect(s.getSnapshot().selectedId).toBe("new-run");
  s.retire();
});
test("history paging deduplicates IDs and preserves selection", async () => {
  const f = makeRunsFixture(),
    s = new WorkflowRunsController(RUN_SCOPE, {
      ...f.port,
      list: async (cursor) =>
        ready({
          items: cursor
            ? [detail(f, 11), detail(f, 10)]
            : [detail(f, 12), detail(f, 11)],
          nextCursor: cursor ? null : "older",
          total: 3,
        }),
    });
  await s.load();
  s.select("meeting-run-011");
  await s.more();
  let h = s.getSnapshot().history;
  if (h.status !== "ready") throw Error();
  expect(h.data.items.map((r) => r.runId)).toEqual([
    "meeting-run-012",
    "meeting-run-011",
    "meeting-run-010",
  ]);
  await s.refresh();
  h = s.getSnapshot().history;
  if (h.status !== "ready") throw Error();
  expect(h.data.items.length).toBe(3);
  expect(s.getSnapshot().selectedId).toBe("meeting-run-011");
  s.retire();
});
test("invalid projections cannot smuggle identities or unusable statuses", () => {
  const f = makeRunsFixture(),
    run = detail(f);
  for (const patch of [
    { status: "complete" },
    { scopeId: "other" },
    { steps: [{ id: "x" }] },
  ])
    expect(() =>
      validateDetail({ ...run, ...patch } as RunDetail, RUN_SCOPE, run.runId),
    ).toThrow();
  expect(() =>
    validatePage({ items: [run, run], total: 2, nextCursor: null }, RUN_SCOPE),
  ).toThrow();
});
