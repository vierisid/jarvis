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
