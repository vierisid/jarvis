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
import { DEFAULT_IDS } from "../db/schema";

export interface SandboxApiOptions {
  /** Bind host. Default 127.0.0.1 -- the engine subprocess always runs locally. */
  host?: string;
  /** Bind port. Default 0 (OS-assigned). */
  port?: number;
  /** Optional shared signer for tests; otherwise a fresh per-process secret is used. */
  signer?: EngineTokenSigner;
  /** Optional shared registry for tests; otherwise a fresh empty registry is used. */
  registry?: SandboxRegistry;
}

export interface AuthenticatedRequest extends Request {
  claims: EngineTokenClaims;
}

type RouteHandler = (req: AuthenticatedRequest) => Response | Promise<Response>;

interface RouteEntry {
  /** Path with optional `:param` segments. Matched in order against the request URL. */
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  handler: RouteHandler;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const err = (message: string, status = 400): Response =>
  json({ error: message }, status);

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
  private server: ServerNoData | null = null;
  private readonly routes: RouteEntry[] = [];

  constructor(opts: SandboxApiOptions = {}) {
    this.signer = opts.signer ?? new EngineTokenSigner();
    this.registry = opts.registry ?? new SandboxRegistry();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Real route handlers land in subsequent commits (B2-B3). For now we ship
    // one auth-protected stub so the server skeleton can be exercised end-to-
    // end in tests.
    this.routes.push({
      path: "/v1/worker/project",
      method: "GET",
      handler: async (req) => {
        // Single-tenant: every request resolves to the daemon's default project.
        return json({
          id: DEFAULT_IDS.project,
          externalId: req.claims.projectId,
        });
      },
    });
  }

  start(opts: { host?: string; port?: number } = {}): void {
    if (this.server) return;
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 0;

    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: (req) => this.dispatch(req),
    });
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
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

    // Authenticate every other request via Authorization: Bearer <engineToken>.
    const auth = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return err("missing bearer token", 401);

    let claims: EngineTokenClaims;
    try {
      claims = await this.signer.verify(m[1]!);
    } catch {
      return err("invalid engine token", 401);
    }
    if (!this.registry.get(claims.sandboxId)) {
      return err("sandbox terminated", 401);
    }

    const authedReq = req as AuthenticatedRequest;
    authedReq.claims = claims;

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.path, pathname);
      if (params === null) continue;
      // Stash matched params on the request via a property -- callers cast.
      Object.assign(authedReq, { params });
      try {
        return await route.handler(authedReq);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(`internal error: ${message}`, 500);
      }
    }

    return err("not found", 404);
  }
}
