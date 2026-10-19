import type { BriefViewPort } from "../../contracts";
import type { Flow, FlowRun } from "../../../v2/rooms/workflows/useWorkflowsData";

export interface RecentWorkflow {
  flowId: string; versionId: string; runId: string; name: string;
  status: string; result: string; at: number; environment: "PRODUCTION" | "TESTING";
}
export type RecentWorkflowBinding = BriefViewPort<readonly RecentWorkflow[]>;
const LABELS: Record<string, { label: string; tone: string; result: string }> = {
  SUCCEEDED: { label: "Completed", tone: "success", result: "Run completed" },
  FAILED: { label: "Failed", tone: "error", result: "Run failed" },
  RUNNING: { label: "Running", tone: "running", result: "Work in progress" },
  QUEUED: { label: "Queued", tone: "neutral", result: "Waiting to start" },
  PAUSED: { label: "Paused", tone: "attention", result: "Waiting for a signal" },
  STOPPED: { label: "Stopped", tone: "neutral", result: "Run stopped; earlier actions may have completed" },
  TIMEOUT: { label: "Timed out", tone: "error", result: "Run timed out" },
  INTERNAL_ERROR: { label: "Error", tone: "error", result: "Run could not finish" },
  QUOTA_EXCEEDED: { label: "Limit reached", tone: "error", result: "Run reached its quota" },
  MEMORY_LIMIT_EXCEEDED: { label: "Limit reached", tone: "error", result: "Run reached its memory limit" },
  SCHEDULE_FAILURE: { label: "Schedule failed", tone: "error", result: "Scheduled run could not start" },
};
export function runPresentation(status: string) { return LABELS[status] ?? { label: "Unknown", tone: "neutral", result: "Run status unavailable" }; }

/** Read-only projection of canonical records. Never turn flow activation into a
 * run outcome or interpret raw step output as a verified business result. */
export function projectRecentWorkflows(flows: readonly Pick<Flow, "id" | "displayName">[], runs: readonly Pick<FlowRun, "id" | "flowId" | "flowVersionId" | "status" | "startTime" | "created" | "environment">[], limit = 6): RecentWorkflow[] {
  const names = new Map(flows.map(flow => [flow.id, flow.displayName || flow.id]));
  const latest = new Map<string, RecentWorkflow>();
  for (const run of runs) {
    if (!names.has(run.flowId)) continue;
    const at = run.startTime ?? run.created;
    if (!Number.isFinite(at)) continue;
    const old = latest.get(run.flowId);
    if (!old || at > old.at || (at === old.at && run.id.localeCompare(old.runId) > 0)) latest.set(run.flowId, {
      flowId: run.flowId, versionId: run.flowVersionId, runId: run.id, name: names.get(run.flowId)!,
      status: run.status, result: runPresentation(run.status).result, at, environment: run.environment,
    });
  }
  return [...latest.values()].sort((a,b) => b.at - a.at || a.runId.localeCompare(b.runId)).slice(0, Math.max(0, limit));
}
