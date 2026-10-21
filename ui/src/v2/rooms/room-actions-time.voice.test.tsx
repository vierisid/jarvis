/**
 * The time a voice room action is for (#1035): a create_task or
 * schedule_event whose `when` the room could not read made the item with no
 * date and answered yes, so the person believed something was scheduled that
 * would never fire. content/schedule already refused (#1032). This runs the
 * real room bodies behind a real RoomActionBus and reads what they send.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Bus = typeof import("./useRoomActionBus");
type Body = React.ComponentType<{ mode: "inline" | "expanded" }>;
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let bus: Bus;
let bodies: Record<string, Body>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("./useRoomActionBus");
  bodies = {
    tasks: (await import("./tasks/TasksRoom")).TasksRoomBody,
    content: (await import("./content/ContentRoom")).ContentRoomBody,
    calendar: (await import("./calendar/CalendarRoom")).CalendarRoomBody,
  };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

const NOW = Date.now();
const CONTENT = { id: "c1", title: "Launch post", content_type: "blog", stage: "draft", body: "", tags: [], scheduled_at: null, published_at: null, published_url: null, created_by: "user", sort_order: 0, created_at: NOW, updated_at: NOW };

function getReply(url: string): Response {
  if (url.startsWith("/api/vault/commitments")) return NativeResponse.json([]);
  if (url === "/api/content") return NativeResponse.json([CONTENT]);
  if (url.startsWith("/api/calendar")) return NativeResponse.json([]);
  return new NativeResponse("", { status: 404 });
}

/** A write the room sent: method, path and the JSON body. */
type Sent = { url: string; body: Record<string, unknown> };

async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

const okBody = { ok: true, id: "new-1", what: "New", item: CONTENT };

async function mount(room: string) {
  let dispatch: ReturnType<Bus["useRoomActionDispatcher"]>["dispatch"] | undefined;
  const sent: Sent[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") return getReply(url);
    sent.push({ url: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return NativeResponse.json(okBody);
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(bodies[room]!, { mode: "expanded" })));
  });
  await until(() => dispatch !== undefined && (room !== "content" || (host.textContent ?? "").includes(CONTENT.title)), `${room} to load`);
  /** Send `action` and wait for the room's answer. */
  const run = async (action: string, args: Record<string, unknown>): Promise<string> => {
    let answer: string | undefined;
    await act(async () => {
      dispatch!({ room, action, args, ts: Date.now() }, (ok, outcome) => { answer = `${ok} ${outcome}`; });
    });
    await until(() => answer !== undefined, `${room}/${action} to answer`);
    return answer!;
  };
  return { run, sent };
}

test("a time that does not read as one is refused, and nothing is written (#1035)", async () => {
  for (const [room, action, args, says] of [
    ["tasks", "create_task", { title: "Pay rent", when: "whenever-ish" }, 'Couldn\'t read "whenever-ish" as a time, so no task was created.'],
    // Read as Tuesday at 09:00 before: the hour was dropped.
    ["tasks", "create_task", { title: "Pay rent", when: "tuesday at 3" }, 'Couldn\'t read "tuesday at 3" as a time, so no task was created.'],
    ["calendar", "schedule_event", { title: "Dentist", when: "later today" }, 'Couldn\'t read "later today" as a time, so nothing was scheduled.'],
    ["calendar", "schedule_event", { title: "Dentist", when: "2026-02-30" }, 'Couldn\'t read "2026-02-30" as a time, so nothing was scheduled.'],
    // Refused already (#1032), side by side with the other two.
    ["content", "schedule", { name: "Launch post", when: "later today" }, "Couldn't parse that date."],
  ] as const) {
    const { run, sent } = await mount(room);
    expect([action, args.when, await run(action, args)]).toEqual([action, args.when, "false rejected"]);
    expect(sent).toEqual([]);
    expect(host.textContent).toContain(says);
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
  }
});

test("with no time asked for, the item is made undated, as before", async () => {
  for (const [room, action, args] of [
    ["tasks", "create_task", { title: "Pay rent" }],
    ["tasks", "create_task", { title: "Pay rent", when: "  " }],
    ["calendar", "schedule_event", { title: "Dentist" }],
  ] as const) {
    const { run, sent } = await mount(room);
    expect(await run(action, args)).toBe("true accepted");
    expect(sent.map((s) => [s.url, s.body.when_due])).toEqual([["POST /api/vault/commitments", undefined]]);
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
  }
});

test("a time that reads is written with the item", async () => {
  for (const [room, action, args] of [
    ["tasks", "create_task", { title: "Pay rent", when: "2030-05-01 15:00" }],
    ["calendar", "schedule_event", { title: "Dentist", when: "2030-05-01 15:00" }],
  ] as const) {
    const { run, sent } = await mount(room);
    expect(await run(action, args)).toBe("true accepted");
    expect(sent.map((s) => [s.url, s.body.when_due])).toEqual([["POST /api/vault/commitments", new Date(2030, 4, 1, 15, 0).getTime()]]);
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
  }
});
