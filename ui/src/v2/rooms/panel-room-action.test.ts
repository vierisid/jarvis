/**
 * #933: a native panel answers a room_action that carries a resultId, so the
 * daemon can say whether the tab switched instead of assuming it did.
 */
import { expect, test } from "bun:test";
import { dispatchDashboardRoomAction, handlePanelRoomActionMessage } from "./panel-room-action";

type Req = { room: string; action: string; args: Record<string, unknown> };

function run(raw: unknown, handlerResult: boolean | null) {
  const dispatched: Req[] = [];
  const sent: unknown[] = [];
  handlePanelRoomActionMessage(
    raw,
    (req, onResult) => {
      dispatched.push({ room: req.room, action: req.action, args: req.args });
      if (handlerResult !== null) onResult?.(handlerResult, handlerResult ? "accepted" : "rejected");
    },
    (text) => sent.push(JSON.parse(text)),
  );
  return { dispatched, sent };
}

const note = (extra: Record<string, unknown>) => JSON.stringify({
  type: "notification",
  payload: { source: "room_action", room: "settings", action: "switch_tab", args: { tab: "voice" }, ...extra },
});

test("answers with the room's verdict when the daemon asked", () => {
  for (const verdict of [true, false]) {
    const { dispatched, sent } = run(note({ resultId: "r1" }), verdict);
    expect(dispatched).toEqual([{ room: "settings", action: "switch_tab", args: { tab: "voice" } }]);
    expect(sent).toEqual([expect.objectContaining({ type: "room_action_result", payload: { resultId: "r1", accepted: verdict, outcome: verdict ? "accepted" : "rejected" } })]);
  }
});

test("does not answer when the daemon did not ask", () => {
  for (const extra of [{}, { resultId: "" }, { resultId: 7 }]) {
    const { dispatched, sent } = run(note(extra), true);
    expect(dispatched.length).toBe(1);
    expect(sent).toEqual([]);
  }
});

test("ignores anything that is not a room_action notification", () => {
  for (const raw of ["not json", JSON.stringify({ type: "stream" }), JSON.stringify({ type: "notification", payload: { source: "other" } }), new ArrayBuffer(2)]) {
    const { dispatched, sent } = run(raw, true);
    expect(dispatched).toEqual([]);
    expect(sent).toEqual([]);
  }
});

test("the dashboard answers only an action it was asked about (#965)", () => {
  for (const verdict of [true, false]) {
    const sent: unknown[] = [];
    const dispatched: unknown[] = [];
    dispatchDashboardRoomAction(
      { room: "agents", action: "switch_tab", args: { tab: "builder" }, ts: 1, resultId: "r9" },
      (req, onResult) => { dispatched.push(req); onResult?.(verdict, verdict ? "accepted" : "rejected"); },
      (text) => sent.push(JSON.parse(text)),
    );
    // The room sees the action, not the resultId; and a way to say it has
    // started (#1015).
    expect(dispatched).toEqual([{ room: "agents", action: "switch_tab", args: { tab: "builder" }, ts: 1, onStarted: expect.any(Function) }]);
    expect(sent).toEqual([expect.objectContaining({ type: "room_action_result", payload: { resultId: "r9", accepted: verdict, outcome: verdict ? "accepted" : "rejected" } })]);
  }
  const sent: unknown[] = [];
  let callback: unknown = "unset";
  dispatchDashboardRoomAction(
    { room: "agents", action: "switch_tab", args: { tab: "builder" }, ts: 1 },
    (_req, onResult) => { callback = onResult; onResult?.(true, "accepted"); },
    (text) => sent.push(text),
  );
  expect(callback).toBeUndefined();
  expect(sent).toEqual([]);
});

test("a room's pending answer reaches the daemon as pending, not as a refusal (#1016)", () => {
  const sent: Array<{ payload: unknown }> = [];
  dispatchDashboardRoomAction(
    { room: "agents", action: "spawn_agent", args: { specialist: "research" }, ts: 1, resultId: "r7" },
    (_req, onResult) => { onResult?.(false, "pending"); },
    (text) => sent.push(JSON.parse(text)),
  );
  expect(sent.map((m) => m.payload)).toEqual([{ resultId: "r7", accepted: false, outcome: "pending" }]);
});

test("the dashboard shell wires daemon room actions through the answering dispatch (#965)", async () => {
  const { readFileSync } = await import("node:fs");
  // The bridge moved to its own module (#1024); the shell renders it with
  // the socket's queue, and the bridge dispatches through the answering path.
  const shell = readFileSync(new URL("../shell/AppShell.tsx", import.meta.url), "utf8");
  expect(shell).toContain("<RoomActionBridge requests={live.roomActionRequests} ack={live.ackRoomActionRequests} forceIdle={voice.forceIdle} wsRef={live.wsRef} />");
  const bridge = readFileSync(new URL("../shell/RoomActionBridge.tsx", import.meta.url), "utf8");
  expect(bridge).toContain("dispatchDashboardRoomAction(request, dispatch, (text) => {");
  const ws = readFileSync(new URL("../../hooks/useWebSocket.ts", import.meta.url), "utf8");
  expect(ws).toContain("const req = roomActionRequestFrom(payload, msg.timestamp);");
});

test("the dashboard hands the bus the deadline and the asker with the action (#1010)", () => {
  const dispatched: unknown[] = [];
  const stillAsked = () => true;
  dispatchDashboardRoomAction(
    { room: "tasks", action: "create_task", args: { title: "x" }, ts: 1, resultId: "r9", expiresAt: 123, stillAsked },
    (req) => { dispatched.push(req); },
    () => {},
  );
  expect(dispatched).toEqual([{ room: "tasks", action: "create_task", args: { title: "x" }, ts: 1, expiresAt: 123, stillAsked, onStarted: expect.any(Function) }]);
});

test("a room that has started work it answers for later says so first (#1015)", () => {
  const sent: Array<{ payload: unknown }> = [];
  let started: (() => void) | undefined;
  let answer: ((ok: boolean, a: "accepted" | "rejected" | "pending") => void) | undefined;
  dispatchDashboardRoomAction(
    { room: "workspaces", action: "start_server", args: { name: "demo" }, ts: 1, resultId: "r5" },
    (req, onResult) => { started = req.onStarted; answer = onResult; },
    (text) => sent.push(JSON.parse(text)),
  );
  started!();
  answer!(true, "accepted");
  expect(sent.map((m) => m.payload)).toEqual([{ resultId: "r5", started: true }, { resultId: "r5", accepted: true, outcome: "accepted" }]);
  // Nobody asked, so nobody is told it started.
  const quiet: unknown[] = [];
  dispatchDashboardRoomAction({ room: "workspaces", action: "start_server", args: {}, ts: 1 }, (req) => { req.onStarted?.(); }, (t) => quiet.push(t));
  expect(quiet).toEqual([]);
});

test("a panel passes on how long the daemon waits, on its own clock (#1010)", () => {
  const dispatched: Array<{ expiresAt?: number }> = [];
  const before = performance.now();
  handlePanelRoomActionMessage(note({ resultId: "r1", expiresInMs: 3500 }), (req) => { dispatched.push(req); }, () => {});
  handlePanelRoomActionMessage(note({ expiresInMs: 3500 }), (req) => { dispatched.push(req); }, () => {});
  const after = performance.now();
  expect(dispatched[0]!.expiresAt!).toBeGreaterThanOrEqual(before + 3500);
  expect(dispatched[0]!.expiresAt!).toBeLessThanOrEqual(after + 3500);
  // Nobody waits on an action without a resultId, so it does not expire.
  expect(dispatched[1]!.expiresAt).toBeUndefined();
});

test("a panel never runs an action that changes more than the screen (#974)", () => {
  for (const [room, action] of [["tasks", "create_task"], ["agents", "spawn_agent"], ["settings", "enable_tts"], ["settings", "not_an_action"]]) {
    const { dispatched, sent } = run(note({ room, action, resultId: "r1" }), true);
    expect(dispatched).toEqual([]);
    expect(sent).toEqual([]);
  }
});

test("the dashboard hands the bus the daemon's claim with the action (#1025)", () => {
  const dispatched: Array<{ claim?: unknown }> = [];
  const claim = async () => true;
  dispatchDashboardRoomAction(
    { room: "tasks", action: "create_task", args: { title: "x" }, ts: 1, resultId: "r10", claim },
    (req) => { dispatched.push(req); },
    () => {},
  );
  expect(dispatched[0]?.claim).toBe(claim);
});
