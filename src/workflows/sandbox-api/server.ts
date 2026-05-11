/**
 * SandboxApi server: the HTTP+WS endpoint surface that the activepieces engine
 * subprocess talks back to. Implements the contracts upstream's engine expects:
 *
 *   - HTTP `/v1/worker/app-connections/:externalId`     (resolve connection)
 *   - HTTP `/v1/worker/project`                         (project metadata)
 *   - HTTP `/v1/store-entries`                          (key-value store)
 *   - HTTP `/v1/step-files`                             (file uploads)
 *   - HTTP `/v1/waitpoints`                             (async pause)
 *   - HTTP `/v1/engine/populated-flows`                 (flow query)
 *   - HTTP `/v1/logs/:runId`                            (execution-state backup)
 *   - WS   `/worker/ws`                                 (socket.io RPC bridge — added in B4)
 *
 * Plus a parallel set of `/v1/jarvis/*` endpoints for our own ported pieces
 * (added in F-H).
 *
 * This file is the skeleton: route table, auth middleware, lifecycle. Real
 * route handlers land in subsequent commits as the engine wiring fills in.
 */

import type { Server } from "bun";

// We don't attach per-connection state to upgrades on this server (yet --
// socket.io will own that in B4), so the Bun.Server generic gets `unknown`.
type ServerNoData = Server<unknown>;
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
import type { EngineTokenClaims } from "./types";
import type { CredentialResolver } from "../credentials/adapter";
import { WorkerRpcServer } from "./worker-rpc";
import { DefaultWorkerHandlers } from "./worker-handlers";
import { DEFAULT_IDS } from "../db/schema";
import { createConnectionsRoute } from "./routes/connections";
import {
  deleteStoreEntryRoute,
  getStoreEntryRoute,
  putStoreEntryRoute,
} from "./routes/store";
import { populatedFlowsRoute } from "./routes/flows";
import {
  stepFilesUploadRoute,
  stepFilesDownloadRoute,
} from "./routes/files";
import { createWaitpointsRoute } from "./routes/waitpoints";
import { logsUploadRoute } from "./routes/logs";
import {
  createJarvisLlmChatRoute,
  type LlmChatFn,
} from "./routes/jarvis-llm";
import {
  createJarvisToolsInvokeRoute,
  type ToolsInvokeFn,
} from "./routes/jarvis-tools";
import {
  createJarvisNotifyRoute,
  type NotifyFn,
} from "./routes/jarvis-notify";
import {
  createJarvisContextVaultSearchRoute,
  createJarvisContextVaultGetEntityRoute,
  createJarvisContextAwarenessRecentRoute,
  createJarvisContextCommitmentsListRoute,
  type JarvisContextProvider,
} from "./routes/jarvis-context";
import {
  createJarvisAgentDelegateRoute,
  type AgentDelegateFn,
} from "./routes/jarvis-agent";
import {
  createJarvisEventsPollRoute,
  type EventsPollFn,
} from "./routes/jarvis-events";
import {
  createJarvisWorkflowsStartRoute,
  type WorkflowsStartFn,
} from "./routes/jarvis-workflows";
import { json, err, type RouteContext, type RouteHandler } from "./routes/shared";

export interface SandboxApiServices {
  credentialResolver: CredentialResolver;
  /**
   * URL prefix used to mint resumeUrl values for waitpoints. Engine pieces
   * embed this URL in step output; external callers POST to it to wake the
   * paused flow. Should be a public URL (the daemon's user-facing API), not
   * the sandbox-api's loopback URL. Default: empty string -- callers must
   * supply a real prefix once the resume webhook lands.
   */
  resumeUrlPrefix?: string;
  /**
   * Optional callback fired when a piece's `run.respond()` reaches a flow
   * with a webhook trigger. The handler is responsible for delivering the
   * response back to the original HTTP request.
   */
  onFlowResponse?: (
    sandboxId: string,
    req: import("./contracts").SendFlowResponseRequest,
  ) => void;
  /** Optional structured-log sink for per-sandbox stdout/stderr. */
  onLogLine?: (entry: import("./worker-handlers").LogLine) => void;
  /**
   * LLM chat backend for the `jarvis-ask` piece. If unset, the endpoint
   * returns 503; the daemon wires this in at startup with the LLMManager.
   */
  llmChat?: LlmChatFn;
  /**
   * Tool invocation backend for the `jarvis-tool` piece. If unset, the
   * endpoint returns 503. The daemon wires this in with `ToolRegistry`.
   */
  toolsInvoke?: ToolsInvokeFn;
  /**
   * Notification backend for the `jarvis-notify` piece. If unset, returns 503.
   */
  notify?: NotifyFn;
  /**
   * Read-only Jarvis state provider for the `jarvis-context` piece. If unset,
   * each context route returns 503.
   */
  contextProvider?: JarvisContextProvider;
  /**
   * Sub-agent delegation backend for the `jarvis-agent` piece. If unset, the
   * endpoint returns 503.
   */
  agentDelegate?: AgentDelegateFn;
  /**
   * Recent-events poll backend for the `jarvis-trigger` `on_event` trigger.
   * If unset, returns 503.
   */
  eventsPoll?: EventsPollFn;
  /**
   * Workflow start backend for the `jarvis-trigger` `run_workflow` action.
   * If unset, returns 503.
   */
  workflowsStart?: WorkflowsStartFn;
}

export interface SandboxApiOptions {
  /** Bind host. Default 127.0.0.1 -- the engine subprocess always runs locally. */
  host?: string;
  /** Bind port. Default 0 (OS-assigned). */
  port?: number;
  /** Optional shared signer for tests; otherwise a fresh per-process secret is used. */
  signer?: EngineTokenSigner;
  /** Optional shared registry for tests; otherwise a fresh empty registry is used. */
  registry?: SandboxRegistry;
  /** Service bag used by route handlers. */
  services: SandboxApiServices;
}

interface RouteEntry {
  /** Path with optional `:param` segments. Matched in order against the request URL. */
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  handler: RouteHandler;
}

/** Match `/v1/worker/app-connections/:externalId` against `/v1/worker/app-connections/foo`. */
function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");
  if (patternParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i] ?? "";
    const a = actualParts[i] ?? "";
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

export class SandboxApi {
  readonly signer: EngineTokenSigner;
  readonly registry: SandboxRegistry;
  readonly services: SandboxApiServices;
  readonly workerHandlers: DefaultWorkerHandlers;
  readonly workerRpc: WorkerRpcServer;
  private server: ServerNoData | null = null;
  private readonly routes: RouteEntry[] = [];

  constructor(opts: SandboxApiOptions) {
    this.signer = opts.signer ?? new EngineTokenSigner();
    this.registry = opts.registry ?? new SandboxRegistry();
    this.services = opts.services;
    this.workerHandlers = new DefaultWorkerHandlers({
      registry: this.registry,
      onFlowResponse: this.services.onFlowResponse,
      onLogLine: this.services.onLogLine,
    });
    this.workerRpc = new WorkerRpcServer({
      registry: this.registry,
      workerHandlers: this.workerHandlers,
      notifyHandlers: this.workerHandlers,
    });
    this.registerRoutes();
  }

  /**
   * Patch service backends after construction. Each `/v1/jarvis/*` route's
   * deps object IS `this.services` (passed by reference, not copied), so
   * route handlers observe these mutations on the next request. Used by the
   * daemon to wire backends that depend on services not ready at SandboxApi
   * construction time (e.g. ToolRegistry, available only after startAll).
   */
  setServices(patch: Partial<SandboxApiServices>): void {
    Object.assign(this.services, patch);
  }

  private registerRoutes(): void {
    this.routes.push(
      {
        path: "/v1/worker/project",
        method: "GET",
        // Single-tenant: every request resolves to the daemon's default project.
        handler: async (ctx) =>
          json({ id: DEFAULT_IDS.project, externalId: ctx.claims.projectId }),
      },
      {
        path: "/v1/worker/app-connections/:externalId",
        method: "GET",
        handler: createConnectionsRoute({
          credentialResolver: this.services.credentialResolver,
        }),
      },
      { path: "/v1/store-entries", method: "GET", handler: getStoreEntryRoute },
      { path: "/v1/store-entries", method: "POST", handler: putStoreEntryRoute },
      { path: "/v1/store-entries", method: "DELETE", handler: deleteStoreEntryRoute },
      { path: "/v1/engine/populated-flows", method: "GET", handler: populatedFlowsRoute },
      { path: "/v1/step-files", method: "POST", handler: stepFilesUploadRoute },
      { path: "/v1/step-files/:id", method: "GET", handler: stepFilesDownloadRoute },
      {
        path: "/v1/waitpoints",
        method: "POST",
        handler: createWaitpointsRoute({
          resumeUrlPrefix: this.services.resumeUrlPrefix ?? "/api/webhooks/waitpoints",
        }),
      },
      { path: "/v1/logs/:runId", method: "PUT", handler: logsUploadRoute },
      // /v1/jarvis/* routes pass `this.services` itself (not a snapshot) so
      // each handler reads the live backend on every request. This lets the
      // daemon wire backends after construction via `setServices` -- e.g.
      // ToolRegistry isn't ready until `registry.startAll()` completes, but
      // we want the SandboxApi started earlier so catalog extraction can run.
      {
        path: "/v1/jarvis/llm/chat",
        method: "POST",
        handler: createJarvisLlmChatRoute(this.services),
      },
      {
        path: "/v1/jarvis/tools/invoke",
        method: "POST",
        handler: createJarvisToolsInvokeRoute(this.services),
      },
      {
        path: "/v1/jarvis/notify",
        method: "POST",
        handler: createJarvisNotifyRoute(this.services),
      },
      {
        path: "/v1/jarvis/context/vault-search",
        method: "POST",
        handler: createJarvisContextVaultSearchRoute(this.services),
      },
      {
        path: "/v1/jarvis/context/vault-get-entity",
        method: "POST",
        handler: createJarvisContextVaultGetEntityRoute(this.services),
      },
      {
        path: "/v1/jarvis/context/awareness-recent",
        method: "POST",
        handler: createJarvisContextAwarenessRecentRoute(this.services),
      },
      {
        path: "/v1/jarvis/context/commitments-list",
        method: "POST",
        handler: createJarvisContextCommitmentsListRoute(this.services),
      },
      {
        path: "/v1/jarvis/agent/delegate",
        method: "POST",
        handler: createJarvisAgentDelegateRoute(this.services),
      },
      {
        path: "/v1/jarvis/events/poll",
        method: "POST",
        handler: createJarvisEventsPollRoute(this.services),
      },
      {
        path: "/v1/jarvis/workflows/start",
        method: "POST",
        handler: createJarvisWorkflowsStartRoute(this.services),
      },
    );
  }

  async start(opts: { host?: string; port?: number } = {}): Promise<void> {
    if (this.server) return;
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 0;

    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: (req) => this.dispatch(req),
    });

    await this.workerRpc.start();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
    await this.workerRpc.stop();
  }

  /** TCP port the engine subprocess should connect to (AP_SANDBOX_WS_PORT). */
  get sandboxWsPort(): number {
    return this.workerRpc.getPort();
  }

  get port(): number {
    if (!this.server) throw new Error("SandboxApi not started");
    // Always bound to TCP in start(); Bun.Server's typing marks port|hostname
    // optional to cover unix-socket configs we don't use.
    if (typeof this.server.port !== "number") {
      throw new Error("SandboxApi: server has no TCP port");
    }
    return this.server.port;
  }

  get hostname(): string {
    if (!this.server) throw new Error("SandboxApi not started");
    if (typeof this.server.hostname !== "string") {
      throw new Error("SandboxApi: server has no hostname");
    }
    return this.server.hostname;
  }

  get baseUrl(): string {
    return `http://${this.hostname}:${this.port}`;
  }

  private async dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Health check (unauthenticated) -- handy for spawn-then-wait readiness probes.
    if (pathname === "/health" && req.method === "GET") {
      return json({ ok: true, sandboxes: this.registry.liveCount() });
    }

    // Authenticate via either:
    //   - Authorization: Bearer <engineToken>  (default; what the engine uses
    //     for HTTP RPC calls)
    //   - ?token=<engineToken> in the URL      (fallback for the single
    //     endpoint where the engine's upstream client doesn't decorate the
    //     request with auth headers: the logs upload PUT, which is shaped
    //     after a presigned URL).
    //
    // The query-param fallback is restricted to exactly `PUT /v1/logs/:runId`
    // because URL-borne tokens leak more readily than header tokens (proxy
    // logs, access logs, browser history). Every other path requires the
    // header.
    let token: string | null = null;
    const auth = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) {
      token = m[1]!;
    } else {
      const qp = url.searchParams.get("token");
      const isLogsUpload = req.method === "PUT" && /^\/v1\/logs\/[^/]+$/.test(pathname);
      if (qp && isLogsUpload) token = qp;
    }
    if (!token) return err("missing bearer token", 401);

    let claims: EngineTokenClaims;
    try {
      claims = await this.signer.verify(token);
    } catch {
      return err("invalid engine token", 401);
    }
    if (!this.registry.get(claims.sandboxId)) {
      return err("sandbox terminated", 401);
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.path, pathname);
      if (params === null) continue;
      // Build a fresh per-request context. The Request itself is never
      // mutated -- callers read body/headers/url from `ctx.req`, with
      // verified claims and matched params alongside.
      const ctx: RouteContext = { req, claims, params };
      try {
        return await route.handler(ctx);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(`internal error: ${message}`, 500);
      }
    }

    return err("not found", 404);
  }
}
