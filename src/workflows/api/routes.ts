/**
 * HTTP routes for the new workflow runtime (Phase 2 step 13).
 *
 * Mounted under `/api/v2/workflows/*` so they coexist with the legacy
 * `/api/workflows/*` routes during the build-out. The legacy engine and its
 * routes are deleted at Phase 6 (cutover); at that point we can rename the v2
 * paths to drop the prefix.
 *
 * Route map shape matches the rest of the daemon (`Record<string, { GET?, POST?, ... }>`)
 * so it can be spread into `createApiRoutes()` without touching its internals.
 *
 * Notes on what these routes do NOT do:
 *   - No handler-side authn/authz: Jarvis is single-tenant, the dashboard is
 *     CORS-bound to localhost, and the existing daemon routes have the same
 *     posture. Adding auth here would diverge from the rest.
 *   - The `run` endpoint enqueues a job; it does not block on the engine.
 *     Engine spawning is a worker-side concern (Phase 2 follow-up).
 *
 * Each handler operates on the workflow DB initialized via `initWorkflowDb()`.
 * If the DB is not initialized, route handlers throw at first DB call; the
 * framework's catch-all returns 500. The daemon bootstrap must call
 * `initWorkflowDb(...)` before routes serve traffic.
 */

import {
  createFlow,
  deleteFlow,
  getFlow,
  listFlows,
  parseFlowMetadata,
  setPublishedVersion,
  updateFlowMetadata,
  updateFlowStatus,
  type FlowStatus,
} from "../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  getLatestDraft,
  listVersions,
  lockVersion,
  updateDraftVersion,
} from "../db/repos/flow-version";
import {
  createFlowRun,
  getFlowRun,
  listRuns,
  type FlowRunStatus,
  type RunEnvironment,
} from "../db/repos/flow-run";
import { cancelJob, enqueue, getJob } from "../db/repos/job-queue";

type RequestWithParams<P extends Record<string, string> = Record<string, string>> = Request & {
  params: P;
};

/** A request that may carry route params -- the daemon's Bun.serve attaches `params` for parameterized paths. */
type RouteRequest = Request & { params?: Record<string, string> };
type RouteHandler = (req: RouteRequest) => Promise<Response> | Response;

interface RouteMethods {
  GET?: RouteHandler;
  POST?: RouteHandler;
  PATCH?: RouteHandler;
  DELETE?: RouteHandler;
}

export type WorkflowRouteMap = Record<string, RouteMethods>;

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const err = (message: string, status = 400): Response =>
  ok({ error: message }, status);

const trapErrors = async (fn: () => Promise<Response> | Response): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return err(msg, 404);
    return err(msg, 500);
  }
};

const isStatus = (v: unknown): v is FlowStatus => v === "ENABLED" || v === "DISABLED";

/** Build the workflow route map. Side-effect-free; spread into the daemon's main route table. */
export function createWorkflowRoutes(): WorkflowRouteMap {
  return {
    // ------------------------------------------------------------------ flows
    "/api/v2/workflows": {
      GET: (req) =>
        trapErrors(() => {
          const params = new URL(req.url).searchParams;
          const status = params.get("status");
          const limit = numParam(params.get("limit")) ?? 100;
          const offset = numParam(params.get("offset")) ?? 0;
          const opts: { status?: FlowStatus; limit: number; offset: number } = { limit, offset };
          if (status !== null) {
            if (!isStatus(status)) return err(`status must be ENABLED|DISABLED`, 400);
            opts.status = status;
          }
          const flows = listFlows(undefined, opts);
          return ok(flows.map(serializeFlow));
        }),
      POST: (req) =>
        trapErrors(async () => {
          const body = (await req.json()) as {
            displayName?: string;
            externalId?: string;
            metadata?: Record<string, unknown> | null;
          };
          if (!body.displayName || typeof body.displayName !== "string") {
            return err("displayName is required");
          }
          const flow = createFlow({
            externalId: body.externalId,
            metadata: body.metadata ?? null,
          });
          const version = createDraftVersion({
            flowId: flow.id,
            displayName: body.displayName,
          });
          return ok({ flow: serializeFlow(flow), version }, 201);
        }),
    },

    "/api/v2/workflows/:id": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const flow = getFlow(id);
          if (!flow) return err("flow not found", 404);
          const draft = getLatestDraft(id);
          const published = flow.published_version_id
            ? getFlowVersion(flow.published_version_id)
            : null;
          return ok({ flow: serializeFlow(flow), latestDraft: draft, published });
        }),
      PATCH: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const body = (await req.json()) as {
            status?: FlowStatus;
            metadata?: Record<string, unknown> | null;
          };
          if (body.status !== undefined) {
            if (!isStatus(body.status)) return err("status must be ENABLED|DISABLED");
            updateFlowStatus(id, body.status);
          }
          if (body.metadata !== undefined) {
            updateFlowMetadata(id, body.metadata);
          }
          const flow = getFlow(id);
          return flow ? ok(serializeFlow(flow)) : err("flow not found", 404);
        }),
      DELETE: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          deleteFlow(id);
          return ok({ ok: true });
        }),
    },

    // ----------------------------------------------------------------- versions
    "/api/v2/workflows/:id/versions": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          return ok(listVersions(id));
        }),
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const body = (await req.json()) as {
            displayName?: string;
            trigger?: Record<string, unknown>;
          };
          if (!body.displayName) return err("displayName is required");
          const version = createDraftVersion({
            flowId: id,
            displayName: body.displayName,
            trigger: body.trigger,
          });
          return ok(version, 201);
        }),
    },

    "/api/v2/workflows/:id/versions/:versionId": {
      GET: (req) =>
        trapErrors(() => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          const v = getFlowVersion(versionId);
          return v ? ok(v) : err("version not found", 404);
        }),
      PATCH: (req) =>
        trapErrors(async () => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          const body = (await req.json()) as {
            displayName?: string;
            trigger?: Record<string, unknown>;
            valid?: boolean;
            connectionIds?: string[];
            agentIds?: string[];
          };
          const v = updateDraftVersion(versionId, body);
          return ok(v);
        }),
    },

    "/api/v2/workflows/:id/versions/:versionId/lock": {
      POST: (req) =>
        trapErrors(() => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          return ok(lockVersion(versionId));
        }),
    },

    "/api/v2/workflows/:id/publish": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          // Default semantic: lock the latest draft and set it as published.
          // Body can override with `{ versionId }` for explicit selection.
          let versionId: string | undefined;
          try {
            const body = (await req.json()) as { versionId?: string };
            versionId = body.versionId;
          } catch {
            /* empty body is fine */
          }
          let target = versionId ? getFlowVersion(versionId) : getLatestDraft(id);
          if (!target) return err("no draft version to publish", 400);
          if (target.state !== "LOCKED") target = lockVersion(target.id);
          setPublishedVersion(id, target.id);
          updateFlowStatus(id, "ENABLED");
          const flow = getFlow(id);
          return flow ? ok({ flow: serializeFlow(flow), version: target }) : err("flow not found", 404);
        }),
    },

    // -------------------------------------------------------------------- runs
    "/api/v2/workflows/:id/run": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const flow = getFlow(id);
          if (!flow) return err("flow not found", 404);
          const body = (await req
            .json()
            .catch(() => ({}))) as {
            environment?: RunEnvironment;
            triggeredBy?: string;
            stepNameToTest?: string;
            payload?: Record<string, unknown>;
          };
          // Prefer published version; fall back to latest draft for testing.
          const versionId =
            flow.published_version_id ?? getLatestDraft(id)?.id ?? null;
          if (!versionId) return err("flow has no published or draft version", 400);

          const run = createFlowRun({
            flowId: id,
            flowVersionId: versionId,
            environment: body.environment ?? "PRODUCTION",
            triggeredBy: body.triggeredBy,
            stepNameToTest: body.stepNameToTest,
            startTime: Date.now(),
          });
          // The worker handler for RUN_FLOW (engine spawn) lands in a follow-up
          // commit. This route's contract: persist the run row and queue the
          // job; the job carries enough context for the worker to dispatch.
          enqueue({
            jobType: "RUN_FLOW",
            payload: { runId: run.id, payload: body.payload ?? {} },
            flowRunId: run.id,
            flowId: id,
            flowVersionId: versionId,
          });
          return ok(run, 202);
        }),
    },

    "/api/v2/workflows/:id/runs": {
      GET: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const params = new URL(req.url).searchParams;
          const status = params.get("status") as FlowRunStatus | null;
          const limit = numParam(params.get("limit")) ?? 50;
          const offset = numParam(params.get("offset")) ?? 0;
          const opts: { flowId: string; status?: FlowRunStatus; limit: number; offset: number } = {
            flowId: id,
            limit,
            offset,
          };
          if (status) opts.status = status;
          return ok(listRuns(opts));
        }),
    },

    "/api/v2/workflow-runs/:runId": {
      GET: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          return run ? ok(run) : err("run not found", 404);
        }),
    },

    "/api/v2/workflow-runs/:runId/cancel": {
      POST: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          if (!run) return err("run not found", 404);
          // Cancel the queued job (if any) and surface STOPPED on the run row.
          // Run-row update is intentionally minimal here; the worker will
          // observe the canceled job and won't pick it up.
          const job = run.id ? findJobForRun(run.id) : null;
          if (job) cancelJob(job.id);
          return ok({ ok: true, jobCanceled: !!job });
        }),
    },
  };
}

/**
 * Surface representation of a flow row for the API. Parses metadata JSON and
 * presents booleans where the row uses 0/1.
 */
function serializeFlow(row: ReturnType<typeof getFlow> | NonNullable<ReturnType<typeof getFlow>>) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    projectId: row.project_id,
    status: row.status,
    publishedVersionId: row.published_version_id,
    metadata: parseFlowMetadata(row),
    created: row.created,
    updated: row.updated,
  };
}

/** Best-effort lookup of the queue entry that maps to a run. */
function findJobForRun(runId: string) {
  // workflow_job is keyed by its own id; we filter via flow_run_id at the SQL
  // level by reading rows. For one-flow-run -> one-job (the typical shape) we
  // can synthesize a query off the indexed column.
  const { getWorkflowDb } = require("../db/index") as typeof import("../db/index");
  const row = getWorkflowDb()
    .query<{ id: string }, [string]>(
      `SELECT id FROM workflow_job WHERE flow_run_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created DESC LIMIT 1`,
    )
    .get(runId);
  return row ? getJob(row.id) : null;
}

function numParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
