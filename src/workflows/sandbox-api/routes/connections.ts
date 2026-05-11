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
 *
 * Per CredentialResolver contract for Jarvis-managed Google connections, the
 * resolved value's `refresh_token` is intentionally empty; pieces that need a
 * fresh access token must call back into this endpoint to request one.
 */

import type { CredentialResolver } from "../../credentials/adapter";
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
    const projectId = queryProject ?? ctx.claims.projectId;

    // The engine doesn't tell us which piece is asking, but our resolver only
    // needs the pieceName for app_connection lookups. For jarvis:* external
    // ids the resolver short-circuits before pieceName is read; for other ids
    // we fall back to "*" (treated as a wildcard at the repo level if
    // available, otherwise empty pieceName which fails the repo's UNIQUE
    // index lookup). Practically: vendored pieces will always present a
    // pieceName-prefixed externalId, so this branch is a soft fallback.
    const pieceName = url.searchParams.get("pieceName") ?? "*";

    const resolved = await deps.credentialResolver.resolve({
      projectId,
      pieceName,
      externalId,
    });
    if (!resolved) return err(`connection ${externalId} not found`, 404);

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
      status: "ACTIVE",
      pieceName: pieceName === "*" ? "" : pieceName,
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
