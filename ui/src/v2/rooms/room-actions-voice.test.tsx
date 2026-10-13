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

type Dispatch = (req: { room: string; action: string; args: Record<string, unknown>; ts: number }, onResult?: (ok: boolean) => void) => void;

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
