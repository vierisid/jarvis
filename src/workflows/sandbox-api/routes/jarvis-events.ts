/**
 * `/v1/jarvis/events/poll` -- backs the `jarvis-trigger` `on_event` polling
 * trigger.
 *
 * Stateless poll: the daemon keeps a recent-events buffer; the trigger sends
 * `{ eventType, filter?, since }` and gets back events with timestamp > since
 * matching `eventType` and `filter`. Cursor is the daemon's notion of the
 * head (max id assigned so far), so the trigger persists it and uses it as
 * `since` on the next poll. A magic `since: Number.MAX_SAFE_INTEGER` returns
 * an empty event list with the current head -- used by `onEnable` to seed the
 * initial cursor without delivering historical events.
 */

import { json, err, type RouteContext, type RouteHandler } from "./shared";

export interface JarvisEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface EventsPollRequest {
  eventType: string;
  filter?: Record<string, unknown>;
  since: number;
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
  return async (req: RouteContext) => {
    if (!deps.eventsPoll) {
      return err("jarvis events.poll not configured", 503);
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("invalid JSON body", 400);
    }
    if (typeof raw.eventType !== "string" || raw.eventType.length === 0) {
      return err("eventType must be a non-empty string", 400);
    }
    if (typeof raw.since !== "number" || !Number.isFinite(raw.since) || raw.since < 0) {
      return err("since must be a non-negative number", 400);
    }
    const out: EventsPollRequest = { eventType: raw.eventType, since: raw.since };
    if (raw.filter !== undefined) {
      if (typeof raw.filter !== "object" || raw.filter === null || Array.isArray(raw.filter)) {
        return err("filter must be an object if provided", 400);
      }
      out.filter = raw.filter as Record<string, unknown>;
    }
    const reply = await deps.eventsPoll(out, {
      runId: req.claims.runId,
      projectId: req.claims.projectId,
    });
    return json(reply);
  };
}
