import type { BriefReadState } from "../../contracts";
import type { FlowRun, FlowRunStatus } from "../../../v2/rooms/workflows/useWorkflowsData";
import type { RunPage, RunScope, RunStatus, RunSummary, WorkflowRunsPort } from "./model";

export const RUN_PAGE_SIZE = 50;

const STATUS_OF: Record<FlowRunStatus, RunStatus> = {
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  SUCCEEDED: "succeeded",
  STOPPED: "cancelled",
  FAILED: "failed",
  TIMEOUT: "failed",
  INTERNAL_ERROR: "failed",
  QUOTA_EXCEEDED: "failed",
  MEMORY_LIMIT_EXCEEDED: "failed",
  SCHEDULE_FAILURE: "failed",
};

/** Identity, status and time only. Captured step output, `failedStep.errorMessage`
 * and trigger payloads are never copied: the inspection card gets its failure
 * wording from the typed failure projection (F-21), not from this row. */
export function projectRun(run: FlowRun, scope: RunScope): RunSummary {
  if (!run || typeof run.id !== "string" || !run.id || run.flowId !== scope.flowId
    || typeof run.flowVersionId !== "string" || !run.flowVersionId
    || !Object.hasOwn(STATUS_OF, run.status) || !Number.isFinite(run.created)
    || !(run.startTime === null || Number.isFinite(run.startTime)))
    throw Error("Invalid run");
  // A stop acknowledged while a call was in flight may still have taken effect.
  const status = run.status === "STOPPED" && run.cancellation?.inFlightMayHaveCompleted
    ? "uncertain" : STATUS_OF[run.status];
  return {
    scopeId: scope.scopeId, flowId: run.flowId, runId: run.id, versionId: run.flowVersionId,
    label: `${run.environment === "TESTING" ? "Test run" : "Run"} ${run.id.slice(-6)}`,
    status, startedAt: run.startTime, createdAt: run.created,
  };
}

/** `list` for a WorkflowRunsPort over `GET /api/workflows/:id/runs`, which answers one
 * `{ items, nextOffset }` page (#652). The cursor is that offset as a string. `request`
 * must be the host's authenticated, project-scoped request: a flow in another project
 * answers 404, which reads as unavailable, never as an empty history. */
export function readRunHistory(scope: RunScope,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch): WorkflowRunsPort["list"] {
  return async (cursor, signal): Promise<BriefReadState<RunPage>> => {
    if (cursor !== null && !/^(0|[1-9]\d{0,8})$/.test(cursor)) throw Error("Invalid run cursor");
    const offset = cursor === null ? 0 : Number(cursor);
    try {
      const res = await request(`/api/workflows/${encodeURIComponent(scope.flowId)}/runs?limit=${RUN_PAGE_SIZE}&offset=${offset}`,
        { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      if (!res.ok) return { status: "unavailable", reason: "Run history is unavailable." };
      const page = await res.json() as { items?: unknown; nextOffset?: unknown } | null;
      if (!page || !Array.isArray(page.items) || page.items.length > RUN_PAGE_SIZE
        || !(page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && (page.nextOffset as number) > offset)))
        throw Error("Invalid run page");
      const items = (page.items as FlowRun[]).map(run => projectRun(run, scope));
      if (!items.length && offset === 0) return { status: "empty" };
      return { status: "ready", data: { items, total: null, nextCursor: page.nextOffset === null ? null : String(page.nextOffset) } };
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: "unavailable", reason: "Run history is unavailable." };
    }
  };
}
