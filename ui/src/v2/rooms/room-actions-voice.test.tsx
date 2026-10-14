/**
 * #969: a voice room action reaches the room's handler only when the room
 * carries it out (ROOM_ACTIONS), and Authority never takes a grant or revoke
 * from one. The daemon refuses these before it broadcasts; this is the
 * dashboard's half, so a room_action from any daemon path still cannot write
 * an authority override. Real AuthorityRoom body, real RoomActionBus.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Bus = typeof import("./useRoomActionBus");
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let bus: Bus;
let AuthorityRoomBody: React.ComponentType<{ mode: "inline" | "expanded" }>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("./useRoomActionBus");
  AuthorityRoomBody = (await import("./authority/AuthorityRoom")).AuthorityRoomBody;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

type Dispatch = (req: import("./useRoomActionBus").RoomActionRequest, onResult?: (ok: boolean) => void) => void;

async function mount(children: React.ReactNode): Promise<{ dispatch: Dispatch; posts: string[] }> {
  let dispatch!: Dispatch;
  const posts: string[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") posts.push(String(input));
    return NativeResponse.json([]);
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), children));
  });
  await act(async () => { await Promise.resolve(); });
  return { dispatch, posts };
}

async function send(dispatch: Dispatch, room: string, action: string, args: Record<string, unknown>): Promise<boolean | undefined> {
  let result: boolean | undefined;
  await act(async () => {
    dispatch({ room, action, args, ts: Date.now() }, (ok) => { result = ok; });
  });
  // Let any async work the handler started reach fetch.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return result;
}

test("Authority refuses a voice grant or revoke and writes no override", async () => {
  for (const mode of ["inline", "expanded"] as const) {
    const { dispatch, posts } = await mount(React.createElement(AuthorityRoomBody, { mode }));
    for (const action of ["grant_access", "revoke_access"]) {
      expect(`${mode}:${action}:${await send(dispatch, "authority", action, { action: "send_email" })}`)
        .toBe(`${mode}:${action}:false`);
    }
    expect(posts).toEqual([]);
    // Not vacuous: the room is mounted and answering.
    expect(await send(dispatch, "authority", "switch_tab", { tab: "audit" })).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
  }
});

test("the bus refuses an action the room does not carry out, without calling its handler", async () => {
  const seen: string[] = [];
  function Room() {
    bus.useRoomActions("goals", (action) => { seen.push(action); return true; });
    return null;
  }
  const { dispatch } = await mount(React.createElement(Room));
  expect(await send(dispatch, "goals", "delete_everything", {})).toBe(false);
  expect(await send(dispatch, "goals", "search", { query: "q3" })).toBe(true);
  expect(seen).toEqual(["search"]);
});

test("an action the room does not carry out is refused at once, not queued for the room to mount", async () => {
  let dispatch!: Dispatch;
  const seen: string[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  function Room() {
    bus.useRoomActions("authority", (action) => { seen.push(action); return true; });
    return null;
  }
  function Late({ on }: { on: boolean }) { return on ? React.createElement(Room) : null; }
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  const render = (on: boolean) => root!.render(
    React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(Late, { on })));
  await act(async () => { render(false); });
  const results: boolean[] = [];
  await act(async () => {
    dispatch({ room: "authority", action: "grant_access", args: { action: "send_email" }, ts: Date.now() }, (ok) => results.push(ok));
    dispatch({ room: "authority", action: "switch_tab", args: { tab: "audit" }, ts: Date.now() }, (ok) => results.push(ok));
    // A room that has no handler at all ("usage") would otherwise never answer.
    dispatch({ room: "usage", action: "switch_tab", args: {}, ts: Date.now() }, (ok) => results.push(ok));
  });
  // Refused before anything mounted; the listed action waits for the room.
  expect(results).toEqual([false, false]);
  await act(async () => { render(true); });
  await act(async () => { await Promise.resolve(); });
  expect(results).toEqual([false, false, true]);
  expect(seen).toEqual(["switch_tab"]);
});

// #1010: the realtime path stops waiting after REALTIME_ROOM_ACTION_WAIT_MS
// (3500ms) and tells the model it can't tell whether the action happened, but
// the bus kept a queued action for ROOM_ACTION_QUEUE_TTL_MS (5000ms). A room
// that mounted in between ran the first call alongside the model's retry.
test("an action the daemon stopped waiting for does not run, queued or not", async () => {
  let dispatch!: Dispatch;
  const seen: string[] = [];
  const results: Array<[string, boolean]> = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  function Room() {
    bus.useRoomActions("tasks", (action, args) => { seen.push(`${action}:${String(args.title)}`); return true; });
    return null;
  }
  function Late({ on }: { on: boolean }) { return on ? React.createElement(Room) : null; }
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  const render = (on: boolean) => root!.render(
    React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(Late, { on })));
  await act(async () => { render(false); });
  const ts = Date.now();
  const now = performance.now();
  let socketOpen = true;
  await act(async () => {
    // Queued while the room mounts: one the daemon gives up on before the
    // room is there, one whose socket closes (the daemon gives up on that at
    // once), and one it is still waiting for.
    dispatch({ room: "tasks", action: "create_task", args: { title: "given up" }, ts, expiresAt: now + 30 },
      (ok) => results.push(["given up", ok]));
    dispatch({ room: "tasks", action: "create_task", args: { title: "socket closed" }, ts, expiresAt: now + 60_000, stillAsked: () => socketOpen },
      (ok) => results.push(["socket closed", ok]));
    dispatch({ room: "tasks", action: "create_task", args: { title: "still waited" }, ts, expiresAt: now + 60_000, stillAsked: () => true },
      (ok) => results.push(["still waited", ok]));
  });
  socketOpen = false;
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await act(async () => { render(true); });
  await act(async () => { await Promise.resolve(); });
  expect(seen).toEqual(["create_task:still waited"]);
  // The dropped ones are not reported: the daemon no longer listens for them.
  expect(results).toEqual([["still waited", true]]);
  // Mounted, an action that arrives already past its wait is dropped too.
  await act(async () => {
    dispatch({ room: "tasks", action: "create_task", args: { title: "late" }, ts, expiresAt: performance.now() - 1 });
    dispatch({ room: "tasks", action: "create_task", args: { title: "asker gone" }, ts, stillAsked: () => false });
    dispatch({ room: "tasks", action: "create_task", args: { title: "no deadline" }, ts });
  });
  expect(seen).toEqual(["create_task:still waited", "create_task:no deadline"]);
});

// #1008: a held voice action arrives with the item the person approved pinned
// by id. The real Workspaces room acts on that one, not on what the name or
// the selection would pick now, and on none when it is gone.
test("Workspaces acts on the pinned project, or on none", async () => {
  const { WorkspacesRoomBody } = await import("./workspaces/WorkspacesRoom");
  const project = (id: string, name: string) => ({
    id, name, path: `/p/${id}`, framework: "vite-react", devPort: null, devServerPid: null, status: "running",
    gitBranch: null, gitDirty: false, createdAt: 0, lastOpenedAt: 0, githubUrl: null,
  });
  const posts: string[] = [];
  let dispatch!: Dispatch;
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") { posts.push(String(input)); return NativeResponse.json({ ok: true, message: "stopped" }); }
    return NativeResponse.json([project("p1", "demo"), project("p2", "demo-old")]);
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe),
      React.createElement(WorkspacesRoomBody, { mode: "expanded" })));
  });
  // Let the room load its list.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // Not vacuous: by name alone it is p1, the exact match.
  expect(await send(dispatch, "workspaces", "stop_server", { name: "demo" })).toBe(true);
  expect(posts).toEqual(["/api/sites/projects/p1/stop"]);
  posts.length = 0;
  // The pinned id says p2, and p2 is what runs.
  expect(await send(dispatch, "workspaces", "stop_server", { name: "demo", id: "p2" })).toBe(true);
  expect(posts).toEqual(["/api/sites/projects/p2/stop"]);
  posts.length = 0;
  // A pinned project that is gone is nothing, not the name's match.
  expect(await send(dispatch, "workspaces", "stop_server", { name: "demo", id: "gone" })).toBe(false);
  expect(posts).toEqual([]);
});

/** Mount `element` in a real bus, its GETs answered with `list`; returns the dispatcher and the writes. */
async function mountRoom(element: React.ReactElement, list: unknown[] | null): Promise<{ dispatch: Dispatch; posts: string[] }> {
  const posts: string[] = [];
  let dispatch!: Dispatch;
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") { posts.push(`${init!.method} ${String(input)}`); return NativeResponse.json({ ok: true, message: "done" }); }
    return list === null ? new NativeResponse("{}", { status: 404 }) : NativeResponse.json(list);
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), element)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { dispatch, posts };
}

test("Content advances the pinned item, and a name that matches nothing is not the selection", async () => {
  const { ContentRoomBody } = await import("./content/ContentRoom");
  const item = (id: string, title: string) => ({ id, title, body: "", content_type: "blog", stage: "idea", tags: [], created_at: 0, updated_at: 0, scheduled_at: null, published_at: null, published_url: null, created_by: "user", sort_order: 0 });
  const { dispatch, posts } = await mountRoom(React.createElement(ContentRoomBody, { mode: "expanded" }), [item("c1", "Launch post"), item("c2", "Q3 recap")]);
  expect(await send(dispatch, "content", "select", { name: "launch" })).toBe(true);
  // The old case fell back to the selection here and advanced "Launch post".
  expect(await send(dispatch, "content", "advance", { name: "zzz" })).toBe(false);
  expect(posts).toEqual([]);
  expect(await send(dispatch, "content", "advance", { name: "Launch post", id: "c2" })).toBe(true);
  expect(posts).toEqual(["POST /api/content/c2/advance"]);
});

test("Tasks completes the pinned task, not the first by that name", async () => {
  const { TasksRoomBody } = await import("./tasks/TasksRoom");
  const task = (id: string) => ({ id, what: "Pay rent", when_due: null, context: null, priority: "normal", status: "pending", assigned_to: null, created_from: null, created_at: 0, completed_at: null, result: null, retry_policy: null, sort_order: 0 });
  const { dispatch, posts } = await mountRoom(React.createElement(TasksRoomBody, { mode: "expanded" }), [task("t1"), task("t2")]);
  // Not vacuous: by name alone it is t1.
  expect(await send(dispatch, "tasks", "complete_task", { name: "Pay rent" })).toBe(true);
  expect(posts).toEqual(["PATCH /api/vault/commitments/t1"]);
  posts.length = 0;
  expect(await send(dispatch, "tasks", "complete_task", { name: "Pay rent", id: "t2" })).toBe(true);
  expect(posts).toEqual(["PATCH /api/vault/commitments/t2"]);
});

test("Settings refuses a voice change with no voice, rather than set the voice \"undefined\"", async () => {
  const { SettingsRoomBody } = await import("./settings/SettingsRoom");
  const bodies: string[] = [];
  // Nothing loads (404): the room renders with no config, and still takes actions.
  const { dispatch, posts } = await mountRoom(React.createElement(SettingsRoomBody, { mode: "expanded" }), null);
  const stub = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") bodies.push(String(init?.body));
    return stub(input, init);
  }) as typeof fetch;
  expect(await send(dispatch, "settings", "set_tts_voice", {})).toBe(false);
  expect(await send(dispatch, "settings", "set_tts_voice", { voice: "  " })).toBe(false);
  expect(posts).toEqual([]);
  // Not vacuous: a real voice is sent.
  expect(await send(dispatch, "settings", "set_tts_voice", { voice: "en-GB-Ryan" })).toBe(true);
  expect(posts.filter((p) => p.endsWith("/api/config/tts"))).toHaveLength(1);
  expect(bodies.some((b) => b.includes('"voice":"en-GB-Ryan"'))).toBe(true);
});

test("the dashboard ties an action it answers to the socket it came on (#1010)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../hooks/useWebSocket.ts", import.meta.url), "utf8");
  // Closing a socket makes every action it was asked to answer stale.
  const onclose = src.slice(src.indexOf("ws.onclose = () => {"), src.indexOf("ws.onerror"));
  expect(onclose).toContain("socketGenerationRef.current += 1;");
  expect(src).toContain("req.stillAsked = () => socketGenerationRef.current === socket;");
});
