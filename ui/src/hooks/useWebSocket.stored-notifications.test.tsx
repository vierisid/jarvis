import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Drive the real hook with a fake socket: notifications a workflow sent while
// no dashboard was open come back from the daemon when the socket opens.
GlobalRegistrator.register();
const globals = globalThis as any;
const originals = { fetch: globalThis.fetch, socket: globalThis.WebSocket, act: globals.IS_REACT_ACT_ENVIRONMENT };
globals.IS_REACT_ACT_ENVIRONMENT = true;

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useWebSocket: typeof import("./useWebSocket").useWebSocket;
let state: ReturnType<typeof useWebSocket>;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
let sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send() {}
  close() { this.readyState = FakeSocket.CLOSED; }
}

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useWebSocket } = await import("./useWebSocket"));
});

beforeEach(async () => {
  sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/dashboard-notifications") {
      return new Response(JSON.stringify({ notifications: [{ id: "n1", message: "**Stand-up**\nStart at 9:00", priority: "urgent", created_at: 1000 }] }), { status: 200 });
    }
    if (url.startsWith("/api/authority/approvals")) return new Response("[]", { status: 200 });
    if (url.startsWith("/api/vault/conversations/active")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  function Harness() { state = useWebSocket(); return null; }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

afterAll(() => {
  globalThis.fetch = originals.fetch;
  globalThis.WebSocket = originals.socket;
  globals.IS_REACT_ACT_ENVIRONMENT = originals.act;
  GlobalRegistrator.unregister();
});

test("opening the dashboard shows the unread notifications saved while it was closed", async () => {
  const socket = sockets[0]!;
  socket.readyState = FakeSocket.OPEN;
  await act(async () => { await (socket.onopen as unknown as () => Promise<void>)(); });
  expect(state.notices).toEqual([{ id: "n1", title: "Stand-up", text: "Start at 9:00", level: "warning", source: "proactive", timestamp: 1000, stored: true }]);
});

test("the live copy of a saved notification replaces the loaded one instead of doubling it", async () => {
  const socket = sockets[0]!;
  socket.readyState = FakeSocket.OPEN;
  await act(async () => { await (socket.onopen as unknown as () => Promise<void>)(); });
  const frame = { id: "n1", type: "chat", payload: { text: "**Stand-up**\nStart at 9:00", source: "proactive", stored: true }, priority: "urgent", timestamp: 1000 };
  await act(async () => { socket.onmessage!({ data: JSON.stringify(frame) }); });
  expect(state.notices.map(n => n.id)).toEqual(["n1"]);
  expect(state.notices[0]!.stored).toBe(true);
});
