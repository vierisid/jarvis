import { expect, test } from "bun:test";
import type { BriefReadState } from "../../contracts";
import { RUN_SCOPE } from "../runs/fixtures";
import { WorkflowContextController } from "./controller";
import { makeContextFixture } from "./fixtures";
import { GROUPS, validateContext, type ContextDocument } from "./model";
const configured = { basis: "configured" } as const;
const recorded = { basis: "recorded", runId: "meeting-run-001" } as const;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function doc() {
  const f = makeContextFixture();
  const r = await f.port.read(
    RUN_SCOPE,
    configured,
    new AbortController().signal,
  );
  if (r.status !== "ready") throw Error(r.status);
  return r.data;
}
test("context matches owner, flow, version and configured/recorded identity", async () => {
  const d = await doc();
  for (const patch of [
    { scopeId: "other" },
    { flowId: "other" },
    { versionId: "other" },
    { basis: "recorded" as const },
    { runId: "other" },
  ]) {
    expect(() =>
      validateContext({ ...d, ...patch }, RUN_SCOPE, configured),
    ).toThrow();
  }
  const past = {
    ...d,
    basis: "recorded" as const,
    runId: recorded.runId,
    runLabel: "Run 001",
    versionId: "meeting-v2",
  };
  expect(validateContext(past, RUN_SCOPE, recorded).versionId).toBe(
    "meeting-v2",
  );
  expect(() =>
    validateContext(past, RUN_SCOPE, { ...recorded, runId: "other" }),
  ).toThrow();
  expect(() =>
    validateContext(past, RUN_SCOPE, { ...recorded, versionId: "meeting-v1" }),
  ).toThrow();
});
test("invalid and duplicate group entries fail closed; unknown is not empty", async () => {
  const d = await doc();
  for (const change of [
    (v: ContextDocument) => {
      delete (v.groups as Partial<ContextDocument["groups"]>).goal;
    },
    (v: ContextDocument) => {
      v.asOf = Infinity;
    },
    (v: ContextDocument) => {
      v.asOf = 9e15;
    },
    (v: ContextDocument) => {
      v.groups.memory = { status: "ready", data: [null as never] };
    },
    (v: ContextDocument) => {
      const r = v.groups.goal;
      if (r.status === "ready") r.data.push(r.data[0]!);
    },
    (v: ContextDocument) => {
      const r = v.groups.goal;
      if (r.status === "ready")
        r.data[0]!.source = { kind: "unsafe" as never, id: "id" };
    },
  ]) {
    const copy = structuredClone(d);
    change(copy);
    expect(() => validateContext(copy, RUN_SCOPE, configured)).toThrow();
  }
});
test("redaction strips label, content and source before caching without copying extra fields", async () => {
  const d = await doc();
  d.groups.memory = {
    status: "ready",
    data: [
      {
        id: "private-row",
        label: "SECRET LABEL",
        value: "SECRET VALUE",
        availability: "redacted",
        source: { kind: "fact", id: "SECRET ID" },
        privateRaw: "SECRET RAW",
      } as never,
    ],
  };
  const safe = validateContext(d, RUN_SCOPE, configured);
  expect(JSON.stringify(safe)).not.toContain("SECRET");
  expect(safe.groups.memory).toMatchObject({
    status: "ready",
    data: [{ label: "Restricted source", value: "Redacted", source: null }],
  });
});
test("configured and recorded context remain independent, including historical versions", async () => {
  const f = makeContextFixture();
  await Promise.all([
    f.controller.load(configured),
    f.controller.load(recorded),
  ]);
  expect(f.controller.get(configured)).toMatchObject({
    status: "ready",
    data: { versionId: "meeting-v3", basis: "configured", runId: null },
  });
  expect(f.controller.get(recorded)).toMatchObject({
    status: "ready",
    data: { versionId: "meeting-v2", basis: "recorded", runId: recorded.runId },
  });
  expect(JSON.stringify(f.controller.get(recorded))).toContain("removed"); // unavailable source remains recorded
  expect(JSON.stringify(f.controller.get(recorded))).not.toContain(
    "goal-design-partners",
  );
  f.controller.retire();
});
test("parallel reads settle into their own query, never beneath the other basis", async () => {
  const d = await doc(),
    pending = deferred<BriefReadState<ContextDocument>>();
  const store = new WorkflowContextController(RUN_SCOPE, {
    read: async (_, q) =>
      q.basis === "configured"
        ? pending.promise
        : {
            status: "ready",
            data: {
              ...d,
              basis: "recorded",
              runId: recorded.runId,
              runLabel: "Run 001",
            },
          },
  });
  const a = store.load(configured);
  await store.load(recorded);
  expect(store.get(configured).status).toBe("loading");
  pending.resolve({ status: "ready", data: d });
  await a;
  expect(store.get(recorded)).toMatchObject({
    data: { basis: "recorded", runId: recorded.runId },
  });
  store.retire();
});
test("repeated refresh coalesces a slow read instead of restarting it", async () => {
  const pending = deferred<BriefReadState<ContextDocument>>();
  let calls = 0,
    signal: AbortSignal | undefined;
  const store = new WorkflowContextController(RUN_SCOPE, {
    read: async (_, __, s) => {
      calls++;
      signal = s;
      return pending.promise;
    },
  });
  const a = store.refresh(configured),
    b = store.refresh(configured);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(signal?.aborted).toBe(false);
  pending.resolve({ status: "ready", data: await doc() });
  await Promise.all([a, b]);
  expect(store.get(configured).status).toBe("ready");
  store.retire();
});
test("owner retirement aborts reads and rejects late provider results", async () => {
  const pending = deferred<BriefReadState<ContextDocument>>();
  let signal: AbortSignal | undefined;
  const store = new WorkflowContextController(RUN_SCOPE, {
    read: async (_, __, s) => {
      signal = s;
      return pending.promise;
    },
  });
  const request = store.refresh(configured);
  await Promise.resolve();
  store.retire();
  expect(signal?.aborted).toBe(true);
  pending.resolve({ status: "ready", data: await doc() });
  await request;
  expect(store.get(configured).status).toBe("unavailable");
  expect(store.active).toBe(false);
});
test("a failed refresh keeps qualified stale data; retry recovers", async () => {
  const f = makeContextFixture();
  await f.controller.load(configured);
  const original = f.port.read;
  f.port.read = async () => {
    throw Error("TOKEN secret provider error");
  };
  await f.controller.refresh(configured);
  expect(f.controller.get(configured).status).toBe("stale");
  expect(JSON.stringify(f.controller.get(configured))).not.toContain("TOKEN");
  f.port.read = original;
  await f.controller.refresh(configured);
  expect(f.controller.get(configured).status).toBe("ready");
  f.controller.retire();
});
test("missing, removed, stale, partial, unavailable, unsupported and empty retain their meaning", async () => {
  const f = makeContextFixture();
  f.setMode("missing");
  await f.controller.load(configured);
  const missing = JSON.stringify(f.controller.get(configured));
  for (const value of ["missing", "removed", "stale"])
    expect(missing).toContain(value);
  f.setMode("partial");
  await f.controller.refresh(recorded);
  expect(f.controller.get(recorded)).toMatchObject({
    data: {
      groups: {
        memory: { status: "unavailable" },
        bindings: { status: "stale" },
      },
    },
  });
  for (const mode of ["unavailable", "unsupported", "empty"] as const) {
    f.setMode(mode);
    await f.controller.refresh(configured);
    expect(f.controller.get(configured).status).toBe(mode);
  }
  f.controller.retire();
});
test("mode and per-query scroll positions survive repeated returns", async () => {
  const f = makeContextFixture();
  await f.controller.load(configured);
  const before = f.stats().reads;
  f.controller.setMode("recorded");
  f.controller.rememberPosition(recorded, 420);
  f.controller.rememberPosition(configured, 80);
  await f.controller.load(configured);
  expect(f.stats().reads).toBe(before);
  expect(f.controller.getSnapshot().mode).toBe("recorded");
  expect(f.controller.position(recorded)).toBe(420);
  expect(f.controller.position(configured)).toBe(80);
  f.controller.retire();
});
