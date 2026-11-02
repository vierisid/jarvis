import { expect, test } from "bun:test";
import {
  runManagedCalendlyAction as run,
  MANAGED_CALENDLY_ACTIONS,
} from "./managed-calendly";
import {
  MANAGED_PIECE_ADAPTERS,
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "./piece-effects";
/** Every action of the pinned @activepieces/piece-calendly 0.7.1 bundle, read
 * from its `actions()` (custom_api_call is added by the framework and stays
 * unmapped). The engine test checks the installed package against the adapter. */
const CALENDLY_071_ACTIONS = [
  "cancel_scheduled_event", "create_event_type", "create_one_off_event_type", "create_scheduling_link",
  "create_share", "find_invitee_bookings", "find_user", "get_event_invitee", "get_event_type_availability",
  "get_event_type", "get_organization_membership", "get_organization", "get_scheduled_event",
  "get_user_availability_schedule", "get_user", "list_available_times", "list_event_invitees",
  "list_event_type_hosts", "list_event_types", "list_organization_memberships", "list_scheduled_events",
  "list_user_availability_schedules", "list_user_busy_times", "list_user_locations",
  "update_event_type_availability", "update_event_type",
];
const auth = {
  jarvis_managed: "calendly",
  secret_text: "PRIVATE",
  jarvis_user: "u1",
};
const empty = {
  collection: [],
  pagination: { count: 0, next_page_token: null },
};
const fetcher = (v: unknown) =>
  (async () => Response.json(v)) as unknown as typeof fetch;
test("the Calendly adapter names every action of the pinned bundle, and nothing else", () => {
  const piece = "@activepieces/piece-calendly";
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === piece)!;
  expect(CALENDLY_071_ACTIONS).toHaveLength(26);
  expect((Object.values(adapter.categories).flat() as string[]).sort()).toEqual([...CALENDLY_071_ACTIONS].sort());
  expect(resolveGovernedPieceAction(piece, "custom_api_call")).toMatchObject({category: "modify_settings", known: false});
  expect(resolveGovernedPieceAction(piece, "cancel_scheduled_event")).toMatchObject({category: "delete_data", known: true});
  expect(resolveGovernedPieceAction(piece, "list_user_busy_times")).toMatchObject({category: "read_data", known: true});
  expect(resolveGovernedPieceAction(piece, "update_event_type")).toMatchObject({category: "write_data", known: true});
  // Every change is tracked so a retry after a lost response is refused; reads never are.
  expect(CALENDLY_071_ACTIONS.filter((a) => tracksPieceCompletion(piece, a)).sort()).toEqual(
    ["cancel_scheduled_event", "create_event_type", "create_one_off_event_type", "create_scheduling_link",
      "create_share", "update_event_type", "update_event_type_availability"]);
  for (const action of MANAGED_CALENDLY_ACTIONS) expect(CALENDLY_071_ACTIONS).toContain(action);
});
test("five qualified actions have exact categories and only link writes need a receipt", () => {
  for (const name of MANAGED_CALENDLY_ACTIONS) {
    expect(
      resolveGovernedPieceAction("@activepieces/piece-calendly", name),
    ).toMatchObject({
      known: true,
      category: name === "create_scheduling_link" ? "write_data" : "read_data",
    });
    expect(tracksPieceCompletion("@activepieces/piece-calendly", name)).toBe(
      name === "create_scheduling_link",
    );
  }
});
test("one-page listing uses the connected user and preserves opaque cursors and filters", async () => {
  let url = "";
  const request = (async (u: string | URL | Request, i?: RequestInit) => {
    url = String(u);
    expect(i?.redirect).toBe("error");
    expect(i?.method).toBe("GET");
    return Response.json(empty);
  }) as unknown as typeof fetch;
  expect(
    await run(
      "list_scheduled_events",
      {
        auth,
        count: 100,
        pageToken: "opaque+/=",
        inviteeEmail: "alex@example.test",
        status: "active",
        minStartTime: "2026-10-28T10:00:00Z",
        maxStartTime: "2026-10-29T10:00:00Z",
      },
      request,
    ),
  ).toEqual({ items: [], count: 0, next_page_token: null });
  const u = new URL(url);
  expect(u.origin).toBe("https://api.calendly.com");
  expect(u.searchParams.get("user")).toBe("https://api.calendly.com/users/u1");
  expect(u.searchParams.get("page_token")).toBe("opaque+/=");
  expect(u.searchParams.get("invitee_email")).toBe("alex@example.test");
});
test("single-use link sends only the reviewed body and returns the resource directly", async () => {
  const value = {
    booking_url: "https://calendly.com/d/test/link",
    owner: "https://api.calendly.com/event_types/t1",
    owner_type: "EventType",
  };
  let calls = 0;
  expect(
    await run("create_scheduling_link", { auth, eventType: "t1" }, (async (
      u: string | URL | Request,
      i?: RequestInit,
    ) => {
      calls++;
      expect(String(u)).toBe("https://api.calendly.com/scheduling_links");
      expect(i?.method).toBe("POST");
      expect(JSON.parse(String(i?.body))).toEqual({
        max_event_count: 1,
        owner: value.owner,
        owner_type: "EventType",
      });
      return Response.json({ resource: value });
    }) as unknown as typeof fetch),
  ).toEqual(value);
  expect(calls).toBe(1);
});
test("untrusted URIs, unsupported actions, malformed filters and other-user listings fail before dispatch", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json(empty);
  }) as unknown as typeof fetch;
  for (const [name, input] of [
    ["cancel_scheduled_event", {}],
    ["list_scheduled_events", { organization: "o1" }],
    ["list_event_types", { user: "other" }],
    [
      "get_scheduled_event",
      { scheduledEvent: "https://evil.test/scheduled_events/e1" },
    ],
    [
      "get_scheduled_event",
      {
        scheduledEvent: "https://api.calendly.com/other/../scheduled_events/e1",
      },
    ],
    [
      "create_scheduling_link",
      { eventType: "https://api.calendly.com/event_types/t1?secret=x" },
    ],
    ["list_event_invitees", { scheduledEvent: "e1", count: 101 }],
    ["list_scheduled_events", { status: "unknown" }],
    ["list_scheduled_events", { minStartTime: "yesterday" }],
    [
      "list_scheduled_events",
      {
        minStartTime: "2026-10-29T00:00:00Z",
        maxStartTime: "2026-10-28T00:00:00Z",
      },
    ],
  ] as const)
    await expect(run(name, { auth, ...input }, request)).rejects.toThrow();
  expect(calls).toBe(0);
});
test("provider failures are redacted and writes are not automatically retried", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await expect(
      run("create_scheduling_link", { auth, eventType: "t1" }, (async () => {
        calls++;
        return new Response("PRIVATE", { status });
      }) as unknown as typeof fetch),
    ).rejects.not.toThrow("PRIVATE");
    expect(calls).toBe(1);
  }
});
test("invalid pages and foreign event identities cannot look successful", async () => {
  for (const value of [
    [],
    {},
    { collection: [], pagination: { count: 1 } },
    { ...empty, huge: "x".repeat(1048576) },
    { collection: [{}], pagination: { count: 1 } },
  ])
    await expect(
      run("list_scheduled_events", { auth }, fetcher(value)),
    ).rejects.toThrow();
  await expect(
    run(
      "get_scheduled_event",
      { auth, scheduledEvent: "e1" },
      fetcher({
        resource: {
          uri: "https://api.calendly.com/scheduled_events/e2",
          name: "Meeting",
          status: "active",
          start_time: "2026-10-28T10:00:00Z",
          end_time: "2026-10-28T11:00:00Z",
          event_type: "https://api.calendly.com/event_types/t1",
        },
      }),
    ),
  ).rejects.toThrow();
});
