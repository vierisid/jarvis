/**
 * `on_event` polling trigger -- fires the workflow when a Jarvis event of the
 * given type is published.
 *
 * Stateless poll pattern: the daemon keeps a short recent-events buffer
 * (newest-first, finite size). The trigger persists a `since` cursor via
 * `context.store` and asks for events newer than that cursor on each run.
 *
 *   onEnable  -- pick a polling cadence (1 minute by default), seed cursor
 *                with current daemon-side cursor (so the first poll only
 *                returns events that arrive after enable, not history).
 *   onDisable -- nothing to clean up; cursor lives in context.store and dies
 *                with the trigger.
 *   run       -- poll, advance cursor, return events with DEDUPE_KEY_PROPERTY.
 *   test      -- single sample.
 *
 * Polling-trigger contexts in upstream's framework type don't expose `server`,
 * but the engine runtime sets it unconditionally (see
 * packages/server/engine/src/lib/helper/trigger-helper.ts:137-141). We cast
 * at the boundary so trigger code can call back.
 */

import {
  createTrigger,
  Property,
  TriggerStrategy,
  DEDUPE_KEY_PROPERTY,
} from "@activepieces/pieces-framework";

const CURSOR_KEY = "jarvis-trigger:on-event:since";

interface ServerContext {
  apiUrl: string;
  token: string;
}

interface PollResponse {
  events: Array<{
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    timestamp: number;
  }>;
  cursor: number;
}

function readServer(context: { server?: ServerContext } | unknown): ServerContext {
  const s = (context as { server?: ServerContext }).server;
  if (!s || typeof s.apiUrl !== "string" || typeof s.token !== "string") {
    throw new Error("jarvis-trigger.on_event: server context missing on trigger run");
  }
  return s;
}

async function poll(server: ServerContext, body: Record<string, unknown>): Promise<PollResponse> {
  const url = trimSlash(server.apiUrl) + "/v1/jarvis/events/poll";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `jarvis-trigger.on_event: daemon responded ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as PollResponse;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildPollBody(eventType: string, filter: unknown, since: number): Record<string, unknown> {
  const body: Record<string, unknown> = { eventType, since };
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    body["filter"] = filter;
  }
  return body;
}

export const onEventTrigger = createTrigger({
  name: "on_event",
  displayName: "On Jarvis event",
  description:
    "Fire the workflow when a Jarvis event of the given type is published. Use the daemon's event-type catalog (awareness.*, commitment.*, voice.*, tool.*) to pick a value.",
  type: TriggerStrategy.POLLING,
  props: {
    eventType: Property.ShortText({
      displayName: "Event type",
      description: "Fully-qualified Jarvis event type (e.g. awareness.context_changed).",
      required: true,
    }),
    filter: Property.Json({
      displayName: "Filter",
      description:
        "Optional shallow-equality filter; each field must match the event payload exactly.",
      required: false,
    }),
  },
  sampleData: {
    id: "evt_sample",
    eventType: "awareness.context_changed",
    payload: { app: "vscode", title: "main.ts" },
    timestamp: 0,
  },
  async onEnable(context) {
    const server = readServer(context);
    // Seed cursor with current head so we only deliver events that arrive
    // after enable, not whatever's already in the daemon's buffer.
    const eventType = context.propsValue["eventType"] as string;
    const filter = context.propsValue["filter"];
    const head = await poll(server, buildPollBody(eventType, filter, Number.MAX_SAFE_INTEGER));
    await context.store.put(CURSOR_KEY, head.cursor);
    // Default cadence: every minute. Users can override at the workflow level
    // once flow-version-stored scheduleOptions are surfaced in the UI.
    context.setSchedule({ cronExpression: "* * * * *" });
  },
  async onDisable(_context) {
    // Stateless poll -- nothing daemon-side to release.
  },
  async run(context) {
    const server = readServer(context);
    const eventType = context.propsValue["eventType"] as string;
    const filter = context.propsValue["filter"];
    const since = ((await context.store.get(CURSOR_KEY)) as number | undefined) ?? 0;
    const reply = await poll(server, buildPollBody(eventType, filter, since));
    if (reply.events.length === 0) {
      // Still bump cursor: prevents replaying the same window if the daemon's
      // cursor has advanced past `since` due to buffer eviction.
      if (reply.cursor > since) await context.store.put(CURSOR_KEY, reply.cursor);
      return [];
    }
    await context.store.put(CURSOR_KEY, reply.cursor);
    return reply.events.map((ev) => ({
      ...ev,
      [DEDUPE_KEY_PROPERTY]: ev.id,
    }));
  },
});
