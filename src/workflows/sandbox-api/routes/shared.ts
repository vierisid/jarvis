/**
 * Shared helpers for SandboxApi route handlers.
 *
 * Every route is invoked with an `AuthenticatedRequest` (Request extended with
 * `claims` and `params`); the server's dispatcher attaches both before calling.
 */

import type { EngineTokenClaims } from "../types";

export interface RouteContext extends Request {
  claims: EngineTokenClaims;
  params?: Record<string, string>;
}

export type RouteHandler = (req: RouteContext) => Response | Promise<Response>;

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
  req: RouteContext,
): Promise<Record<string, unknown> | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err("invalid JSON body", 400);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err("body must be a JSON object", 400);
  }
  return raw as Record<string, unknown>;
}
