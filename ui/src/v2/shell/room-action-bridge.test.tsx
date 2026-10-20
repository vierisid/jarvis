/**
 * #1024: every room action the daemon sends a dashboard reaches its room. The
 * request used to be one slot of React state, and the bridge ran on a change
 * of the message's millisecond timestamp, so two actions handled before a
 * render, or stamped in the same millisecond, ran only one: a realtime reply
 * with two dashboard_room_action calls lost one, and the daemon reported it
 * as no answer. This drives the real socket hook, bridge and bus.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:4389/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let useWebSocket: typeof import("../../hooks/useWebSocket").useWebSocket;
let bus: typeof import("../rooms/useRoomActionBus");
let Bridge: typeof import("./RoomActionBridge").RoomActionBridge;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let originalFetch: typeof fetch;
let OriginalWebSocket: typeof WebSocket;

class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  readyState = 0; binaryType = ""; sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(payload: unknown, timestamp: number) {
    this.onmessage?.({ data: JSON.stringify({ type: "notification", payload, timestamp }) });
  }
}
const sockets: FakeSocket[] = [];

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ useWebSocket } = await import("../../hooks/useWebSocket"));
  bus = await import("../rooms/useRoomActionBus");
  ({ RoomActionBridge: Bridge } = await import("./RoomActionBridge"));
});
beforeEach(() => {
  sockets.length = 0;
  originalFetch = globalThis.fetch; OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await React.act(async () => root.unmount()); host.remove();
  globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket;
});
afterAll(() => GlobalRegistrator.unregister());

const ran: string[] = [];
function TasksRoom() {
  bus.useRoomActions("tasks", (action, args) => {
    ran.push(`${action}:${String(args.title)}`);
    return true;
  });
  return null;
}
let live: ReturnType<typeof useWebSocket>;
function Shell({ bridge = true }: { bridge?: boolean }) {
  live = useWebSocket();
  return (
    <bus.RoomActionBusProvider>
      <TasksRoom />
      {bridge && <Bridge requests={live.roomActionRequests} ack={live.ackRoomActionRequests} forceIdle={() => {}} wsRef={live.wsRef} />}
    </bus.RoomActionBusProvider>
  );
}
const createTask = (id: string) => ({
  source: "room_action", room: "tasks", action: "create_task", args: { title: id }, resultId: id, resultFrom: "dashboard", expiresInMs: 60_000,
});
const answers = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === "room_action_result").map((m) => `${String(m.payload.resultId)}:${String(m.payload.outcome)}`);

async function mount(bridge = true): Promise<FakeSocket> {
  ran.length = 0;
  await React.act(async () => root.render(<React.StrictMode><Shell bridge={bridge} /></React.StrictMode>));
  const socket = sockets.at(-1)!;
  await React.act(async () => { socket.open(); await Promise.resolve(); });
  return socket;
}

test("two actions that arrive before a render both run, and both are answered", async () => {
  const socket = await mount();
  await React.act(async () => {
    socket.receive(createTask("first"), 100);
    socket.receive(createTask("second"), 101);
  });
  expect(ran).toEqual(["create_task:first", "create_task:second"]);
  expect(answers(socket)).toEqual(["first:accepted", "second:accepted"]);
  // Taken off the queue once run: it does not grow with every action.
  expect(live.roomActionRequests).toEqual([]);
});

test("two actions stamped in the same millisecond both run, in separate renders", async () => {
  const socket = await mount();
  await React.act(async () => socket.receive(createTask("first"), 100));
  await React.act(async () => socket.receive(createTask("second"), 100));
  expect(ran).toEqual(["create_task:first", "create_task:second"]);
  expect(answers(socket)).toEqual(["first:accepted", "second:accepted"]);
});

test("an action runs once, however often the shell renders", async () => {
  const socket = await mount();
  await React.act(async () => socket.receive(createTask("only"), 100));
  await React.act(async () => root.render(<React.StrictMode><Shell /></React.StrictMode>));
  await React.act(async () => socket.receive({ source: "navigate_room", key: "tasks" }, 200));
  expect(ran).toEqual(["create_task:only"]);
  expect(answers(socket)).toEqual(["only:accepted"]);
});

test("a bridge that mounts onto a waiting queue runs each action once, StrictMode or not", async () => {
  const socket = await mount(false);
  await React.act(async () => socket.receive(createTask("waiting"), 100));
  expect(ran).toEqual([]);
  // StrictMode runs a new effect twice, before the ack has landed.
  await React.act(async () => root.render(<React.StrictMode><Shell /></React.StrictMode>));
  expect(ran).toEqual(["create_task:waiting"]);
  expect(answers(socket)).toEqual(["waiting:accepted"]);
});

test("an action that went stale before a bridge mounted is taken off the queue, not run", async () => {
  const socket = await mount(false);
  // A presentation action carries no deadline of its own; its age is the bound.
  await React.act(async () => socket.receive({ source: "room_action", room: "tasks", action: "set_filter", args: { title: "stale" } }, 100));
  const realNow = performance.now.bind(performance);
  const later = realNow() + 60_000;
  performance.now = () => later;
  try {
    await React.act(async () => root.render(<React.StrictMode><Shell /></React.StrictMode>));
  } finally {
    performance.now = realNow;
  }
  expect(ran).toEqual([]);
  expect(live.roomActionRequests).toEqual([]);
});
