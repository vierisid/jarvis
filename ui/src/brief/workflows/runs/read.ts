import type { BriefReadState } from "../../contracts";
import {
  validateDetail,
  type ManualRunCheck,
  validatePage,
  type RunDetail,
  type RunPage,
  type RunScope,
  type RunSummary,
  type WorkflowRunsPort,
} from "./model";

type Request = (url: string, init?: RequestInit) => Promise<Response>;

/** Identity, status and time only, from a summary F-21 already projected. */
function summary(run: RunSummary): RunSummary {
  return {
    scopeId: run.scopeId, flowId: run.flowId, runId: run.runId, versionId: run.versionId,
    label: run.label, status: run.status, startedAt: run.startedAt, createdAt: run.createdAt,
  };
}

/** The read half of a WorkflowRunsPort over F-21's run history (#1100). F-21's keyset
 * reader owns Brief run history: `GET /api/brief/workflows/:flowId/runs[?cursor=]`
 * answers `{ status: "ready", data: { items, nextCursor, total: null } }`, at most 50
 * per page, newest first, and the cursor is opaque. `detail` is F-21's redacted run
 * inspection. `request` must be the host's authenticated request: F-21 scopes every
 * read to the daemon's project, so a flow in another project answers 404, which reads
 * as unavailable, never as an empty history. */
export function briefRunsPort(scope: RunScope, request: Request = fetch):
  Required<Pick<WorkflowRunsPort, "list" | "detail" | "reconcile">> {
  const base = `/api/brief/workflows/${encodeURIComponent(scope.flowId)}`;
  const get = (url: string, signal: AbortSignal) => request(url, {
    credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  async function read(url: string, signal: AbortSignal) {
    const res = await get(url, signal);
    const body = res.ok ? await res.json() as { status?: unknown; data?: unknown } | null : null;
    if (!body || body.status !== "ready") throw Error("Unavailable");
    return body.data;
  }
  return {
    async list(cursor, signal): Promise<BriefReadState<RunPage>> {
      try {
        const page = validatePage(await read(cursor === null ? `${base}/runs`
          : `${base}/runs?cursor=${encodeURIComponent(cursor)}`, signal) as RunPage, scope);
        if (!page.items.length && cursor === null) return { status: "empty" };
        return { status: "ready", data: { items: page.items.map(summary), nextCursor: page.nextCursor, total: page.total } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "unavailable", reason: "Run history is unavailable." };
      }
    },
    async detail(runId, signal): Promise<BriefReadState<RunDetail>> {
      try {
        const data = await read(`${base}/runs/${encodeURIComponent(runId)}`, signal) as RunDetail;
        return { status: "ready", data: validateDetail(data, scope, runId) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "unavailable", reason: "The selected run could not be loaded." };
      }
    },
    /** #1093: F-21's accepted-request receipt, `GET .../run-requests/:requestId`. It is
     * written in the same transaction as the run, so its absence (404 `not_found`) means
     * no run has been accepted under this ID. Any other answer rejects: the request stays
     * uncertain. Read-only; it never enqueues or re-sends anything. */
    async reconcile(manual, signal): Promise<ManualRunCheck> {
      const res = await get(`${base}/run-requests/${encodeURIComponent(manual.requestId)}`, signal);
      const body = await res.json().catch(() => null) as
        { status?: unknown; code?: unknown; requestId?: unknown; run?: RunSummary } | null;
      if (res.status === 404 && body?.code === "not_found")
        return { status: "not_recorded", requestId: manual.requestId };
      if (!res.ok || body?.status !== "accepted" || body.requestId !== manual.requestId || !body.run)
        throw Error("Unconfirmed run request");
      return { status: "accepted", requestId: manual.requestId, run: summary(body.run) };
    },
  };
}
