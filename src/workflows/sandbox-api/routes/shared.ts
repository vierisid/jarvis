/**
 * Shared helpers for SandboxApi route handlers.
 *
 * Every route is invoked with a `RouteContext` -- a plain object carrying
 * the underlying `Request`, the verified engine-token `claims`, and any
 * URL `params` matched from the route pattern. The dispatcher constructs
 * this object per request; handlers never mutate the Request itself.
 */

import type { EngineTokenClaims } from "../types";

export interface RouteContext {
  /** The underlying Bun `Request`. Read body / headers / url from here. */
  req: Request;
  /** Verified claims from the engine token. */
  claims: EngineTokenClaims;
  /** URL params extracted from the route pattern (e.g. `:runId`). */
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const err = (message: string, status = 400): Response =>
  json({ error: message }, status);

/**
 * Parse a request as a JSON object. Returns the object on success, an `err`
 * Response on parse failure or when the body is valid JSON but not a plain
 * object (e.g. a string, number, array, or null). Use at the top of every
 * `/v1/jarvis/*` POST handler so route behavior is consistent for malformed
 * envelopes regardless of whether the route's required fields happen to be
 * absent on a non-object body.
 */
export async function parseJsonObject(
  ctx: RouteContext,
): Promise<Record<string, unknown> | Response> {
  let raw: unknown;
  try {
    raw = await ctx.req.json();
  } catch {
    return err("invalid JSON body", 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err("body must be a JSON object", 400);
  }
  return raw as Record<string, unknown>;
}
