/** Fixed endpoints, one mutation attempt, and no host start URL or ZAK in step outputs. */
export const MANAGED_ZOOM_ACTIONS = [
  "zoom_create_meeting",
  "zoom_find_meeting",
  "zoom_get_meeting",
  "zoom_update_meeting",
  "zoom_update_meeting_by_id",
] as const;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
export function managedZoomInput(piece: string, input: unknown): boolean {
  return (
    piece === "@activepieces/piece-zoom" &&
    record(input) &&
    record(input.auth) &&
    input.auth.jarvis_managed === "zoom"
  );
}
function text(v: unknown, name: string, max: number): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x1f\x7f]/.test(v)
  )
    throw new Error("Enter a valid " + name + ".");
  return v.trim();
}
export function zoomMeetingId(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== "string" || !/^[1-9][0-9]{8,10}$/.test(v))
    throw new Error("Enter the numeric Zoom meeting ID.");
  return v;
}
function startTime(v: unknown): string {
  const s = text(v, "start time in UTC", 32),
    t = Date.parse(s);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) ||
    !Number.isFinite(t) ||
    new Date(t).toISOString().replace(".000Z", "Z") !==
      s.replace(".000Z", "Z") ||
    t <= Date.now()
  )
    throw new Error(
      "Enter a future start time in UTC, for example 2030-06-01T14:00:00Z.",
    );
  return s;
}
/** Only participant-facing meeting fields reach persisted outputs. */
function meeting(raw: unknown, user: string, expectedId?: string) {
  if (
    !record(raw) ||
    raw.host_id !== user ||
    raw.type !== 2 ||
    (expectedId && zoomMeetingId(raw.id) !== expectedId)
  )
    throw new Error(
      "Use a scheduled, non-recurring meeting hosted by the connected Zoom user.",
    );
  const id = Number(zoomMeetingId(raw.id));
  if (
    typeof raw.topic !== "string" ||
    typeof raw.start_time !== "string" ||
    !Number.isFinite(Date.parse(raw.start_time)) ||
    typeof raw.duration !== "number" ||
    !Number.isFinite(raw.duration) ||
    typeof raw.timezone !== "string"
  )
    throw new Error(
      "Zoom returned invalid meeting details. Check Zoom before retrying.",
    );
  let join: URL;
  try {
    join = new URL(raw.join_url);
  } catch {
    throw new Error("Zoom returned an invalid join URL.");
  }
  if (
    join.protocol !== "https:" ||
    !(
      join.hostname === "zoom.us" ||
      /^[a-z0-9-]+\.zoom\.us$/.test(join.hostname)
    ) ||
    join.username ||
    join.password ||
    join.port ||
    join.hash ||
    join.pathname !== "/j/" + id ||
    [...join.searchParams.keys()].some((k) => k !== "pwd")
  )
    throw new Error("Zoom returned an invalid join URL.");
  return {
    id,
    topic: raw.topic,
    type: 2,
    host_id: user,
    start_time: raw.start_time,
    duration: raw.duration,
    timezone: raw.timezone,
    agenda: typeof raw.agenda === "string" ? raw.agenda : "",
    join_url: join.href,
  };
}
async function api(
  token: string,
  path: string,
  method: string,
  request: typeof fetch,
  body?: Record<string, unknown>,
) {
  let response: Response;
  try {
    response = await request("https://api.zoom.us/v2" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(
      method === "GET"
        ? "Zoom could not be reached. Try again shortly."
        : "Zoom did not confirm the change. Check the meeting in Zoom before trying again.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401
        ? "Zoom refused access. Reconnect Zoom."
        : response.status === 429
          ? "Zoom is rate limiting requests. Check the meeting before trying again later."
          : "Zoom could not complete the request. Check the meeting, account permissions and plan before trying again.",
    );
  }
  if (method === "PATCH") {
    await response.body?.cancel().catch(() => {});
    if (response.status !== 204)
      throw new Error(
        "Zoom did not confirm the update. Check the meeting before retrying.",
      );
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error(
      "Zoom returned an empty response. Check the meeting before retrying.",
    );
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
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
    return result;
  } catch {
    throw new Error(
      "Zoom returned an invalid or oversized response. Check the meeting before retrying.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function runManagedZoomAction(
  action: string,
  input: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<unknown> {
  if (!(MANAGED_ZOOM_ACTIONS as readonly string[]).includes(action))
    throw new Error(
      "This Zoom action is not enabled for the managed connection.",
    );
  if (
    !record(input.auth) ||
    typeof input.auth.access_token !== "string" ||
    !input.auth.access_token ||
    typeof input.auth.jarvis_user !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.auth.jarvis_user)
  )
    throw new Error("Reconnect Zoom.");
  const create = action === "zoom_create_meeting",
    update = action.startsWith("zoom_update_");
  const allowed = new Set([
    "auth",
    ...(!create ? ["meeting_id"] : []),
    ...(create || update ? ["topic", "start_time", "duration", "agenda"] : []),
  ]);
  for (const [key, value] of Object.entries(input))
    if (!allowed.has(key) && present(value))
      throw new Error(
        "The Zoom field " +
          key.replace(/[^a-z_]/g, "").slice(0, 48) +
          " is not enabled for this connection. Remove it before running.",
      );
  const body: Record<string, unknown> = {};
  if (create || present(input.topic))
    body.topic = text(input.topic, "meeting topic", 200);
  if (create || present(input.start_time)) {
    // The Z suffix fixes the instant in UTC. Only a new meeting is given a
    // timezone; an update keeps the meeting's own display timezone.
    body.start_time = startTime(input.start_time);
    if (create) body.timezone = "UTC";
  }
  if (present(input.agenda))
    body.agenda = text(input.agenda, "meeting agenda", 2000);
  if (present(input.duration)) {
    if (
      typeof input.duration !== "number" ||
      !Number.isInteger(input.duration) ||
      input.duration < 1 ||
      input.duration > 1440
    )
      throw new Error("Choose a duration from 1 to 1440 minutes.");
    body.duration = input.duration;
  }
  const token = input.auth.access_token,
    user = input.auth.jarvis_user;
  if (create) {
    const value = await api(token, "/users/me/meetings", "POST", request, {
      ...body,
      type: 2,
      duration: body.duration ?? 30,
      default_password: true,
      settings: {
        use_pmi: false,
        waiting_room: true,
        join_before_host: false,
        auto_recording: "none",
        host_video: false,
        participant_video: false,
      },
    });
    return meeting(value, user);
  }
  const id = zoomMeetingId(input.meeting_id),
    path = "/meetings/" + id;
  if (update && !Object.keys(body).length)
    throw new Error("Choose at least one meeting field to update.");
  const current = meeting(await api(token, path, "GET", request), user, id);
  if (!update) return current;
  // Confirm ownership and meeting type before the only write. Never update a recurring series.
  await api(token, path, "PATCH", request, body);
  return {
    success: true,
    message: "Meeting updated successfully",
    meeting_id: id,
  };
}
