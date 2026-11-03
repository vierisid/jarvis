/** Fixed Calendly endpoints, bounded one-page responses, and no automatic write retries. */
export const MANAGED_CALENDLY_ACTIONS = [
  "list_scheduled_events",
  "get_scheduled_event",
  "list_event_invitees",
  "list_event_types",
  "create_scheduling_link",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const provided = (v: unknown) => v !== undefined && v !== null && v !== "";
export function managedCalendlyInput(
  input: unknown,
): Record<string, unknown> | null {
  return record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "calendly"
    ? input
    : null;
}
function text(v: unknown, label: string, max = 512): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x1f\x7f]/.test(v)
  )
    throw new Error("Enter a valid " + label + ".");
  return v.trim();
}
function uuid(v: unknown, kind: string): string {
  const value = text(v, "Calendly " + kind + " ID", 256);
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  // Match before parsing: URL normalization must not turn traversal into a valid ID.
  const match = new RegExp(
    "^https://api\\.calendly\\.com/" + kind + "/([A-Za-z0-9_-]{1,128})$",
  ).exec(value);
  if (!match) throw new Error("Use a Calendly " + kind + " URI or ID.");
  return match[1]!;
}
function option(v: unknown, values: string[]): string {
  if (typeof v !== "string" || !values.includes(v))
    throw new Error("Choose a supported Calendly option.");
  return v;
}
function date(v: unknown): string {
  const s = text(v, "meeting date", 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new Error("Use a meeting date with a timezone.");
  return s;
}
export async function runManagedCalendlyAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_CALENDLY_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Calendly action has not been enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.secret_text !== "string" ||
    !input.auth.secret_text
  )
    throw new Error("Reconnect Calendly.");
  let path: string, body: Record<string, unknown> | undefined;
  const query = new URLSearchParams();
  const list = action.startsWith("list_");
  if (list) {
    const count = provided(input.count) ? input.count : 20;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100
    )
      throw new Error("Choose a Calendly page size from 1 to 100.");
    query.set("count", String(count));
    if (provided(input.pageToken))
      query.set("page_token", text(input.pageToken, "page token", 2048));
  }
  if (action === "list_event_types" || action === "list_scheduled_events") {
    if (provided(input.organization))
      throw new Error(
        "Organization-wide listing is not enabled. Leave Organization empty to use the connected user.",
      );
    const user = uuid(input.auth.jarvis_user, "users");
    if (provided(input.user) && uuid(input.user, "users") !== user)
      throw new Error("Choose the connected Calendly user.");
    query.set("user", "https://api.calendly.com/users/" + user);
  }
  if (action === "list_event_types") {
    path = "/event_types";
    if (provided(input.active))
      query.set("active", option(input.active, ["true", "false"]));
  } else if (action === "list_scheduled_events") {
    path = "/scheduled_events";
    if (provided(input.inviteeEmail))
      query.set("invitee_email", text(input.inviteeEmail, "invitee email"));
    for (const [key, param] of [
      ["minStartTime", "min_start_time"],
      ["maxStartTime", "max_start_time"],
    ] as const)
      if (provided(input[key])) query.set(param, date(input[key]));
    if (
      provided(input.minStartTime) &&
      provided(input.maxStartTime) &&
      Date.parse(String(input.minStartTime)) >
        Date.parse(String(input.maxStartTime))
    )
      throw new Error("Starts After must precede Starts Before.");
    query.set(
      "sort",
      provided(input.sort)
        ? option(input.sort, ["start_time:asc", "start_time:desc"])
        : "start_time:asc",
    );
  } else if (action === "create_scheduling_link") {
    path = "/scheduling_links";
    body = {
      max_event_count: 1,
      owner:
        "https://api.calendly.com/event_types/" +
        uuid(input.eventType, "event_types"),
      owner_type: "EventType",
    };
  } else {
    path =
      "/scheduled_events/" + uuid(input.scheduledEvent, "scheduled_events");
    if (action === "list_event_invitees") {
      path += "/invitees";
      if (provided(input.email))
        query.set("email", text(input.email, "invitee email"));
    }
  }
  if (
    (action === "list_scheduled_events" || action === "list_event_invitees") &&
    provided(input.status)
  )
    query.set("status", option(input.status, ["active", "canceled"]));
  let response: Response;
  try {
    response = await request(
      "https://api.calendly.com" + path + (query.size ? "?" + query : ""),
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + input.auth.secret_text,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  } catch {
    throw new Error(
      body
        ? "Calendly's booking-link result is uncertain. Check the run before trying again."
        : "Calendly could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Calendly refused access. Reconnect Calendly."
        : response.status === 429
          ? "Calendly is rate limiting requests. Try again later."
          : "Calendly could not access this resource. Check the ID, permissions and account plan.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Calendly returned an empty response.");
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1048576) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(result)) throw new Error();
    const event = (v: any) =>
      record(v) &&
      typeof v.name === "string" &&
      ["active", "canceled"].includes(v.status) &&
      uuid(v.uri, "scheduled_events") &&
      typeof v.start_time === "string" &&
      typeof v.end_time === "string" &&
      Number.isFinite(Date.parse(v.start_time)) &&
      Number.isFinite(Date.parse(v.end_time)) &&
      uuid(v.event_type, "event_types");
    if (list) {
      if (
        !Array.isArray(result.collection) ||
        result.collection.length > 100 ||
        !record(result.pagination) ||
        !Number.isInteger(result.pagination.count) ||
        result.pagination.count !== result.collection.length
      )
        throw new Error();
      const cursor = result.pagination.next_page_token;
      if (
        cursor !== null &&
        cursor !== undefined &&
        (typeof cursor !== "string" || cursor.length > 2048)
      )
        throw new Error();
      for (const item of result.collection) {
        if (!record(item)) throw new Error();
        if (action === "list_scheduled_events" && !event(item))
          throw new Error();
        if (
          action === "list_event_types" &&
          !(
            uuid(item.uri, "event_types") &&
            typeof item.name === "string" &&
            typeof item.active === "boolean" &&
            typeof item.duration === "number" &&
            typeof item.scheduling_url === "string"
          )
        )
          throw new Error();
        if (
          action === "list_event_invitees" &&
          !(
            typeof item.uri === "string" &&
            item.uri.startsWith("https://api.calendly.com" + path + "/") &&
            typeof item.name === "string" &&
            typeof item.email === "string" &&
            ["active", "canceled"].includes(item.status) &&
            item.event ===
              "https://api.calendly.com/scheduled_events/" +
                uuid(input.scheduledEvent, "scheduled_events")
          )
        )
          throw new Error();
      }
      return {
        items: result.collection,
        count: result.pagination.count,
        next_page_token: cursor ?? null,
      };
    }
    const value = result.resource;
    if (action === "get_scheduled_event") {
      if (!event(value) || value.uri !== "https://api.calendly.com" + path)
        throw new Error();
    } else {
      if (
        !record(value) ||
        value.owner !== body!.owner ||
        value.owner_type !== "EventType"
      )
        throw new Error();
      const url = new URL(value.booking_url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "calendly.com" ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new Error(
      "Calendly returned an invalid or oversized response. Check the run before retrying.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
