import { expect, test } from "bun:test";
import { activityStatus, mergeActivity, runActivityItems } from "./model";
import type { RecentWorkflow } from "../../workflows/recent-rows/model";

const run = (over: Partial<RecentWorkflow>): RecentWorkflow => ({ flowId: "f", versionId: "v", runId: "r", name: "Inbox brief", status: "SUCCEEDED",
  result: "Run completed", at: Date.parse("2026-11-10T09:30:00Z"), environment: "PRODUCTION", ...over });

test("runs read as plain statuses, and test runs never appear", () => {
  expect(["SUCCEEDED", "FAILED", "PAUSED", "RUNNING", "QUEUED", "STOPPED", "TIMEOUT", "WHATEVER"].map(s => activityStatus(s)))
    .toEqual(["Done", "Failed", "Waiting", "Running", "Queued", "Stopped", "Failed", "Status unknown"]);
  const items = runActivityItems([run({ runId: "a" }), run({ runId: "t", environment: "TESTING" })]);
  expect(items.map(item => item.activityId)).toEqual(["run:a"]);
  expect(items[0]).toMatchObject({ title: "Inbox brief", detail: "Done", destination: { room: "workflow", selection: { flowId: "f", versionId: "v", runId: "a" } } });
});

test("a successful run is the activity even when there are no verified outcomes", () => {
  const state = mergeActivity({ status: "ready", data: [run({})] }, { status: "empty" });
  expect(state).toMatchObject({ status: "ready", data: [{ title: "Inbox brief", detail: "Done" }] });
});

test("newest first, capped at five, outcomes are extra and never the only source", () => {
  const runs = Array.from({ length: 7 }, (_, i) => run({ runId: `r${i}`, flowId: `f${i}`, at: 1000 + i }));
  const outcome = { activityId: "o1", title: "Verified outcome", occurredAt: 9999, timeLabel: "10:00", detail: "5 minutes" };
  const state = mergeActivity({ status: "ready", data: runs }, { status: "ready", data: [outcome] });
  expect(state.status === "ready" && state.data.map(item => item.activityId)).toEqual(["o1", "run:r6", "run:r5", "run:r4", "run:r3"]);
});

test("empty means no runs and no outcomes; unavailable runs are not an empty list", () => {
  expect(mergeActivity({ status: "empty" }, { status: "empty" })).toEqual({ status: "empty" });
  expect(mergeActivity({ status: "empty" }, { status: "unavailable", reason: "x" })).toEqual({ status: "empty" });
  expect(mergeActivity({ status: "unavailable", reason: "down" }, { status: "empty" }).status).toBe("unavailable");
  expect(mergeActivity({ status: "loading" }, { status: "empty" }).status).toBe("loading");
  expect(mergeActivity({ status: "stale", data: [run({})], reason: "late" }, { status: "empty" }).status).toBe("stale");
});

test("only a run waiting on a person says it waits for you; a timer shows its time", () => {
  const now = Date.parse("2026-11-10T12:00:00Z"), at = Date.parse("2026-11-10T14:05:00Z");
  expect(activityStatus("PAUSED", { waitingOn: "person" }, now)).toBe("Waiting for you");
  expect(activityStatus("PAUSED", { waitingOn: "timer", resumeAt: at }, now))
    .toBe(`Waiting until ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
  expect(activityStatus("PAUSED", { waitingOn: "timer" }, now)).toBe("Waiting");
  expect(activityStatus("PAUSED", { waitingOn: "other" }, now)).toBe("Waiting");
  expect(runActivityItems([run({ status: "PAUSED", waitingOn: "timer", resumeAt: at })], now)[0]?.detail).toContain("Waiting until");
});
