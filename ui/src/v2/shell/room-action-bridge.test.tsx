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
function TasksRoom({ tag = "", throws = false }: { tag?: string; throws?: boolean }) {
  bus.useRoomActions("tasks", (action, args) => {
    if (throws) throw new Error("handler bug");
    ran.push(`${tag}${action}:${String(args.title)}`);
    return true;
  });
  return null;
}
let live: ReturnType<typeof useWebSocket>;
type DispatchGuard = (request: import("../../hooks/useWebSocket").QueuedRoomActionRequest) => Promise<boolean>;
function Shell({ bridge = true, room = "plain", beforeDispatch }: { bridge?: boolean; room?: "plain" | "none" | "other" | "throws"; beforeDispatch?: DispatchGuard }) {
  live = useWebSocket();
  return (
    <bus.RoomActionBusProvider>
      {room === "plain" && <TasksRoom />}
      {room === "other" && <TasksRoom key="other" tag="other:" />}
      {room === "throws" && <TasksRoom key="throws" throws />}
      {bridge && <Bridge requests={live.roomActionRequests} ack={live.ackRoomActionRequests} forceIdle={() => {}} wsRef={live.wsRef} beforeDispatch={beforeDispatch} />}
    </bus.RoomActionBusProvider>
  );
}
const createTask = (id: string) => ({
  source: "room_action", room: "tasks", action: "create_task", args: { title: id }, resultId: id, resultFrom: "dashboard", expiresInMs: 60_000,
});
const answers = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === "room_action_result").map((m) => `${String(m.payload.resultId)}:${String(m.payload.outcome)}`);

async function mount(bridge = true, beforeDispatch?: DispatchGuard): Promise<FakeSocket> {
  ran.length = 0;
  await React.act(async () => root.render(<React.StrictMode><Shell bridge={bridge} beforeDispatch={beforeDispatch} /></React.StrictMode>));
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

// #1025: the dashboard's deadline for an action is on its own clock, which
// starts when it reads the message, so a late action could still run after
// the daemon had said it got no answer. The daemon now asks for a claim
// (`claim: true`), and the dashboard runs the action only once it is granted.
const claimed = (id: string) => ({ ...createTask(id), claim: true });
const claimsSent = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === "room_action_claim").map((m) => String(m.payload.resultId));
const grant = (socket: FakeSocket, resultId: string, granted: unknown) =>
  socket.onmessage?.({ data: JSON.stringify({ type: "room_action_claim_result", payload: { resultId, granted }, timestamp: 1 }) });

test("an action the daemon asks to be claimed runs only once the claim is granted", async () => {
  const socket = await mount();
  await React.act(async () => socket.receive(claimed("go"), 100));
  expect(claimsSent(socket)).toEqual(["go"]);
  expect(ran).toEqual([]);
  await React.act(async () => grant(socket, "go", true));
  expect(ran).toEqual(["create_task:go"]);
  expect(answers(socket)).toEqual(["go:accepted"]);
});

test("a refused claim runs nothing and answers nothing: the daemon has stopped waiting", async () => {
  const socket = await mount();
  // Each its own action: the first answer to a claim settles it.
  const refusals = [false, "true", 1, undefined, null];
  for (const [i, granted] of refusals.entries()) {
    await React.act(async () => socket.receive(claimed(`late-${i}`), 100));
    await React.act(async () => grant(socket, `late-${i}`, granted));
  }
  expect(claimsSent(socket)).toEqual(refusals.map((_, i) => `late-${i}`));
  // A grant for another id settles nothing here either.
  await React.act(async () => socket.receive(claimed("mine"), 100));
  await React.act(async () => grant(socket, "other", true));
  expect(ran).toEqual([]);
  expect(answers(socket)).toEqual([]);
});

test("a claim still open when the socket closes runs nothing", async () => {
  const socket = await mount();
  await React.act(async () => socket.receive(claimed("cut"), 100));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    await React.act(async () => socket.close());
  } finally {
    console.warn = warn;
  }
  // Refused there and then, not left waiting on an answer that cannot come.
  expect(warned.filter((w) => w.includes('Dropped "create_task"'))).toHaveLength(1);
  await React.act(async () => grant(socket, "cut", true));
  expect(ran).toEqual([]);
});

test("two claimed actions run in the order they came", async () => {
  const socket = await mount();
  await React.act(async () => {
    socket.receive(claimed("first"), 100);
    socket.receive(claimed("second"), 100);
  });
  expect(claimsSent(socket)).toEqual(["first", "second"]);
  await React.act(async () => { grant(socket, "first", true); grant(socket, "second", true); });
  expect(ran).toEqual(["create_task:first", "create_task:second"]);
});

test("a claimed action queued for a room still mounting claims, and runs on the room's handler once granted", async () => {
  ran.length = 0;
  await React.act(async () => root.render(<React.StrictMode><Shell room="none" /></React.StrictMode>));
  const socket = sockets.at(-1)!;
  await React.act(async () => { socket.open(); await Promise.resolve(); });
  await React.act(async () => socket.receive(claimed("queued"), 100));
  await React.act(async () => socket.receive(claimed("refused"), 100));
  expect(claimsSent(socket)).toEqual([]);
  await React.act(async () => root.render(<React.StrictMode><Shell room="plain" /></React.StrictMode>));
  // Drained from the queue, each asks first.
  expect(claimsSent(socket)).toEqual(["queued", "refused"]);
  expect(ran).toEqual([]);
  // The room is replaced while the claim is out: the grant runs it on the
  // handler there now.
  await React.act(async () => root.render(<React.StrictMode><Shell room="other" /></React.StrictMode>));
  await React.act(async () => { grant(socket, "queued", true); grant(socket, "refused", false); });
  expect(ran).toEqual(["other:create_task:queued"]);
  expect(answers(socket)).toEqual(["queued:accepted"]);
});

test("a handler that throws after its claim was granted answers that it did not run", async () => {
  ran.length = 0;
  await React.act(async () => root.render(<Shell room="throws" />));
  const socket = sockets.at(-1)!;
  await React.act(async () => { socket.open(); await Promise.resolve(); });
  await React.act(async () => socket.receive(claimed("broken"), 100));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await React.act(async () => grant(socket, "broken", true));
  } finally {
    console.warn = warn;
  }
  expect(answers(socket)).toEqual(["broken:rejected"]);
});


test("guarded dashboard actions wait for navigation and keep same-timestamp requests in order", async () => {
  const navigated: string[] = [];
  let allowFirst!: (allowed: boolean) => void;
  const gate = new Promise<boolean>(resolve => { allowFirst = resolve; });
  const socket = await mount(true, async request => {
    const id = String(request.args.title); navigated.push(id);
    return id === "first" ? gate : true;
  });
  await React.act(async () => {
    socket.receive(createTask("first"), 100);
    socket.receive(createTask("second"), 100);
  });
  expect(navigated).toEqual(["first"]);
  expect(ran).toEqual([]);
  expect(live.roomActionRequests).toEqual([]);
  await React.act(async () => allowFirst(true));
  expect(navigated).toEqual(["first", "second"]);
  expect(ran).toEqual(["create_task:first", "create_task:second"]);
  expect(answers(socket)).toEqual(["first:accepted", "second:accepted"]);
});

test("a socket that closes during guarded navigation cannot run the queued action", async () => {
  let allow!: (allowed: boolean) => void;
  const gate = new Promise<boolean>(resolve => { allow = resolve; });
  const socket = await mount(true, () => gate);
  await React.act(async () => socket.receive(createTask("gone"), 100));
  expect(ran).toEqual([]);
  await React.act(async () => socket.close());
  await React.act(async () => allow(true));
  expect(ran).toEqual([]);
  expect(answers(socket)).toEqual([]);
});

test("refused or failed navigation runs nothing and does not block later dashboard actions", async () => {
  const socket = await mount(true, async request => {
    if (request.args.title === "failed") throw new Error("navigation unavailable");
    return request.args.title !== "refused";
  });
  await React.act(async () => {
    for (const id of ["refused", "failed", "accepted"]) socket.receive(createTask(id), 100);
  });
  expect(ran).toEqual(["create_task:accepted"]);
  expect(answers(socket)).toEqual(["accepted:accepted"]);
});
