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
import {
  getWaitpoint,
  listWaitpointsByFlowRun,
  markWaitpointResumed,
} from "../db/repos/waitpoint";
import {
  deleteConnection,
  getConnection,
  listConnections,
  upsertConnection,
  type AppConnectionType,
} from "../db/repos/app-connection";
import type { CredentialResolver } from "../credentials/adapter";
import type { TriggerManager } from "../runner/triggers/manager";
import type { PieceLookup } from "../runtime/piece-catalog";

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
   * Optional piece catalog. Either the legacy `JarvisPieceRegistry` (during
   * the F-K transition) or an engine-extracted `PieceCatalog`. When
   * provided, `GET /api/workflows/pieces` returns the list of pieces (and
   * their actions and triggers) so the dashboard editor can render a piece
   * picker. Without it, the catalog endpoint returns an empty list.
   */
  pieceRegistry?: PieceLookup;
  /**
   * Optional credential resolver. When provided, the connections route can
   * report which `JarvisConnectionSource` adapters are registered (e.g.
   * `jarvis:google` is wired) so the dashboard's piece-side auth picker
   * can highlight reusable Jarvis-managed credentials. The repo-backed
   * `app_connection` rows work without it.
   */
  credentialResolver?: CredentialResolver;
}

/** Build the workflow route map. Side-effect-free; spread into the daemon's main route table. */
export function createWorkflowRoutes(opts: CreateWorkflowRoutesOptions = {}): WorkflowRouteMap {
  const refreshTrigger = (flowId: string): void => {
    if (!opts.triggerManager) return;
    // Fire-and-forget: API responses must not block on engine round-trips
    // that ON_ENABLE may now perform. Catch + log so an enable failure
    // doesn't escape as an unhandled rejection.
    void opts.triggerManager.refresh(flowId).catch((e) => {
      console.warn(
        `[workflow-api] triggerManager.refresh(${flowId}) failed: ${(e as Error).message}`,
      );
    });
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

    // ------------------------------------------------------------- trigger subs (admin)
    // Snapshot of TriggerManager's active subscriptions. Each entry carries
    // the kind (cron/webhook/event/engine) and an optional `warning` set when
    // the subscription is partially active (e.g. engine returned webhook
    // listeners but route routing is half-set-up). The dashboard's run-history
    // panel surfaces these so users can see which flows are misconfigured
    // even though their status reads ENABLED.
    "/api/workflows/triggers": {
      GET: () =>
        trapErrors(() => {
          if (!opts.triggerManager) return ok([]);
          return ok(opts.triggerManager.list());
        }),
    },

    // ------------------------------------------------------------- connections
    // CRUD over `app_connection` rows + a list of registered Jarvis
    // connection sources. Connection `value` is encrypted at rest
    // (AES-256-GCM via `app-connection` repo) and never returned to the
    // client -- only the metadata (id, externalId, type, displayName,
    // pieceName, etc.) ships out so the dashboard can show what's wired.
    "/api/workflows/connections": {
      GET: () =>
        trapErrors(() => {
          const list = listConnections().map((c) => ({
            id: c.id,
            externalId: c.externalId,
            displayName: c.displayName,
            type: c.type,
            scope: c.scope,
            status: c.status,
            pieceName: c.pieceName,
            pieceVersion: c.pieceVersion,
            ownerId: c.ownerId,
            preSelectForNewProjects: c.preSelectForNewProjects,
            created: c.created,
            updated: c.updated,
            // value intentionally omitted -- secrets stay server-side.
          }));
          const sources = (opts.credentialResolver?.list() ?? []).map((s) => ({
            id: s.id,
          }));
          return ok({ connections: list, jarvisSources: sources });
        }),
      POST: (req) =>
        trapErrors(async () => {
          const body = (await req.json()) as {
            externalId?: string;
            displayName?: string;
            type?: AppConnectionType;
            pieceName?: string;
            pieceVersion?: string;
            value?: Record<string, unknown>;
          };
          if (!body.externalId || typeof body.externalId !== "string") {
            return err("externalId is required");
          }
          if (!body.displayName || typeof body.displayName !== "string") {
            return err("displayName is required");
          }
          if (!body.type) return err("type is required");
          if (!body.pieceName || typeof body.pieceName !== "string") {
            return err("pieceName is required");
          }
          if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
            return err("value must be an object");
          }
          // Soft schema check per type. Catches the common mistake of saving
          // an OAUTH2 connection with no `access_token` (the piece would
          // later fail with a confusing "auth missing" at run time).
          const schemaError = validateConnectionValueShape(body.type, body.value);
          if (schemaError) return err(schemaError);
          const conn = upsertConnection({
            externalId: body.externalId,
            displayName: body.displayName,
            type: body.type,
            pieceName: body.pieceName,
            pieceVersion: body.pieceVersion ?? "0.0.0",
            value: body.value,
          });
          return ok(
            {
              id: conn.id,
              externalId: conn.externalId,
              displayName: conn.displayName,
              type: conn.type,
              pieceName: conn.pieceName,
              status: conn.status,
              created: conn.created,
            },
            201,
          );
        }),
    },

    "/api/workflows/connections/:id": {
      DELETE: (req) =>
        trapErrors(() => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const existing = getConnection(id);
          if (!existing) return err("connection not found", 404);
          deleteConnection(id);
          return ok({ id, deleted: true });
        }),
      // Update an existing connection in place. Used to rotate OAuth tokens
      // / API keys without the delete-then-recreate gap (during which any
      // in-flight run resolving the externalId would 404). Body accepts a
      // partial: `displayName`, `value` (full replacement), `status`. The
      // encrypted-at-rest layer wraps the updated `value` automatically.
      PATCH: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const existing = getConnection(id);
          if (!existing) return err("connection not found", 404);
          const body = (await req.json().catch(() => ({}))) as {
            displayName?: string;
            value?: Record<string, unknown>;
            status?: "ACTIVE" | "MISSING" | "ERROR";
          };
          if (
            body.value !== undefined &&
            (body.value === null || typeof body.value !== "object" || Array.isArray(body.value))
          ) {
            return err("value must be an object if provided");
          }
          if (
            body.displayName !== undefined &&
            (typeof body.displayName !== "string" || body.displayName.length === 0)
          ) {
            return err("displayName must be a non-empty string if provided");
          }
          const merged = upsertConnection({
            externalId: existing.externalId,
            displayName: body.displayName ?? existing.displayName,
            type: existing.type,
            pieceName: existing.pieceName,
            pieceVersion: existing.pieceVersion,
            value: body.value ?? existing.value,
            ...(body.status ? { status: body.status } : {}),
          });
          return ok({
            id: merged.id,
            externalId: merged.externalId,
            displayName: merged.displayName,
            type: merged.type,
            pieceName: merged.pieceName,
            status: merged.status,
            updated: merged.updated,
          });
        }),
    },

    // ------------------------------------------------------------- waitpoint resume
    // Public webhook URL for resuming a paused flow. The `resumeUrl` minted
    // by `POST /v1/waitpoints` (called by piece actions via
    // `context.run.createWaitpoint`) routes here. Hits enqueue
    // RUN_FLOW(executionType=RESUME) with the request body as resumePayload;
    // the engine wakes the paused run from the persisted execution state.
    //
    // Idempotent: a second hit with the same waitpoint id returns 410, so
    // a flaky external service that retries doesn't re-fire the run.
    //
    // Status guard: only `PAUSED` runs can be resumed. A waitpoint whose run
    // subsequently FAILED / TIMEOUT / STOPPED is unrecoverable -- returning
    // 409 here surfaces that to the resumer instead of letting the engine
    // reject the operation obscurely.
    "/api/webhooks/waitpoints/:id": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const wp = getWaitpoint(id);
          if (!wp) return err("waitpoint not found", 404);
          if (wp.resumedAt !== null) return err("waitpoint already resumed", 410);
          const run = getFlowRun(wp.flowRunId);
          if (!run) return err("waitpoint references a missing run", 410);
          if (run.status !== "PAUSED") {
            return err(
              `waitpoint cannot be resumed: run status is ${run.status} (expected PAUSED)`,
              409,
            );
          }
          // Body is the resumePayload delivered to the paused step. Tolerate
          // empty bodies and non-JSON payloads (some webhook senders POST
          // form-encoded or empty); fall back to {}.
          let resumePayload: Record<string, unknown> = {};
          try {
            const raw = await req.json();
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
              resumePayload = raw as Record<string, unknown>;
            }
          } catch {
            // Non-JSON or empty body -- use {} as the payload.
          }
          markWaitpointResumed(id);
          enqueue({
            jobType: "RUN_FLOW",
            payload: {
              runId: wp.flowRunId,
              executionType: "RESUME",
              resumePayload,
            },
            flowRunId: wp.flowRunId,
          });
          return ok({ runId: wp.flowRunId, waitpointId: id, resumed: true }, 202);
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
            payload: {
              runId: run.id,
              payload: body.payload ?? {},
              ...(body.stepNameToTest ? { stepNameToTest: body.stepNameToTest } : {}),
            },
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

    // Active waitpoints for a flow run. Used by the dashboard's paused-run
    // callout so it can surface real resume URLs ("POST to
    // /api/webhooks/waitpoints/<id>") instead of pointing at the steps JSON.
    "/api/workflow-runs/:runId/waitpoints": {
      GET: (req) =>
        trapErrors(() => {
          const { runId } = (req as RequestWithParams<{ runId: string }>).params;
          const run = getFlowRun(runId);
          if (!run) return err("run not found", 404);
          const waitpoints = listWaitpointsByFlowRun(runId, /* resumed */ false).map((wp) => ({
            id: wp.id,
            stepName: wp.stepName,
            type: wp.type,
            resumeDateTime: wp.resumeDateTime,
            created: wp.created,
            resumeUrl: `/api/webhooks/waitpoints/${wp.id}`,
          }));
          return ok({ runId, waitpoints });
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

/**
 * Soft validation: connection `value` must contain the fields a piece will
 * read for the given `type`. Returns an error message string on mismatch,
 * or null if the shape looks plausible. Catches user mistakes at the API
 * boundary instead of at flow-run time.
 *
 * `CUSTOM_AUTH` is intentionally permissive (per-piece schema; the engine
 * validates against the piece's auth.props at run time).
 */
function validateConnectionValueShape(
  type: AppConnectionType,
  value: Record<string, unknown>,
): string | null {
  const has = (key: string): boolean =>
    typeof value[key] === "string" && (value[key] as string).length > 0;
  switch (type) {
    case "OAUTH2":
    case "PLATFORM_OAUTH2":
    case "CLOUD_OAUTH2":
      if (!has("access_token")) return `${type}: value.access_token is required`;
      return null;
    case "BASIC_AUTH":
      if (!has("username") || !has("password"))
        return "BASIC_AUTH: value.username + value.password are required";
      return null;
    case "SECRET_TEXT":
      // Engine reads either `secret` or `value` depending on the piece;
      // accept both. Reject obvious empties.
      if (!has("secret") && !has("value"))
        return "SECRET_TEXT: value.secret (or value.value) is required";
      return null;
    case "CUSTOM_AUTH":
    case "NO_AUTH":
      return null;
    default:
      return null;
  }
}
