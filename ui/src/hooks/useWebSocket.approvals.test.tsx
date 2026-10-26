import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Drive the real hook: a fake socket, and a pending-approvals GET the test holds
// open so socket events can land between the request and its answer (#1087).
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
let releaseApprovals: Array<(rows: unknown[]) => void> = [];
let approvalFetches = 0;

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
  constructor() { sockets.push(this); }
  send() {}
  close() { this.readyState = FakeSocket.CLOSED; }
}

function row(id: string) {
  return { id, agent_name: "agent", tool_name: "send_email", action_category: "send_email", urgency: "normal", reason: `reason ${id}`, created_at: 1 };
}

function frame(source: "approval_request" | "approval_update", id: string, status = "approved") {
  // The daemon sends the whole row on both, plus impact and intent (ws-service.ts).
  const request = { id, agent_name: "agent", tool_name: "send_email", action_category: "send_email", urgency: "normal", reason: `reason ${id}`, status };
  const payload = { source, request, impact: "external", intent: `Send ${id}`, intent_action: `Send ${id}`, intent_reason: `reason ${id}`,
    ...(source === "approval_request" ? { shortId: id.slice(0, 8) } : {}) };
  return { data: JSON.stringify({ type: "notification", payload, timestamp: 2 }) };
}

const ids = () => state.approvals.map((a) => a.id);

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useWebSocket } = await import("./useWebSocket"));
});

beforeEach(async () => {
  sockets = [];
  releaseApprovals = [];
  approvalFetches = 0;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/authority/approvals")) {
      approvalFetches += 1;
      const rows = await new Promise<unknown[]>((resolve) => releaseApprovals.push(resolve));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
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

async function openUntilApprovalsRequested(socket: FakeSocket) {
  socket.readyState = FakeSocket.OPEN;
  await act(async () => { socket.onopen?.(); });
  for (let i = 0; i < 20 && approvalFetches === 0; i++) await act(async () => { await Promise.resolve(); });
  expect(approvalFetches).toBe(1);
}

async function answerApprovals(rows: unknown[]) {
  await act(async () => { releaseApprovals.shift()!(rows); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

async function deliver(socket: FakeSocket, event: { data: unknown }) {
  await act(async () => { socket.onmessage?.(event); });
}

describe("approval rehydrate on socket open merges with live events (#1087)", () => {
  test("an approval_request that lands while the pending list is in flight survives the answer", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_request", "live-new"));
    expect(ids()).toEqual(["live-new"]);
    // The server read its pending list before live-new existed.
    await answerApprovals([row("old-pending")]);
    expect(ids().sort()).toEqual(["live-new", "old-pending"]);
  });

  test("an approval settled while the list is in flight is not resurrected by the stale row", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_update", "settled"));
    // The server read its pending list before the approval was settled.
    await answerApprovals([row("settled"), row("still-pending")]);
    expect(ids()).toEqual(["still-pending"]);
  });

  test("a card requested and settled inside the window stays down", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_request", "blink"));
    await deliver(socket, frame("approval_update", "blink"));
    await answerApprovals([row("blink")]);
    expect(ids()).toEqual([]);
  });

  test("a card left from before the reconnect that the server no longer lists still comes down", async () => {
    const first = sockets[0]!;
    await openUntilApprovalsRequested(first);
    await answerApprovals([row("from-before")]);
    expect(ids()).toEqual(["from-before"]);

    // Socket drops; the approval is settled elsewhere while this dashboard is deaf.
    await act(async () => { first.onclose?.(); });
    // "Retry now": connects at once instead of waiting out the 2s backoff.
    await act(async () => { window.dispatchEvent(new Event("jarvis:ws-reconnect")); });
    const second = sockets[1]!;
    expect(second).toBeDefined();
    second.readyState = FakeSocket.OPEN;
    await act(async () => { second.onopen?.(); });
    for (let i = 0; i < 20 && approvalFetches < 2; i++) await act(async () => { await Promise.resolve(); });
    expect(approvalFetches).toBe(2);
    await answerApprovals([]);
    expect(ids()).toEqual([]);
  });

  test("an approval_update that still says pending does not count as settled", async () => {
    // A Brief document save re-files its approval and broadcasts the new,
    // still-pending row as an update (src/brief/decision-documents.ts).
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_update", "refiled", "pending"));
    await answerApprovals([row("refiled")]);
    expect(ids()).toEqual(["refiled"]);
  });

  test("a re-filed approval announced as a pending update shows its card live, outside any window", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await answerApprovals([]);
    await deliver(socket, frame("approval_update", "old", "expired"));
    await deliver(socket, frame("approval_update", "refiled", "pending"));
    expect(ids()).toEqual(["refiled"]);
    expect(state.approvals[0]).toMatchObject({ id: "refiled", intent: "Send refiled", category: "send_email", impact: "external", agentName: "agent", toolName: "send_email" });
  });

  test("a pending update inside the window keeps its card even when the server read predates it", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_update", "refiled", "pending"));
    await answerApprovals([row("other")]);
    expect(ids().sort()).toEqual(["other", "refiled"]);
  });

  test("a pending update for a card already shown refreshes it in place, never duplicates it", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await answerApprovals([row("first"), row("refiled")]);
    const changed = JSON.parse(frame("approval_update", "refiled", "pending").data as string);
    changed.payload.intent = changed.payload.intent_action = "Send the corrected draft";
    await deliver(socket, { data: JSON.stringify(changed) });
    expect(ids()).toEqual(["first", "refiled"]);
    expect(state.approvals[1]!.intent).toBe("Send the corrected draft");
  });

  test("a frame whose request has no id makes no card", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await answerApprovals([]);
    for (const source of ["approval_request", "approval_update"]) {
      const broken = JSON.parse(frame(source as "approval_request" | "approval_update", "x", "pending").data as string);
      delete broken.payload.request.id;
      await deliver(socket, { data: JSON.stringify(broken) });
    }
    expect(state.approvals).toEqual([]);
  });

  test("a settle is final: a request for the same id after it inside the window does not bring the card back", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_update", "x"));
    await deliver(socket, frame("approval_request", "x"));
    await answerApprovals([]);
    expect(ids()).toEqual([]);
  });

  test("a stale answer for a socket that has since been replaced changes nothing and leaves the new window open", async () => {
    const first = sockets[0]!;
    await openUntilApprovalsRequested(first);
    await act(async () => { first.onclose?.(); });
    // "Retry now": connects at once instead of waiting out the 2s backoff.
    await act(async () => { window.dispatchEvent(new Event("jarvis:ws-reconnect")); });
    const second = sockets[1]!;
    second.readyState = FakeSocket.OPEN;
    await act(async () => { second.onopen?.(); });
    for (let i = 0; i < 20 && approvalFetches < 2; i++) await act(async () => { await Promise.resolve(); });
    expect(approvalFetches).toBe(2);
    // The first socket's read answers late, after the second opened its window.
    await answerApprovals([row("stale")]);
    expect(ids()).toEqual([]);
    // The second window must still be open: a settle now beats the second answer.
    await deliver(second, frame("approval_update", "settled-late"));
    await answerApprovals([row("settled-late"), row("current")]);
    expect(ids()).toEqual(["current"]);
  });

  test("events after the answer apply as before", async () => {
    const socket = sockets[0]!;
    await openUntilApprovalsRequested(socket);
    await deliver(socket, frame("approval_update", "x"));
    await answerApprovals([row("a")]);
    expect(ids()).toEqual(["a"]);
    await deliver(socket, frame("approval_request", "b"));
    await deliver(socket, frame("approval_update", "a"));
    expect(ids()).toEqual(["b"]);
  });
});
