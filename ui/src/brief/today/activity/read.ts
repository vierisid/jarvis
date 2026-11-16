import type { RecentWorkflow } from "../../workflows/recent-rows/model";
import { ReadFailure, type Source } from "../../reconciliation/resource";
import type { GetJson } from "../../reconciliation/sources";

export const RECENT_RUNS_URL = "/api/workflow-runs/recent?limit=5";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * One bounded read of each workflow's latest production, top-level run (no test
 * runs, no step output). 'runs' is invalidated by workflow events, and the
 * client's regular polling covers the rest, so a run that finishes while Today
 * is open appears without a reload.
 */
export function recentRunsSource(get: GetJson): Source<readonly RecentWorkflow[]> {
  return { domains: ["runs", "today"], read: async signal => {
    const value = await get(RECENT_RUNS_URL, signal) as { items?: unknown } | null;
    if (!value || !Array.isArray(value.items)) throw new ReadFailure("invalid_snapshot");
    const data: RecentWorkflow[] = value.items.map((item: any) => {
      const at = item?.startTime ?? item?.created;
      if (!text(item?.runId) || !text(item.flowId) || !text(item.flowVersionId) || !text(item.status) || !Number.isFinite(at)) throw new ReadFailure("invalid_snapshot");
      // Identity, status and time only. Nothing else on the row is ever read.
      return { flowId: item.flowId, versionId: item.flowVersionId, runId: item.runId, name: text(item.name) ? item.name : item.flowId,
        status: item.status, result: "", at, environment: "PRODUCTION" as const,
        ...(item.status === "PAUSED" && ["person", "timer", "other"].includes(item.waitingOn) ? { waitingOn: item.waitingOn as "person" | "timer" | "other" } : {}),
        ...(item.status === "PAUSED" && item.waitingOn === "timer" && Number.isFinite(item.resumeAt) ? { resumeAt: item.resumeAt as number } : {}) };
    });
    return { data: data.length ? data : null, empty: !data.length, asOf: Date.now() };
  } };
}
