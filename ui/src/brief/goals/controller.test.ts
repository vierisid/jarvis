import { test, expect } from "bun:test";
import { GoalsController } from "./controller";
import { goalPaths, makeGoalsFixture } from "./fixtures";
import type { BriefReadState } from "../contracts";
import type { GoalCollection } from "./model";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
test("access gates reads; revocation clears private rows and selection", async () => {
  let calls = 0;
  const c = new GoalsController({
    source: "live",
    scopeId: "one",
    read: async () => {
      calls++;
      return { status: "ready", data: goalPaths() };
    },
  });
  await c.refresh();
  expect(calls).toBe(0);
  c.setAccess(true);
  await flush();
  expect(c.rows()).toHaveLength(9);
  c.setAccess(false);
  expect(c.rows()).toHaveLength(0);
  expect(c.snapshot().selectedId).toBeNull();
  c.retire();
});
test("selection survives reorder, tab returns, filter returns and refreshed values", async () => {
  const f = makeGoalsFixture();
  const c = f.controller;
  c.setAccess(true);
  await flush();
  c.select("fixture-story");
  f.reorder();
  await c.refresh();
  expect(c.snapshot().selectedId).toBe("fixture-story");
  c.setTab("completed");
  c.select("fixture-onboarding");
  c.setTab("active");
  expect(c.snapshot().selectedId).toBe("fixture-story");
  c.setFilter("paused");
  expect(c.snapshot().selectedId).toBe("fixture-paused");
  c.setFilter("active");
  expect(c.snapshot().selectedId).toBe("fixture-story");
  c.setTab("completed");
  expect(c.snapshot().selectedId).toBe("fixture-onboarding");
  c.retire();
});
test("unknown, failed and completed direct IDs select their real status", async () => {
  const c = makeGoalsFixture().controller;
  c.setAccess(true);
  await flush();
  expect(c.open("missing")).toBe(false);
  c.open("fixture-failed");
  expect(c.snapshot().filter).toBe("failed");
  c.open("fixture-launch");
  expect(c.snapshot().tab).toBe("completed");
  c.retire();
});
test("late reads cannot overwrite a later selection or refreshed data", async () => {
  const pending: ((value: BriefReadState<GoalCollection>) => void)[] = [];
  const c = new GoalsController({
    source: "fixture",
    scopeId: "x",
    read: () => new Promise((resolve) => pending.push(resolve)),
  });
  c.setAccess(true);
  const latest = c.refresh();
  pending[1]!({ status: "ready", data: goalPaths() });
  await latest;
  c.select("fixture-story");
  pending[0]!({ status: "empty" });
  await flush();
  expect(c.snapshot().selectedId).toBe("fixture-story");
  const refresh = c.refresh();
  c.select("fixture-focus");
  pending[2]!({ status: "ready", data: goalPaths() });
  await refresh;
  expect(c.snapshot().selectedId).toBe("fixture-focus");
  c.retire();
});
test("failed refresh retains a stale read; duplicate projections fail closed", async () => {
  let fail = false;
  const c = new GoalsController({
    source: "fixture",
    scopeId: "x",
    read: async () => {
      if (fail)
        return { status: "ready", data: [goalPaths()[0]!, goalPaths()[0]!] };
      return { status: "ready", data: goalPaths() };
    },
  });
  c.setAccess(true);
  await flush();
  fail = true;
  await c.refresh();
  expect(c.snapshot().read.status).toBe("stale");
  expect(c.rows()).toHaveLength(9);
  c.retire();
});
test("retired or revoked pending reads cannot repopulate a scope", async () => {
  for (const retire of [false, true]) {
    let resolve!: (value: BriefReadState<GoalCollection>) => void;
    const c = new GoalsController({
      source: "live",
      scopeId: "x",
      read: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    c.setAccess(true);
    retire ? c.retire() : c.setAccess(false);
    resolve({ status: "ready", data: goalPaths() });
    await flush();
    expect(c.rows()).toHaveLength(0);
  }
});
test("read-state families remain distinct", async () => {
  for (const example of [
    "loading",
    "empty",
    "stale",
    "unavailable",
    "unsupported",
  ] as const) {
    const c = makeGoalsFixture(example).controller;
    c.setAccess(true);
    await flush();
    expect(c.snapshot().read.status).toBe(example);
    c.retire();
  }
});
