/**
 * Resolves a piece connection by externalId, in the shape upstream's engine
 * expects (`/v1/worker/app-connections/:externalId?projectId=`). The engine's
 * `connection-resolver.ts` parses the body as `AppConnection` from
 * `@activepieces/shared` and reads `connection.status`, `connection.value.type`,
 * and `connection.value.<auth-shape>` to satisfy the piece's authentication.
 *
 * Resolution order (delegated to `CredentialResolver`):
 *   1. `jarvis:*` external ids -> live Jarvis-managed credential sources
 *      (Google OAuth, Telegram bot token, Discord bot token, ...).
 *   2. Otherwise -> the `app_connection` table.
 *
 * Failures map to HTTP:
 *   - 404 when the connection doesn't exist or its source returns null.
 *   - 403 when the requested project differs from the verified engine token.
 *   - 409 when an external ID without a piece name matches multiple rows.
 *
 * Per CredentialResolver contract for Jarvis-managed Google connections, the
 * resolved value's `refresh_token` is intentionally empty; pieces that need a
 * fresh access token must call back into this endpoint to request one.
 */

import type { CredentialResolver } from "../../credentials/adapter";
import { AmbiguousConnectionError } from "../../db/repos/app-connection";
import type { EngineTokenClaims } from "../types";
import { json, err, type RouteContext, type RouteHandler } from "./shared";

export interface ConnectionsRouteDeps {
  credentialResolver: CredentialResolver;
}

interface ConnectionResponseShape {
  id: string;
  externalId: string;
  type: string;
  scope: "PROJECT" | "PLATFORM";
  status: "ACTIVE" | "MISSING" | "ERROR";
  pieceName: string;
  displayName: string;
  projectIds: string[];
  platformId: string;
  value: Record<string, unknown>;
  created: string;
  updated: string;
}

export function createConnectionsRoute(deps: ConnectionsRouteDeps): RouteHandler {
  return async (ctx: RouteContext) => {
    const url = new URL(ctx.req.url);
    const externalIdRaw = ctx.params.externalId;
    if (!externalIdRaw) return err("missing externalId path param", 400);
    const externalId = externalIdRaw;
    const queryProject = url.searchParams.get("projectId") ?? undefined;
    const projectId = ctx.claims.projectId;
    if (queryProject !== undefined && queryProject !== projectId) return err("forbidden project", 403);

    // Upstream omits pieceName. Resolve only a unique match in the token's
    // project; explicit piece names retain exact matching, never wildcards.
    const pieceName = url.searchParams.get("pieceName") ?? undefined;
    if (pieceName !== undefined && !pieceName.trim()) return err("pieceName must not be empty", 400);

    let resolved;
    try {
      resolved = await deps.credentialResolver.resolve({ projectId, pieceName, externalId });
    } catch (error) {
      if (error instanceof AmbiguousConnectionError) return err(error.message, 409);
      throw error;
    }
    if (!resolved || resolved.status === "MISSING") return err(`connection ${externalId} not found`, 404);

    // Ensure value.type is set so the engine's switch() in
    // makeConnectionValueCompatibleWithContextV0 sees the discriminator.
    const value: Record<string, unknown> = {
      ...resolved.value,
      type: resolved.value["type"] ?? resolved.type,
    };

    const claims: EngineTokenClaims = ctx.claims;
    const now = new Date().toISOString();
    const response: ConnectionResponseShape = {
      id: `engine_${claims.runId}_${externalId}`,
      externalId,
      type: resolved.type,
      scope: "PROJECT",
      status: resolved.status ?? "ACTIVE",
      pieceName: resolved.pieceName ?? pieceName ?? "",
      displayName: externalId,
      projectIds: [projectId],
      platformId: claims.projectId,
      value,
      created: now,
      updated: now,
    };
    return json(response);
  };
}
