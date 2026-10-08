import { test, expect } from "bun:test";
import { goalPaths, measuredGoal } from "./fixtures";
import {
  goalValue,
  nextGoalRoute,
  validCollection,
  visibleGoals,
} from "./model";
import { FOLLOW_UP } from "../today/preview/fixtures";
import { progressBand } from "../today/outcomes/model";

test("zero-baseline counts use the same normalized band as Today", () => {
  const goal = goalPaths()[0]!.goal,
    result = goalValue(goal);
  expect(result.kind).toBe("measurement");
  expect(result.fraction).toBe(0.6);
  expect(progressBand(result.fraction!, 1)).toBe(progressBand(6, 10));
});
test("score-only titles never supply a numerator", () => {
  const goal = goalPaths()[0]!.goal;
  goal.measurement = null;
  goal.progress.basis = "legacy_score";
  expect(goalValue(goal)).toEqual({
    kind: "score",
    fraction: 0.6,
    label: "Score 60%",
  });
});
test("unknown and observed zero remain different", () => {
  const goal = measuredGoal("id", "Title", 0, 10, "partners");
  expect(goalValue(goal).kind).toBe("measurement");
  goal.progress = { value: null, basis: "unknown", rollup: "independent" };
  expect(goalValue(goal).kind).toBe("unknown");
});
test("nonzero and decreasing targets use canonical progress, with unmodified measurements", () => {
  const goal = measuredGoal("id", "Faster", 400, 100, "ms", "active", 1000);
  const result = goalValue(goal);
  expect(result.kind).toBe("measurement");
  expect(result.fraction).toBeCloseTo(2 / 3);
  if (result.kind === "measurement") {
    expect(result.ordinaryCount).toBe(false);
    expect(result.measurement.value).toBe(400);
    expect(result.measurement.target).toBe(100);
  }
});
test("missing provenance, invalid time or invalid fraction never render an evidenced count", () => {
  for (const corrupt of [
    (g: ReturnType<typeof measuredGoal>) => {
      g.measurement!.provenance = [];
    },
    (g: ReturnType<typeof measuredGoal>) => {
      g.measurement!.asOf = NaN;
    },
    (g: ReturnType<typeof measuredGoal>) => {
      g.progress.value = NaN;
    },
  ]) {
    const goal = goalPaths()[0]!.goal;
    corrupt(goal);
    expect(goalValue(goal).kind).toBe("unknown");
  }
});
test("completion status never forces score or measurement to 100 percent", () => {
  const goal = measuredGoal("id", "Completed", 4, 10, "steps", "completed");
  expect(goalValue(goal).fraction).toBe(0.4);
});
test("canonical statuses remain reachable, with no archive reinterpretation", () => {
  const rows = goalPaths();
  for (const status of [
    "active",
    "paused",
    "failed",
    "draft",
    "killed",
  ] as const)
    expect(
      visibleGoals(rows, "active", status).every(
        (x) => x.goal.status === status,
      ),
    ).toBe(true);
  expect(visibleGoals(rows, "active", "all")).toHaveLength(7);
  expect(visibleGoals(rows, "completed", "paused")).toHaveLength(2);
});
test("next action is the existing Today decision and only available on a current active goal", () => {
  const path = goalPaths()[0]!;
  expect(path.next!.decisionId).toBe(FOLLOW_UP.decision.decisionId);
  expect(nextGoalRoute(path, true)?.selection).toEqual({
    workItemId: FOLLOW_UP.decision.workItemId!,
    approvalId: FOLLOW_UP.decision.approval!.approvalId,
  });
  expect(nextGoalRoute(path, false)).toBeNull();
  path.goal.revision = "changed";
  expect(nextGoalRoute(path, true)).toBeNull();
  path.goal.revision = path.next!.goalRevision;
  path.goal.status = "paused";
  expect(nextGoalRoute(path, true)).toBeNull();
});
test("duplicate roots and duplicate path stages are rejected", () => {
  const rows = goalPaths();
  expect(validCollection(rows)).toBe(true);
  expect(validCollection([...rows, rows[0]!])).toBe(false);
  rows[0]!.stages = [...rows[0]!.stages, rows[0]!.stages[0]!];
  expect(validCollection(rows)).toBe(false);
});
