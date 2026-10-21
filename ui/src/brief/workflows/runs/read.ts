import type { BriefReadState } from "../../contracts";
import {
  validateDetail,
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
  Required<Pick<WorkflowRunsPort, "list" | "detail">> {
  const base = `/api/brief/workflows/${encodeURIComponent(scope.flowId)}`;
  async function read(url: string, signal: AbortSignal) {
    const res = await request(url, {
      credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
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
  };
}
