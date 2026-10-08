import type {
  BriefGoal,
  BriefMeasurement,
} from "../../../../src/brief/contracts";
import type { BriefReadState, BriefRoute } from "../contracts";
import { formatNumber, qualified } from "../today/outcomes/model";

/** F-15's additive read projection. No dependency on its unmerged implementation. */
export interface GoalDatum extends BriefGoal {
  title: string;
  pathLabel?: string;
  compactTitle?: string;
  caption?: string;
  progress: {
    value: number | null;
    basis: "measurement" | "legacy_score" | "unknown";
    rollup: "independent";
  };
}
export interface GoalPath {
  goal: GoalDatum;
  pathTitle: string;
  completion?: { at: number | null; summary: string; supportedBy?: string };
  /** An explicitly ordered path from the owner, never a sum of child measurements. */
  stages: readonly GoalDatum[];
  change?: { label: string; measurement: BriefMeasurement };
  next?: {
    goalRevision: string;
    decisionId: string;
    workItemId: string;
    approvalId?: string;
    title: string;
    context: string;
    label: string;
  };
}
export type GoalCollection = readonly GoalPath[];
export type GoalTab = "active" | "completed";
export const GOAL_STATUSES = [
  "active",
  "draft",
  "paused",
  "failed",
  "killed",
  "completed",
] as const;
export type GoalFilter = Exclude<GoalDatum["status"], "completed"> | "all";
export interface GoalsPort {
  source: "live" | "fixture";
  scopeId: string;
  /** Complete authorized roots and their explicit paths. Not the first page of a list. */
  read: () => Promise<BriefReadState<GoalCollection>>;
}
export function visibleGoals(
  rows: GoalCollection,
  tab: GoalTab,
  filter: GoalFilter,
) {
  return rows.filter(({ goal }) =>
    tab === "completed"
      ? goal.status === "completed"
      : goal.status !== "completed" &&
        (filter === "all" || goal.status === filter),
  );
}
export function validCollection(rows: GoalCollection): boolean {
  const ids = new Set<string>();
  return (
    Array.isArray(rows) &&
    rows.every((row) => {
      if (!row?.goal || ids.has(row.goal.goalId) || !Array.isArray(row.stages))
        return false;
      ids.add(row.goal.goalId);
      const stages = new Set<string>();
      return (
        [row.goal, ...row.stages].every(
          (g) =>
            !!g?.goalId &&
            !!g.revision &&
            !!g.title?.trim() &&
            GOAL_STATUSES.includes(g.status) &&
            !!g.progress &&
            g.progress.rollup === "independent",
        ) &&
        row.stages.every(
          (g: GoalDatum) => !stages.has(g.goalId) && !!stages.add(g.goalId),
        )
      );
    })
  );
}
/** Percent comes from the canonical projection, not raw value/target or a title. */
export function goalValue(goal: GoalDatum) {
  const p = goal.progress;
  const fraction =
    Number.isFinite(p.value) && p.value !== null && p.value >= 0 && p.value <= 1
      ? p.value
      : null;
  const measurement =
    p.basis === "measurement" && qualified(goal.measurement)
      ? goal.measurement
      : null;
  if (
    measurement &&
    measurement.target !== null &&
    Number.isFinite(measurement.target) &&
    measurement.baseline !== null &&
    Number.isFinite(measurement.baseline) &&
    measurement.target !== measurement.baseline &&
    fraction !== null
  ) {
    return {
      kind: "measurement" as const,
      measurement,
      fraction,
      ordinaryCount:
        measurement.baseline === 0 &&
        measurement.target > 0 &&
        measurement.value >= 0,
      label:
        measurement.baseline === 0 &&
        measurement.target > 0 &&
        measurement.value >= 0
          ? `${formatNumber(measurement.value)} / ${formatNumber(measurement.target)} ${measurement.unit}`
          : `${formatNumber(measurement.value)} ${measurement.unit}; target ${formatNumber(measurement.target)}`,
    };
  }
  if (p.basis === "legacy_score" && fraction !== null)
    return {
      kind: "score" as const,
      fraction,
      label: `Score ${formatNumber(Math.round(fraction * 1000) / 10)}%`,
    };
  return {
    kind: "unknown" as const,
    fraction: null,
    label: "Not measured yet",
  };
}
/** The caller supplies the same canonical decision/work identity used by Today. */
export function nextGoalRoute(
  path: GoalPath,
  fresh: boolean,
): BriefRoute | null {
  const next = path.next;
  if (
    !fresh ||
    path.goal.status !== "active" ||
    !next ||
    next.goalRevision !== path.goal.revision ||
    !next.decisionId ||
    !next.workItemId ||
    !next.title.trim() ||
    !next.label.trim()
  )
    return null;
  return {
    room: "needs-you",
    selection: {
      workItemId: next.workItemId,
      ...(next.approvalId ? { approvalId: next.approvalId } : {}),
    },
  };
}
