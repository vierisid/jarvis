/**
 * `/v1/jarvis/events/poll` -- backs the `jarvis-trigger` `on_event` polling
 * trigger.
 *
 * Two request shapes:
 *
 *   1. **Stream poll** -- `{ eventType, filter?, since }`. Returns events with
 *      timestamp > since matching `eventType` and `filter`. `cursor` is the
 *      daemon's notion of the head; the trigger persists it as `since` for the
 *      next poll.
 *
 *   2. **Head-only** -- `{ eventType, headOnly: true }` (no `since`). Returns
 *      `{ events: [], cursor: <current head> }`. Used by `onEnable` to seed
 *      the cursor without delivering historical events. Distinct from a
 *      sentinel `since` value so the daemon implementer's intent is explicit.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";

export interface JarvisEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface EventsPollRequest {
  eventType: string;
  filter?: Record<string, unknown>;
  /** Cursor from the previous poll. Required unless `headOnly` is true. */
  since?: number;
  /** When true, return only the current head cursor with an empty events array. */
  headOnly?: boolean;
}

export interface EventsPollResponse {
  events: JarvisEvent[];
  cursor: number;
}

export type EventsPollFn = (
  req: EventsPollRequest,
  ctx: { runId: string; projectId: string },
) => Promise<EventsPollResponse>;

export interface JarvisEventsRouteDeps {
  eventsPoll?: EventsPollFn;
}

export function createJarvisEventsPollRoute(
  deps: JarvisEventsRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.eventsPoll) {
      return err("jarvis events.poll not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.eventType !== "string" || raw.eventType.length === 0) {
      return err("eventType must be a non-empty string", 400);
    }
    const headOnly = raw.headOnly === true;
    const out: EventsPollRequest = { eventType: raw.eventType };
    if (headOnly) {
      out.headOnly = true;
    } else {
      if (typeof raw.since !== "number" || !Number.isFinite(raw.since) || raw.since < 0) {
        return err("since must be a non-negative number", 400);
      }
      out.since = raw.since;
    }
    if (raw.filter !== undefined) {
      if (typeof raw.filter !== "object" || raw.filter === null || Array.isArray(raw.filter)) {
        return err("filter must be an object if provided", 400);
      }
      out.filter = raw.filter as Record<string, unknown>;
    }
    const reply = await deps.eventsPoll(out, {
      runId: ctx.claims.runId,
      projectId: ctx.claims.projectId,
    });
    return json(reply);
  };
}
