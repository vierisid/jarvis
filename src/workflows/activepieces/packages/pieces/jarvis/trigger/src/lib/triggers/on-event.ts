/**
 * `on_event` polling trigger -- fires the workflow when a Jarvis event of the
 * given type is published.
 *
 * Stateless poll pattern: the daemon keeps a short recent-events buffer
 * (newest-first, finite size). The trigger persists a `since` cursor via
 * `context.store` and asks for events newer than that cursor on each run.
 *
 *   onEnable  -- pick a polling cadence (1 minute by default), seed cursor
 *                with the daemon's current head (so the first real poll only
 *                returns events that arrive after enable, not history).
 *   onDisable -- nothing to clean up; cursor lives in context.store and dies
 *                with the trigger.
 *   run       -- poll, advance cursor, return events with DEDUPE_KEY_PROPERTY.
 *   test      -- single sample.
 *
 * Latency: the polling cadence is once a minute (`* * * * *`). Events surface
 * within ~60 seconds of being published to the daemon's event buffer.
 *
 * Why not sub-minute: Jarvis's own CronScheduler supports an `@every <n>(s|m|h)`
 * extension, BUT the engine validates a trigger's cron with `cron-validator`'s
 * `isValidCron` inside `setSchedule` BEFORE Jarvis's scheduler ever sees it --
 * and that validator only accepts standard 5-field cron, so `@every 10s` throws
 * InvalidCronExpressionError and the whole ON_ENABLE hook fails with
 * USER_FAILURE (the trigger never registers). A standard 5-field cron is the
 * only expression both validators accept, and its finest granularity is one
 * minute. Going sub-minute would require teaching the engine validator about
 * the `@every` extension (a vendored-engine patch).
 *
 * If 60s is too slow for a use case (voice intents, sub-second reactions), the
 * alternative is bypassing the polling-trigger machinery entirely and having
 * the daemon push events directly into RUN_FLOW jobs -- bigger lift.
 */

import {
  createTrigger,
  Property,
  TriggerStrategy,
  DEDUPE_KEY_PROPERTY,
} from "@activepieces/pieces-framework";

const CURSOR_KEY = "jarvis-trigger:on-event:since";
// Standard 5-field cron (every minute). MUST stay standard cron: the engine's
// setSchedule rejects non-standard syntax (e.g. `@every 10s`) via isValidCron,
// which fails ON_ENABLE and prevents the trigger from registering. See the
// file header for the full rationale.
const POLL_CADENCE_CRON = "* * * * *";

interface PollResponse {
  events: Array<{
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    timestamp: number;
  }>;
  cursor: number;
}

async function poll(
  apiUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<PollResponse> {
  const url = trimSlash(apiUrl) + "/v1/jarvis/events/poll";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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

function readSinceFromStore(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
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
  // Generic envelope used by the variable picker / composer prompt
  // when the user has NOT yet configured an eventType. Once eventType
  // is set, the catalog projection's `dynamicSampleData` overlay
  // (built in `runtime/piece-catalog.ts:buildOnEventDynamicSampleData`)
  // surfaces the matching per-event payload. Don't bias this default
  // to a specific event type's payload -- it's misleading before the
  // user has picked.
  //
  // The `eventType` string here is INFORMATIONAL only. It's never
  // consumed as a matcher: the variable picker reads it as a label,
  // the editor preview shows it verbatim, and the runtime
  // event-bus subscription uses `propsValue.eventType` (the user-
  // configured value), not this default. Don't treat this string as
  // a valid event type or try to discriminate on it.
  sampleData: {
    id: "evt_sample",
    eventType: "<see dynamicSampleData for the configured eventType>",
    payload: {},
    timestamp: 0,
  },
  async onEnable(context) {
    const eventType = context.propsValue["eventType"] as string;
    // Seed cursor with the daemon's current head so the first real poll only
    // returns events that arrive after enable, not historical ones. The
    // dedicated `headOnly: true` shape on the route makes this intent
    // explicit (vs. abusing a sentinel `since` value).
    const head = await poll(context.server.apiUrl, context.server.token, {
      eventType,
      headOnly: true,
    });
    await context.store.put(CURSOR_KEY, head.cursor);
    context.setSchedule({ cronExpression: POLL_CADENCE_CRON });
  },
  async onDisable(_context) {
    // Stateless poll -- nothing daemon-side to release.
  },
  async run(context) {
    const eventType = context.propsValue["eventType"] as string;
    const filter = context.propsValue["filter"];
    const since = readSinceFromStore(await context.store.get(CURSOR_KEY));
    const body: Record<string, unknown> = { eventType, since };
    if (filter && typeof filter === "object" && !Array.isArray(filter)) {
      body["filter"] = filter;
    }
    const reply = await poll(context.server.apiUrl, context.server.token, body);
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
