import type { BriefReadState } from "../../contracts";
import type { RecentWorkflow } from "../../workflows/recent-rows/model";
import type { RecentActivityItem } from "./RecentActivity";

export const ACTIVITY_LIMIT = 5;

/** Plain-language run status for Today. Unknown statuses never read as success. */
export function activityStatus(status: string, wait?: Pick<RecentWorkflow, "waitingOn" | "resumeAt">, now = Date.now()): string {
  switch (status) {
    case "SUCCEEDED": return "Done";
    // Only a run waiting on a person says "for you". A timer or system wait does not.
    case "PAUSED":
      if (wait?.waitingOn === "person") return "Waiting for you";
      if (wait?.waitingOn === "timer" && wait.resumeAt !== undefined) return `Waiting until ${timeLabel(wait.resumeAt, now)}`;
      return "Waiting";
    case "RUNNING": return "Running";
    // Not started yet, so not "Running" (the Workflows room says Queued too).
    case "QUEUED": return "Queued";
    case "STOPPED": return "Stopped";
    case "FAILED": case "TIMEOUT": case "INTERNAL_ERROR": case "QUOTA_EXCEEDED": case "MEMORY_LIMIT_EXCEEDED": case "SCHEDULE_FAILURE": return "Failed";
    default: return "Status unknown";
  }
}

function timeLabel(at: number, now: number): string {
  const date = new Date(at), today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString() ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Identity, status and time only. Captured step output is never part of a row. */
export function runActivityItems(runs: readonly RecentWorkflow[], now = Date.now()): RecentActivityItem[] {
  return runs.filter(run => run.environment === "PRODUCTION").map(run => ({
    activityId: `run:${run.runId}`, title: run.name, occurredAt: run.at, timeLabel: timeLabel(run.at, now),
    detail: activityStatus(run.status, run, now),
    destination: { room: "workflow" as const, selection: { flowId: run.flowId, versionId: run.versionId, runId: run.runId } },
  }));
}

/**
 * Workflow runs are the primary source. Verified outcomes add rows when they
 * exist but never decide whether the list is empty or unavailable.
 */
export function mergeActivity(runs: BriefReadState<readonly RecentWorkflow[]>, outcomes: BriefReadState<readonly RecentActivityItem[]>, now = Date.now()): BriefReadState<readonly RecentActivityItem[]> {
  const fromRuns = "data" in runs ? runActivityItems(runs.data, now) : [];
  const extra = "data" in outcomes ? outcomes.data : [];
  const seen = new Set(fromRuns.map(item => item.activityId));
  const data = [...fromRuns, ...extra.filter(item => !seen.has(item.activityId))]
    .sort((a, b) => b.occurredAt - a.occurredAt || a.activityId.localeCompare(b.activityId)).slice(0, ACTIVITY_LIMIT);
  if (runs.status === "loading") return { status: "loading" };
  if (runs.status === "unsupported") return data.length ? { status: "ready", data } : runs;
  if (runs.status === "unavailable") return data.length ? { status: "stale", data, reason: runs.reason } : runs;
  if (runs.status === "stale") return data.length ? { status: "stale", data, reason: runs.reason } : { status: "unavailable", reason: runs.reason };
  return data.length ? { status: "ready", data } : { status: "empty" };
}
