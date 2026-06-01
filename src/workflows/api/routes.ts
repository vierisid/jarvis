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
  replaceSampleData,
  setSampleDataEntry,
  setSampleInputEntry,
  updateDraftVersion,
} from "../db/repos/flow-version";
import {
  getFlowVersionUiMeta,
  upsertFlowVersionUiMeta,
  type FlowVersionUiMeta,
} from "../db/repos/flow-version-ui-meta";
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
import { CATALOG, findCatalogEntry } from "../pieces-library/catalog";
import {
  installPiece,
  readManifest,
  uninstallPiece,
  type InstalledPiece,
} from "../pieces-library/installer";

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

/**
 * Per-step sample-data entry size cap, in bytes of serialized JSON. 256KB.
 * Big enough for typical fixtures (Gmail message, Notion page block) and
 * small enough that 100 entries still fit under SQLite's default 1MB TEXT
 * limit comfortably with room for the map's JSON overhead.
 */
const SAMPLE_DATA_ENTRY_MAX_BYTES = 256 * 1024;

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
  /**
   * Callback fired after a successful install/uninstall through the Library
   * routes. The daemon wires this to extract metadata for the new piece via
   * the engine and upsert it into the running `PieceCatalog`, so the flow
   * editor sees the piece immediately without a daemon restart.
   *
   * When omitted, install/uninstall still mutate `~/.jarvis/pieces/` and the
   * manifest, but the in-memory catalog won't reflect the change until next
   * daemon start (the reconciler picks it up at bootstrap).
   */
  onPieceLibraryChanged?: (event: {
    kind: "installed" | "uninstalled";
    piece: InstalledPiece;
  }) => Promise<void>;
  /**
   * Optional read-side accessor for `WorkflowEventBuffer.dropped()`. When
   * provided, the triggers list endpoint reports the buffer's overflow
   * counter so operators can see when on-event polling triggers might have
   * missed events past the 10k window.
   */
  getEventBufferDropped?: () => {
    count: number;
    lastDroppedAt: number;
    lastDroppedHeadId: number;
  };
}

/**
 * In-process mutex for the Library routes. Two concurrent installs would
 * race on the shared `~/.jarvis/pieces/package.json` + bun-install
 * invocation; we serialize them at the route boundary. One daemon, one
 * writer.
 */
let libraryMutex: Promise<void> = Promise.resolve();
function withLibraryLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = libraryMutex.then(() => fn());
  libraryMutex = release.then(
    () => undefined,
    () => undefined,
  );
  return release;
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
            // Piece-level auth declaration -- when present, the editor
            // renders a connection picker so the user picks an
            // existing connection instead of re-entering credentials.
            ...(p.auth ? { auth: p.auth } : {}),
            actions: Object.values(p.actions).map((a) => ({
              name: a.name,
              displayName: a.displayName,
              description: a.description,
              inputSchema: a.inputSchema ?? null,
              // Optional declared output sample (Jarvis extension to AP).
              // Surfaced to the dashboard so the variable picker can show
              // field-level rows for actions that have never been run yet.
              ...(a.outputSample !== undefined ? { outputSample: a.outputSample } : {}),
            })),
            triggers: p.triggers
              ? Object.values(p.triggers).map((t) => ({
                  name: t.name,
                  displayName: t.displayName,
                  description: t.description,
                  inputSchema: t.inputSchema ?? null,
                  // Triggers carry the upstream-native `sampleData`.
                  ...(t.sampleData !== undefined ? { sampleData: t.sampleData } : {}),
                  // And, for symmetry / future-proofing, the action-side
                  // `outputSample` if a trigger author chose to declare both.
                  ...(t.outputSample !== undefined ? { outputSample: t.outputSample } : {}),
                  // Dynamic-output triggers (jarvis-trigger:on_event):
                  // forward the per-input-value sample map so the editor's
                  // variable picker can resolve the right shape for the
                  // configured value (e.g. payload.content for clipboard,
                  // payload.snippet for email).
                  ...(t.dynamicSampleData !== undefined
                    ? { dynamicSampleData: t.dynamicSampleData }
                    : {}),
                }))
              : [],
          }));
          return ok(list);
        }),
    },

    // ------------------------------------------------------------- pieces library
    // The Library tab in the dashboard renders this list. Each entry is a
    // *curated* (Jarvis-vetted) community piece the user can opt into
    // installing. Installed pieces are merged in with their resolved
    // version + install timestamp so the UI can show "Installed" /
    // "Update available" badges.
    //
    // Install / uninstall mutate `~/.jarvis/pieces/` (manifest + bun
    // install). They block until bun finishes -- typical first install of a
    // single piece is 3-8s end to end. The UI shows a spinner during the
    // wait. A `withLibraryLock` mutex serializes concurrent requests so a
    // second install doesn't race the first one's bun-install.
    "/api/workflows/pieces/library": {
      GET: () =>
        trapErrors(async () => {
          const manifest = await readManifest();
          const installedById = new Map(
            manifest.pieces.map((p) => [p.id, p]),
          );
          const entries = CATALOG.map((entry) => {
            const installed = installedById.get(entry.id) ?? null;
            return {
              id: entry.id,
              npmPackage: entry.npmPackage,
              versionRange: entry.versionRange,
              displayName: entry.displayName,
              description: entry.description,
              iconUrl: entry.iconUrl ?? null,
              vettedVersion: entry.vettedVersion,
              vettedAt: entry.vettedAt ?? null,
              sourceUrl: entry.sourceUrl,
              licenseSpdx: entry.licenseSpdx,
              estimatedSizeMb: entry.estimatedSizeMb ?? null,
              tier: entry.tier,
              installed: installed
                ? {
                    resolvedVersion: installed.resolvedVersion,
                    installedAt: installed.installedAt,
                  }
                : null,
            };
          });
          return ok({ entries });
        }),
    },

    "/api/workflows/pieces/library/:id/install": {
      POST: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          const entry = findCatalogEntry(id);
          if (!entry) return err(`unknown piece id "${id}"`, 404);
          const result = await withLibraryLock(() => installPiece(id));
          if (opts.onPieceLibraryChanged) {
            try {
              await opts.onPieceLibraryChanged({
                kind: "installed",
                piece: result.piece,
              });
            } catch (e) {
              // Install on disk succeeded; catalog refresh failed. Surface
              // a partial-success marker so the UI can warn the user that
              // a daemon restart is needed for the piece to appear in the
              // flow editor's picker.
              return ok(
                {
                  installed: true,
                  catalogRefreshFailed: true,
                  catalogRefreshError: (e as Error).message,
                  piece: result.piece,
                },
                200,
              );
            }
          }
          return ok({ installed: true, piece: result.piece }, 200);
        }),
    },

    "/api/workflows/pieces/library/:id": {
      DELETE: (req) =>
        trapErrors(async () => {
          const { id } = (req as RequestWithParams<{ id: string }>).params;
          // Check the manifest BEFORE the catalog. A piece can legitimately
          // be installed but not in the catalog -- we yank entries from the
          // catalog when security advisories drop, and users with the piece
          // already installed need to be able to uninstall. Failing the
          // request because the catalog forgot the piece would strand them.
          const manifest = await readManifest();
          const target = manifest.pieces.find((p) => p.id === id);
          if (!target) {
            // Neither installed nor (necessarily) in the catalog. Return a
            // 404 only when both are absent -- a soft "nothing to do" 200
            // for an idempotent uninstall of something that was never
            // installed would mask user typos.
            if (!findCatalogEntry(id)) {
              return err(`unknown piece id "${id}"`, 404);
            }
            // In-catalog but not installed: idempotent no-op.
            return ok({ uninstalled: true, alreadyAbsent: true });
          }
          await withLibraryLock(() => uninstallPiece(id));
          if (opts.onPieceLibraryChanged) {
            try {
              await opts.onPieceLibraryChanged({
                kind: "uninstalled",
                piece: target,
              });
            } catch {
              // Catalog cleanup failure isn't fatal -- the piece is gone
              // from disk; on next daemon restart it falls out of the
              // catalog naturally.
            }
          }
          return ok({ uninstalled: true });
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

    // Event-buffer overflow signal for the `jarvis-trigger:on_event`
    // polling path. Returns the buffer's running drop counter so operators
    // can see when events may have been evicted past the capacity/age
    // window between two polls. `count > 0` is a warning condition; the
    // dashboard renders a banner. Returns nulls when the daemon hasn't
    // wired the read accessor.
    "/api/workflows/events/buffer-stats": {
      GET: () =>
        trapErrors(() => {
          if (!opts.getEventBufferDropped) {
            return ok({ count: 0, lastDroppedAt: 0, lastDroppedHeadId: 0 });
          }
          return ok(opts.getEventBufferDropped());
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
          // Apply the same per-type schema check POST runs. Type can't change
          // via PATCH (rotation, not re-creation), so we use existing.type.
          // Without this, a rotation could save an OAUTH2 connection with no
          // access_token that POST would have rejected.
          if (body.value !== undefined) {
            const schemaError = validateConnectionValueShape(existing.type, body.value);
            if (schemaError) return err(schemaError);
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
            // RESUME jobs especially shouldn't retry: re-resuming an
            // already-resumed waitpoint would walk past it with stale
            // payload state. One shot per webhook hit.
            maxAttempts: 1,
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
            // Seed an EMPTY (manual) trigger so the visual editor has a valid
            // FlowStepNode to render on a freshly created flow. Without this
            // the trigger defaults to `{}`, which the editor can't traverse
            // and the engine can't run. Users morph to PIECE_TRIGGER inside
            // the editor when they pick a real trigger.
            trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" },
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
          // Sidecar layout / orphan list for whichever version the editor
          // will mount (draft preferred, falls back to published). The
          // editor calls this once on open so it can lay out nodes at the
          // positions the user left them.
          const editableId = draft?.id ?? published?.id ?? null;
          const uiMeta = editableId ? getFlowVersionUiMeta(editableId) : null;
          return ok({
            flow: serializeFlow(flow),
            latestDraft: draft,
            published,
            uiMeta,
          });
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
            uiMeta?: FlowVersionUiMeta;
          };
          if (!body.displayName) return err("displayName is required");
          const version = createDraftVersion({
            flowId: id,
            displayName: body.displayName,
            trigger: body.trigger,
          });
          if (body.uiMeta) upsertFlowVersionUiMeta(version.id, body.uiMeta);
          return ok(version, 201);
        }),
    },

    "/api/workflows/:id/versions/:versionId": {
      GET: (req) =>
        trapErrors(() => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          const v = getFlowVersion(versionId);
          if (!v) return err("version not found", 404);
          return ok({ ...v, uiMeta: getFlowVersionUiMeta(versionId) });
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
            uiMeta?: FlowVersionUiMeta;
          };
          const { uiMeta, ...versionPatch } = body;
          const v = updateDraftVersion(versionId, versionPatch);
          // Sidecar write goes after the version update so a failed version
          // update doesn't leave a half-orphan sidecar pointing at stale
          // step names. The editor sends both together; either both land or
          // neither does.
          if (uiMeta) upsertFlowVersionUiMeta(versionId, uiMeta);
          return ok(v);
        }),
    },

    "/api/workflows/:id/versions/:versionId/lock": {
      POST: (req) =>
        trapErrors(() => {
          const { versionId } = (req as RequestWithParams<{ id: string; versionId: string }>).params;
          // Lock mutates the same row state DRAFT -> LOCKED, so the sidecar
          // (keyed on versionId) already follows. No copy needed; mentioned
          // here so future readers know that's by design.
          return ok(lockVersion(versionId));
        }),
    },

    // ------------------------------------------------- per-version sample data
    // The version's `sampleData` map (stepName -> output) feeds the engine's
    // "test from here" path so a step's preceding outputs resolve without
    // re-running the chain. Editable per-step via this PATCH; the entire map
    // can be replaced or cleared via the PUT below.
    //
    // DRAFT-only: locked versions are immutable to user edits. The repo
    // enforces; the route just surfaces errors with a clear message.
    "/api/workflows/:id/versions/:versionId/sample-data/:stepName": {
      PATCH: (req) =>
        trapErrors(async () => {
          const { versionId, stepName } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const body = (await req.json().catch(() => ({}))) as { output?: unknown };
          // `output: null` clears the entry; `output: undefined` (missing
          // key) is the same as null. Anything else stores as the entry.
          const output = body.output === undefined ? null : body.output;
          // Soft cap: each step's serialized sample output. Prevents a typo
          // (or a pasted log dump) from bloating flow_version.sample_data
          // into multi-MB JSON we'd parse on every read. 256KB per entry is
          // enough for realistic test payloads (e.g., a Gmail message body)
          // and small enough to keep DB reads fast.
          if (output !== null) {
            const serialized = JSON.stringify(output);
            if (serialized.length > SAMPLE_DATA_ENTRY_MAX_BYTES) {
              return err(
                `sample output for "${stepName}" exceeds ${SAMPLE_DATA_ENTRY_MAX_BYTES} bytes (got ${serialized.length}); store large fixtures elsewhere and reference them by id`,
                413,
              );
            }
          }
          const v = setSampleDataEntry(versionId, stepName, output);
          return ok({ versionId: v.id, sampleData: v.sampleData });
        }),
      DELETE: (req) =>
        trapErrors(() => {
          // Clear all sample-data entries on this version. Sugar over the
          // per-step PATCH with null when the UI's "reset all" action fires.
          const { versionId } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const v = replaceSampleData(versionId, null);
          return ok({ versionId: v.id, sampleData: v.sampleData });
        }),
    },

    // Per-step sample INPUT (override applied during test-from-here runs).
    // Mirror of sample-data above but writes to the `sample_input`
    // column. Same DRAFT-only semantic and per-entry size cap.
    "/api/workflows/:id/versions/:versionId/sample-input/:stepName": {
      PATCH: (req) =>
        trapErrors(async () => {
          const { versionId, stepName } = (
            req as RequestWithParams<{ id: string; versionId: string; stepName: string }>
          ).params;
          const body = (await req.json().catch(() => ({}))) as { input?: unknown };
          // `input: null` clears; `input: undefined` (missing) same as null.
          // Anything else is stored; must be a plain object since it
          // replaces the step's `settings.input` shape at runtime.
          const input = body.input === undefined ? null : body.input;
          if (input !== null) {
            if (typeof input !== "object" || Array.isArray(input)) {
              return err(
                `sample input for "${stepName}" must be a JSON object (replaces settings.input at test time)`,
                400,
              );
            }
            const serialized = JSON.stringify(input);
            if (serialized.length > SAMPLE_DATA_ENTRY_MAX_BYTES) {
              return err(
                `sample input for "${stepName}" exceeds ${SAMPLE_DATA_ENTRY_MAX_BYTES} bytes (got ${serialized.length})`,
                413,
              );
            }
          }
          const v = setSampleInputEntry(
            versionId,
            stepName,
            input as Record<string, unknown> | null,
          );
          return ok({ versionId: v.id, sampleInput: v.sampleInput });
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
          // Version selection:
          //   - Test-from-here (stepNameToTest set): prefer DRAFT. The user
          //     is iterating on step definitions + sample data in the editor,
          //     which mutates the draft; running the published version would
          //     test stale state.
          //   - Production runs: prefer PUBLISHED. Drafts are explicitly
          //     unverified; the trigger manager only fires production runs
          //     against published flows.
          const draftId = getLatestDraft(id)?.id ?? null;
          const versionId = body.stepNameToTest
            ? (draftId ?? flow.published_version_id ?? null)
            : (flow.published_version_id ?? draftId ?? null);
          if (!versionId) return err("flow has no published or draft version", 400);

          const run = createFlowRun({
            flowId: id,
            flowVersionId: versionId,
            environment: body.environment ?? "PRODUCTION",
            triggeredBy: body.triggeredBy,
            stepNameToTest: body.stepNameToTest,
            startTime: Date.now(),
          });
          // For test-from-here runs, fetch the version's persisted sampleData
          // so the engine can populate preceding steps' outputs without
          // re-running them. The map is shared by all runs of this version --
          // editing it via the version PATCH route updates it for the next
          // test. Production runs (no stepNameToTest) ignore sampleData
          // entirely.
          let sampleData: Record<string, unknown> | undefined;
          let sampleInputOverride: Record<string, unknown> | undefined;
          if (body.stepNameToTest) {
            const ver = getFlowVersion(versionId);
            if (ver?.sampleData) sampleData = ver.sampleData;
            // Per-step sample input override: forwarded as a SINGLE
            // {stepName -> input} entry, not the whole map -- the engine
            // executor only applies the override for the step under
            // test, never for other steps even if they have an entry.
            // Keeping the wire payload narrow means a copy-paste error
            // in one step's sample input can't bleed into a different
            // step's test run.
            const override = ver?.sampleInput?.[body.stepNameToTest];
            if (override && typeof override === "object" && !Array.isArray(override)) {
              sampleInputOverride = { [body.stepNameToTest]: override as Record<string, unknown> };
            }
          }
          enqueue({
            jobType: "RUN_FLOW",
            payload: {
              runId: run.id,
              payload: body.payload ?? {},
              ...(body.stepNameToTest ? { stepNameToTest: body.stepNameToTest } : {}),
              ...(sampleData ? { sampleData } : {}),
              ...(sampleInputOverride ? { sampleInputOverride } : {}),
            },
            flowRunId: run.id,
            flowId: id,
            flowVersionId: versionId,
            // No auto-retry: flow code with side effects (notify, send
            // email, hit API) would duplicate on retry. The user gets a
            // clear FAILED status and clicks Run again if they want.
            maxAttempts: 1,
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
 *
 * `displayName` is inlined from the flow's latest version (published if
 * available, otherwise latest draft) so list-view clients (the workflows
 * room, the flow_ref picker in the editor) don't have to do a per-flow
 * follow-up fetch just to render a name. The lookup is two indexed SELECTs
 * per flow; the GET /api/workflows handler caps at 100 by default, so the
 * extra round-trip is in the low milliseconds even on cold cache.
 */
function serializeFlow(row: ReturnType<typeof getFlow> | NonNullable<ReturnType<typeof getFlow>>) {
  if (!row) return null;
  const versionId = row.published_version_id ?? getLatestDraft(row.id)?.id ?? null;
  const version = versionId ? getFlowVersion(versionId) : null;
  return {
    id: row.id,
    externalId: row.external_id,
    projectId: row.project_id,
    status: row.status,
    publishedVersionId: row.published_version_id,
    displayName: version?.displayName ?? null,
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
