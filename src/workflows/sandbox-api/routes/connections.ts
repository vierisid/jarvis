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
 *   - 403 when the requested project differs from the verified engine token,
 *     or for a `jarvis:` id when the run's own graph names it anywhere but as
 *     the auth of a step of the source's pieces, or for any id when the graph
 *     the engine runs does not name it at all (#1153), or the engine runs no
 *     workflow of this project (managed-connection-scope.ts).
 *   - 409 when an external ID without a piece name matches multiple rows, or
 *     when the connection no longer resolves to the identity the run started
 *     with or its workflow was enabled against (Q-05, repos/binding-pins.ts).
 *     The refusal is recorded on the run, because the engine reports any 409
 *     as a bare loading error.
 *
 *   - 503 when a stored OAuth2 token has expired and its refresh could not
 *     reach the provider, or the connection changed during the refresh (#954).
 *   - 200 with status ERROR and an empty value when a stored OAuth2 token has
 *     expired and cannot be refreshed: the engine's own answer to that status
 *     is "connection (id) expired, reconnect again". Either way the run's
 *     binding records the typed reason (Q-19), and no credential is sent.
 *
 * An OAuth2 value is handed out with `refresh_token` and `client_secret`
 * empty (#1153), as the Jarvis-managed sources always were: the daemon
 * refreshes a token before handing it out, and a piece that needs a fresh
 * access token calls back into this endpoint for one.
 */

import { JARVIS_PREFIX, managedSourceFor, secretTextValue, type CredentialResolver, type ResolvedConnection } from "../../credentials/adapter";
import { managedConnectionScopeRefusal, storedConnectionScopeRefusal } from "../../db/repos/managed-connection-scope";
import { AmbiguousConnectionError } from "../../db/repos/app-connection";
import { enforceRunConnectionBinding, recordRunCredentialOutcome } from "../../db/repos/binding-pins";
import { ConnectionCredentialError, OAUTH2_TYPES } from "../../credentials/pasted-oauth2";
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

    // A managed credential goes only to a run whose own graph names it as the
    // auth of a step of the source's pieces. Checked before anything is
    // resolved, so a refused run never causes a token refresh either.
    if (externalId.startsWith(JARVIS_PREFIX)) {
      const source = managedSourceFor(deps.credentialResolver.list(), externalId);
      const refusal = source ? managedConnectionScopeRefusal(ctx.claims.runId, projectId, externalId, source) : null;
      if (refusal) return err(refusal, 403);
    } else {
      // #1153: a stored connection likewise goes only to an engine whose
      // graph names it, checked before anything is resolved or refreshed.
      const refusal = storedConnectionScopeRefusal(ctx.claims.runId, projectId, externalId);
      if (refusal) return err(refusal, 403);
    }

    let resolved: ResolvedConnection | null;
    try {
      resolved = await deps.credentialResolver.resolve({ projectId, pieceName, externalId });
    } catch (error) {
      if (error instanceof AmbiguousConnectionError) return err(error.message, 409);
      throw error;
    }
    if (!resolved || resolved.status === "MISSING") return err(`connection ${externalId} not found`, 404);
    // Every fetch in a run (each step, a retry, a resumed approval) hands out
    // the identity the run started with, and only one its workflow was enabled
    // against. Never another account that now answers to the same name.
    const refusal = enforceRunConnectionBinding(ctx.claims.runId, projectId, externalId, deps.credentialResolver);
    if (refusal) return err(refusal, 409);
    // A stored OAuth2 token about to expire is refreshed here (#954), only
    // once the run is known to be allowed this connection.
    try {
      resolved = await deps.credentialResolver.fresh(resolved);
    } catch (error) {
      if (!(error instanceof ConnectionCredentialError)) throw error;
      recordRunCredentialOutcome(ctx.claims.runId, externalId, { code: error.code, message: error.message });
      if (error.code !== "CONNECTION_EXPIRED") return err(error.message, 503);
      resolved = { type: resolved.type, value: {}, pieceName: resolved.pieceName, status: "ERROR" };
    }
    // Only a stored OAuth2 row can fail this way, so only its hand-outs are worth recording.
    if (resolved.stored && OAUTH2_TYPES.has(resolved.type) && resolved.status !== "ERROR") {
      recordRunCredentialOutcome(ctx.claims.runId, externalId, null);
    }

    // Ensure value.type is set so the engine's switch() in
    // makeConnectionValueCompatibleWithContextV0 sees the discriminator.
    const value: Record<string, unknown> = {
      ...resolved.value,
      type: resolved.value["type"] ?? resolved.type,
    };
    // #1153: the means to mint new tokens stay with the daemon, which
    // refreshes a stored OAuth2 token before handing it out (#954). Piece
    // code needs the access token only, so a pasted refresh token or client
    // secret is not given to it, as Jarvis-managed Google's never was. Blanked
    // rather than removed, the shape the managed sources hand out.
    if (OAUTH2_TYPES.has(resolved.type)) {
      for (const key of ["refresh_token", "client_secret"]) if (key in value) value[key] = "";
      // Upstream's OAuth2 value keeps the raw token response under `data`,
      // refresh token included; a value pasted from an export carries it.
      const data = value["data"];
      if (data && typeof data === "object" && !Array.isArray(data) && "refresh_token" in data) value["data"] = { ...(data as Record<string, unknown>), refresh_token: "" };
    }
    // #1153: a SECRET_TEXT row saved before the validator asked for
    // `secret_text` is handed on under the key the piece reads; the resolver
    // already did this for a stored row (`secretTextValue`), and a Jarvis
    // source's value goes through the same rule here.
    if (resolved.type === "SECRET_TEXT") Object.assign(value, secretTextValue(resolved.type, value));

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
