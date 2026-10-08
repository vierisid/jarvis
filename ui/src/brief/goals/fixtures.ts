import type { BriefReadState } from "../contracts";
import { FOLLOW_UP } from "../today/preview/fixtures";
import { GoalsController } from "./controller";
import type { GoalCollection, GoalDatum, GoalPath } from "./model";

export const GOALS_SCOPE = "fixture-d24-goals";
export const GOAL_EXAMPLES = [
  "ready",
  "score-only",
  "decreasing",
  "unknown",
  "long",
  "many",
  "loading",
  "empty",
  "stale",
  "unavailable",
  "unsupported",
] as const;
export type GoalExample = (typeof GOAL_EXAMPLES)[number];
export function measuredGoal(
  id: string,
  title: string,
  value: number,
  target: number,
  unit: string,
  status: GoalDatum["status"] = "active",
  baseline = 0,
): GoalDatum {
  const fraction = Math.max(
    0,
    Math.min(1, (value - baseline) / (target - baseline)),
  );
  return {
    goalId: id,
    revision: "fixture-v1",
    title,
    status,
    health: "on_track",
    score: fraction,
    progress: { value: fraction, basis: "measurement", rollup: "independent" },
    measurement: {
      value,
      target,
      unit,
      baseline,
      qualification: "user_reported",
      asOf: Date.parse("2026-10-08T08:30:00Z"),
      provenance: [
        { kind: "source", id: `fixture-ledger-${id}`, revision: "1" },
      ],
    },
  };
}
export function goalPaths(): GoalPath[] {
  const main = measuredGoal(
    "fixture-design-partners",
    "Win 10 design partners",
    6,
    10,
    "signed",
  );
  main.caption = "Signed and confirmed";
  main.compactTitle = "Design partners";
  main.pathLabel = "Design partners";
  const step = (
    id: string,
    title: string,
    value: number,
    target: number,
    unit: string,
    caption: string,
  ) => ({ ...measuredGoal(id, title, value, target, unit), caption });
  const simple = (goal: GoalDatum): GoalPath => ({
    goal,
    pathTitle: goal.title,
    stages: [goal],
  });
  return [
    {
      goal: main,
      pathTitle: "The path to 10 partners",
      stages: [
        step(
          "fixture-driver-0",
          "Qualified leads",
          24,
          30,
          "leads",
          "Find the right founders",
        ),
        step(
          "fixture-driver-1",
          "Pilot calls",
          12,
          20,
          "calls",
          "Agree on useful work",
        ),
        step(
          "fixture-driver-2",
          "Pilots started",
          8,
          10,
          "pilots",
          "Prove value in practice",
        ),
        main,
      ],
      change: {
        label: "this week",
        measurement: { ...main.measurement!, value: 2, target: null },
      },
      next: {
        goalRevision: main.revision,
        decisionId: FOLLOW_UP.decision.decisionId,
        workItemId: FOLLOW_UP.decision.workItemId!,
        approvalId: FOLLOW_UP.decision.approval!.approvalId,
        title: "Confirm Alex’s pilot date.",
        context: "Meeting follow-ups has the draft ready for you.",
        label: FOLLOW_UP.reviewLabel,
      },
    },
    simple(
      measuredGoal(
        "fixture-story",
        "Sharpen the product story",
        2,
        3,
        "milestones",
      ),
    ),
    simple(
      measuredGoal(
        "fixture-focus",
        "Protect time to build",
        3,
        5,
        "focus blocks",
      ),
    ),
    {
      goal: measuredGoal(
        "fixture-launch",
        "Get the first 4 pilots ready",
        4,
        4,
        "pilots ready",
        "completed",
      ),
      pathTitle: "Get the first 4 pilots ready",
      completion: {
        at: Date.parse("2026-09-23T12:00:00Z"),
        summary: "Four teams have a scope, an owner and a start date.",
        supportedBy: "Meeting follow-ups",
      },
      stages: [
        "Scope agreed",
        "Owners assigned",
        "Dates confirmed",
        "Kick-offs booked",
      ].map((title, i) =>
        measuredGoal(
          `fixture-pilot-milestone-${i}`,
          title,
          1,
          1,
          "milestone",
          "completed",
        ),
      ),
    },
    {
      goal: measuredGoal(
        "fixture-onboarding",
        "Follow up after every call",
        12,
        12,
        "followed up",
        "completed",
      ),
      pathTitle: "Follow up after every call",
      completion: {
        at: Date.parse("2026-09-26T12:00:00Z"),
        summary: "Every pilot call ended with a confirmed next step.",
        supportedBy: "Meeting follow-ups",
      },
      stages: ["Notes collected", "Drafts reviewed", "Follow-ups sent"].map(
        (title, i) =>
          measuredGoal(
            `fixture-followup-milestone-${i}`,
            title,
            1,
            1,
            "milestone",
            "completed",
          ),
      ),
    },
    simple(
      measuredGoal(
        "fixture-paused",
        "Explore a second market",
        2,
        8,
        "interviews",
        "paused",
      ),
    ),
    simple(
      measuredGoal(
        "fixture-failed",
        "Finish the autumn launch",
        3,
        6,
        "milestones",
        "failed",
      ),
    ),
    simple(
      measuredGoal(
        "fixture-draft",
        "Plan the next quarter",
        0,
        4,
        "milestones",
        "draft",
      ),
    ),
    simple(
      measuredGoal(
        "fixture-killed",
        "Evaluate the previous channel",
        1,
        5,
        "experiments",
        "killed",
      ),
    ),
  ];
}
export function makeGoalsFixture(example: GoalExample = "ready") {
  let rows = goalPaths();
  if (example === "score-only") {
    const goal = rows[0]!.goal;
    goal.measurement = null;
    goal.progress = {
      value: 0.6,
      basis: "legacy_score",
      rollup: "independent",
    };
    rows[0]!.stages = [goal];
  }
  if (example === "unknown") {
    const goal = rows[0]!.goal;
    goal.measurement = null;
    goal.progress = { value: null, basis: "unknown", rollup: "independent" };
    rows[0]!.stages = [goal];
  }
  if (example === "decreasing") {
    const goal = measuredGoal(
      "fixture-latency",
      "Reduce response time",
      400,
      100,
      "milliseconds",
      "active",
      1000,
    );
    rows[0] = { goal, pathTitle: "The path to faster replies", stages: [goal] };
  }
  if (example === "long") {
    rows[0]!.goal.title =
      "Win long-term design partnerships across the international founding teams";
    rows[0]!.stages[0]!.title =
      "Qualified founders across multiple business units and geographic regions";
    rows[0]!.stages[0]!.measurement!.unit =
      "founders with confirmed interest and an agreed problem";
  }
  if (example === "many")
    rows.push(
      ...Array.from({ length: 12 }, (_, i) => {
        const goal = measuredGoal(
          `fixture-extra-${i}`,
          `Partner programme ${i + 1}`,
          i,
          20,
          "conversations",
        );
        return { goal, pathTitle: goal.title, stages: [goal] };
      }),
    );
  const read = (): BriefReadState<GoalCollection> => {
    if (example === "loading" || example === "empty")
      return { status: example };
    if (example === "unsupported" || example === "unavailable")
      return {
        status: example,
        reason:
          "Goal measurements are not available in this illustrative example.",
      };
    const data = structuredClone(rows);
    return example === "stale"
      ? {
          status: "stale",
          data,
          reason: "Connection interrupted. Showing the last goal read.",
        }
      : { status: "ready", data };
  };
  return {
    controller: new GoalsController({
      source: "fixture",
      scopeId: GOALS_SCOPE,
      read: async () => read(),
    }),
    update: () => {
      const path = rows.find(
        (row) => row.goal.goalId === "fixture-design-partners",
      );
      const goal = path?.goal;
      if (
        goal?.measurement &&
        goal.measurement.baseline === 0 &&
        goal.measurement.target === 10
      ) {
        goal.measurement.value = 7;
        goal.measurement.asOf = Date.parse("2026-10-08T09:30:00Z");
        goal.measurement.provenance[0]!.revision = "2";
        goal.progress.value = 0.7;
        goal.score = 0.7;
        goal.revision = "fixture-v2";
        if (path!.next) path!.next!.goalRevision = goal.revision;
      }
    },
    reorder: () => {
      rows = [...rows].reverse();
    },
  };
}
