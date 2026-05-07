/**
 * HTTP routes for the workflow runtime.
 *
 * Mounted under `/api/workflows/*` and `/api/webhooks/:flowId`. The previous
 * in-house engine that owned these paths was deleted in the Phase 6 cutover.
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
import { cancelJob, enqueue, findActiveJobForRun } from "../db/repos/job-queue";
import type { TriggerManager } from "../runner/triggers/manager";
import type { JarvisPieceRegistry } from "../jarvis-pieces/types";

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

export interface CreateWorkflowRoutesOptions {
  /**
   * Optional trigger manager. When provided, every flow status / version
   * change calls `triggerManager.refresh(flowId)` so cron/webhook/event
   * subscriptions reconcile to the current state. Without it, mutations are
   * still persisted but triggers won't fire (manual `/run` still works).
   */
  triggerManager?: TriggerManager;
  /**
   * Optional Jarvis piece registry. When provided, `GET /api/workflows/pieces`
   * returns the list of registered Jarvis-native pieces (and their actions
   * and triggers) so the dashboard editor can render a piece picker. Without
   * it, the catalog endpoint returns an empty list.
   */
  pieceRegistry?: JarvisPieceRegistry;
}

/** Build the workflow route map. Side-effect-free; spread into the daemon's main route table. */
export function createWorkflowRoutes(opts: CreateWorkflowRoutesOptions = {}): WorkflowRouteMap {
  const refreshTrigger = (flowId: string): void => {
    if (opts.triggerManager) {
      try {
        opts.triggerManager.refresh(flowId);
      } catch (e) {
        // Trigger management must never destabilize the API. Log and move on.
        console.warn(
          `[workflow-api] triggerManager.refresh(${flowId}) failed: ${(e as Error).message}`,
        );
      }
    }
  };
  return {
    // ----------------------------------------------------- piece catalog
    "/api/workflows/pieces": {
      GET: () =>
        trapErrors(() => {
          if (!opts.pieceRegistry) return ok([]);
          const list = opts.pieceRegistry.list().map((p) => ({
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            actions: Object.values(p.actions).map((a) => ({
              name: a.name,
              displayName: a.displayName,
              description: a.description,
              inputSchema: a.inputSchema ?? null,
            })),
            triggers: p.triggers
              ? Object.values(p.triggers).map((t) => ({
                  name: t.name,
                  displayName: t.displayName,
                  description: t.description,
                  inputSchema: t.inputSchema ?? null,
                }))
              : [],
          }));
          return ok(list);
        }),
    },

    // ------------------------------------------------------------------ flows
    "/api/workflows": {
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

    "/api/workflows/:id": {
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
          if (body.status !== undefined) refreshTrigger(id);
          const flow = getFlow(id);
          return flow ? ok(serializeFlow(flow)) : err("flow not found", 404);
        }),
      DELETE: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          deleteFlow(id);
          refreshTrigger(id);
          return ok({ ok: true });
        }),
    },

    // ----------------------------------------------------------------- versions
    "/api/workflows/:id/versions": {
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

    "/api/workflows/:id/versions/:versionId": {
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

    "/api/workflows/:id/versions/:versionId/lock": {
      POST: (req) =>
        trapErrors(() => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          return ok(lockVersion(versionId));
        }),
    },

    "/api/workflows/:id/publish": {
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
          refreshTrigger(id);
          const flow = getFlow(id);
          return flow ? ok({ flow: serializeFlow(flow), version: target }) : err("flow not found", 404);
        }),
    },

    // -------------------------------------------------------------------- runs
    "/api/workflows/:id/run": {
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

    "/api/workflows/:id/runs": {
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

    "/api/workflow-runs/:runId": {
      GET: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          return run ? ok(run) : err("run not found", 404);
        }),
    },

    // Webhook ingress. Path is /api/webhooks/:flowId.
    "/api/webhooks/:flowId": {
      POST: (req) =>
        trapErrors(async () => {
          if (!opts.triggerManager) return err("webhooks are not enabled in this build", 503);
          const { flowId } = (req as RequestWithParams<{ flowId: string }>).params;
          return opts.triggerManager.webhookManager().handleRequest(flowId, req);
        }),
      // Allow GET too -- some providers (Slack, GitHub URL verification) probe
      // with GET first. The webhook manager treats any method the same.
      GET: (req) =>
        trapErrors(async () => {
          if (!opts.triggerManager) return err("webhooks are not enabled in this build", 503);
          const { flowId } = (req as RequestWithParams<{ flowId: string }>).params;
          return opts.triggerManager.webhookManager().handleRequest(flowId, req);
        }),
    },

    "/api/workflow-runs/:runId/cancel": {
      POST: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          if (!run) return err("run not found", 404);
          // Cancel the queued/running job (if any). The worker observes the
          // canceled status and stops the run. Run-row state transitions
          // (e.g. STOPPED) are written by the worker, not here.
          const job = findActiveJobForRun(run.id);
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

function numParam(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
