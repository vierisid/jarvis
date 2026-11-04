import { afterEach, expect, test } from "bun:test";
import { runManagedZoomAction, MANAGED_ZOOM_ACTIONS } from "./managed-zoom";
import { zoomInputSchema, zoomEngineProps } from "./managed-zoom-inputs";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
import { executeAuthorizedPiece } from "./piece-effect-guard";
const auth = {
  access_token: "PRIVATE_ACCESS",
  jarvis_user: "user1",
  jarvis_managed: "zoom",
};
const meeting = {
  id: 12345678901,
  host_id: "user1",
  type: 2,
  topic: "Planning",
  start_time: "2030-06-01T14:00:00Z",
  duration: 30,
  timezone: "UTC",
  join_url: "https://us02web.zoom.us/j/12345678901?pwd=participant",
  agenda: "Planning",
  start_url: "PRIVATE_HOST_URL",
  password: "PRIVATE_PASSCODE",
  settings: { secret: "PRIVATE_SETTINGS" },
};
function fake(value: unknown = meeting) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return init?.method === "PATCH"
      ? new Response(null, { status: 204 })
      : Response.json(value);
  }) as typeof fetch;
  return { request, calls };
}
test("creation uses the connected host with waiting room, generated passcode and no recording", async () => {
  const f = fake();
  const result = await runManagedZoomAction(
    "zoom_create_meeting",
    { auth, topic: "Planning", start_time: "2030-06-01T14:00:00Z" },
    f.request,
  );
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.url).toBe("https://api.zoom.us/v2/users/me/meetings");
  expect(f.calls[0]!.init.redirect).toBe("error");
  expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
    topic: "Planning",
    start_time: "2030-06-01T14:00:00Z",
    timezone: "UTC",
    type: 2,
    duration: 30,
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
  expect(result).toMatchObject({ id: meeting.id, join_url: meeting.join_url });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
for (const action of ["zoom_update_meeting", "zoom_update_meeting_by_id"])
  test(
    action + " checks ownership then sends only supplied fields",
    async () => {
      const f = fake();
      expect(
        await runManagedZoomAction(
          action,
          { auth, meeting_id: meeting.id, topic: "Changed" },
          f.request,
        ),
      ).toEqual({
        success: true,
        message: "Meeting updated successfully",
        meeting_id: String(meeting.id),
      });
      expect(f.calls.map((c) => c.init.method)).toEqual(["GET", "PATCH"]);
      expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({
        topic: "Changed",
      });
    },
  );
for (const patch of [
  { host_id: "another-user" },
  { type: 8 },
  { id: 98765432109 },
  { join_url: "https://attacker.test/j/12345678901" },
  { join_url: "https://zoom.us/j/12345678901?zak=secret" },
])
  test(
    "invalid ownership, series or response is refused before mutation " +
      JSON.stringify(patch),
    async () => {
      const f = fake({ ...meeting, ...patch });
      await expect(
        runManagedZoomAction(
          "zoom_update_meeting",
          { auth, meeting_id: meeting.id, topic: "Changed" },
          f.request,
        ),
      ).rejects.toThrow();
      expect(f.calls.map((c) => c.init.method)).toEqual(["GET"]);
    },
  );
for (const patch of [
  { schedule_for: "other" },
  { auto_recording: "cloud" },
  { waiting_room: false },
  { password: "new" },
  { start_time: "2030-02-30T14:00:00Z" },
  { start_time: "2020-01-01T00:00:00Z" },
  { duration: 0 },
  { duration: 1441 },
  { duration: "30" },
  { type: 8 },
  { topic: "" },
])
  test(
    "invalid or unsupported create fields fail without network " +
      JSON.stringify(patch),
    async () => {
      const f = fake();
      await expect(
        runManagedZoomAction(
          "zoom_create_meeting",
          {
            auth,
            topic: "Planning",
            start_time: "2030-06-01T14:00:00Z",
            ...patch,
          },
          f.request,
        ),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
for (const id of [
  "../users/me",
  "https://zoom.us/j/12345678901",
  1.5,
  "123",
  "12345678901?x=1",
])
  test("rejects non-meeting path " + id, async () => {
    const f = fake();
    await expect(
      runManagedZoomAction(
        "zoom_find_meeting",
        { auth, meeting_id: id },
        f.request,
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
test("unsupported actions, empty updates and recurring selectors cannot use the token", async () => {
  const f = fake();
  for (const action of [
    "custom_api_call",
    "zoom_delete_meeting",
    "zoom_create_meeting_registrant",
    "zoom_list_recordings",
  ])
    await expect(
      runManagedZoomAction(action, { auth }, f.request),
    ).rejects.toThrow();
  await expect(
    runManagedZoomAction(
      "zoom_update_meeting",
      { auth, meeting_id: meeting.id },
      f.request,
    ),
  ).rejects.toThrow();
  await expect(
    runManagedZoomAction(
      "zoom_find_meeting",
      { auth, meeting_id: meeting.id, occurrence_id: "1" },
      f.request,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test("a mutation timeout is uncertain, never retried or exposed as a provider body", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw new Error("PRIVATE_TOKEN");
  }) as unknown as typeof fetch;
  const error = await runManagedZoomAction(
    "zoom_create_meeting",
    { auth, topic: "Planning", start_time: "2030-06-01T14:00:00Z" },
    request,
  ).catch((e) => e);
  expect(String(error)).toContain("Check the meeting");
  expect(String(error)).not.toContain("PRIVATE");
  expect(calls).toBe(1);
});
for (const status of [401, 403, 429, 500])
  test(
    "provider refusal " + status + " is sanitized and never retried",
    async () => {
      let calls = 0;
      const request = (async () => {
        calls++;
        return new Response("PRIVATE_TOKEN", { status });
      }) as unknown as typeof fetch;
      const error = await runManagedZoomAction(
        "zoom_find_meeting",
        { auth, meeting_id: meeting.id },
        request,
      ).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("PRIVATE");
      expect(calls).toBe(1);
    },
  );
test("managed-only schema stays aligned and mutations have completion receipts", () => {
  for (const action of MANAGED_ZOOM_ACTIONS) {
    const schema = zoomInputSchema(action)!;
    expect(
      Object.keys(
        zoomEngineProps("@activepieces/piece-zoom", action, { auth })!,
      ),
    ).toEqual(schema.fields.map((f) => f.name));
    expect(
      resolveGovernedPieceAction("@activepieces/piece-zoom", action)?.known,
    ).toBe(true);
    expect(tracksPieceCompletion("@activepieces/piece-zoom", action)).toBe(
      action.includes("create") || action.includes("update"),
    );
  }
  expect(
    zoomEngineProps("@activepieces/piece-zoom", "zoom_create_meeting", {
      auth: { access_token: "manual" },
    }),
  ).toBeNull();
  expect(zoomInputSchema("zoom_list_recordings")).toBeNull();
});
test("an update that moves the start time keeps the meeting's own timezone", async () => {
  const f = fake({ ...meeting, timezone: "America/New_York" });
  await runManagedZoomAction(
    "zoom_update_meeting",
    { auth, meeting_id: meeting.id, start_time: "2030-07-01T15:00:00Z" },
    f.request,
  );
  // The Z suffix fixes the instant; sending timezone would also change how
  // Zoom shows the meeting to everyone invited.
  expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({
    start_time: "2030-07-01T15:00:00Z",
  });
});
const createInput = {
  auth,
  topic: "Planning",
  start_time: "2030-06-01T14:00:00Z",
};
for (const [label, response] of [
  ["an unexpected join URL", Response.json({ ...meeting, join_url: "https://attacker.test/j/12345678901" })],
  ["another host", Response.json({ ...meeting, host_id: "another-user" })],
  ["a non-JSON body", new Response("PRIVATE_TOKEN <html>", { status: 201 })],
  ["an empty body", new Response(null, { status: 201 })],
] as const)
  test("a create Zoom accepted but answered with " + label + " says the meeting exists", async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return response;
    }) as unknown as typeof fetch;
    const error = await runManagedZoomAction("zoom_create_meeting", createInput, request).catch((e) => e);
    expect(String(error)).toContain("Zoom created the meeting but");
    expect(String(error)).toContain("Check Zoom before retrying");
    expect(String(error)).not.toContain("PRIVATE");
    expect(calls).toBe(1);
  });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("a create that fails validation after dispatch posts no receipt, so a re-run cannot create a duplicate", async () => {
  const zoomCalls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    zoomCalls.push(String(init?.method) + " " + String(url));
    return Response.json({ ...meeting, join_url: "https://attacker.test/j/12345678901" });
  }) as typeof fetch;
  const receipts: string[] = [];
  const params = {
    apiUrl: "http://127.0.0.1:1",
    engineToken: "engine",
    piece: "@activepieces/piece-zoom",
    action: "zoom_create_meeting",
    stepName: "meeting",
    executionPath: [],
    input: createInput,
    fetchImpl: (async (url: string | URL | Request) => {
      receipts.push(String(url));
      return Response.json({});
    }) as typeof fetch,
  };
  await expect(
    executeAuthorizedPiece(
      params,
      { governed: true, dispatch: "authorized", effectId: "effect-1" } as any,
      async () => {
        throw new Error("the upstream piece must not run");
      },
    ),
  ).rejects.toThrow("Zoom created the meeting but");
  expect(zoomCalls).toEqual(["POST https://api.zoom.us/v2/users/me/meetings"]);
  // No completion receipt: the daemon keeps this tracked effect dispatching,
  // and a retry of a dispatching tracked effect is refused (recovery.test.ts).
  expect(receipts).toEqual([]);
  expect(tracksPieceCompletion(params.piece, params.action, params.input)).toBe(true);
});
