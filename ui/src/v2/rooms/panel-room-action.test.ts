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
      if (handlerResult !== null) onResult?.(handlerResult);
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
    expect(sent).toEqual([expect.objectContaining({ type: "room_action_result", payload: { resultId: "r1", accepted: verdict } })]);
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
      (req, onResult) => { dispatched.push(req); onResult?.(verdict); },
      (text) => sent.push(JSON.parse(text)),
    );
    // The room sees the action, not the resultId.
    expect(dispatched).toEqual([{ room: "agents", action: "switch_tab", args: { tab: "builder" }, ts: 1 }]);
    expect(sent).toEqual([expect.objectContaining({ type: "room_action_result", payload: { resultId: "r9", accepted: verdict } })]);
  }
  const sent: unknown[] = [];
  let callback: unknown = "unset";
  dispatchDashboardRoomAction(
    { room: "agents", action: "switch_tab", args: { tab: "builder" }, ts: 1 },
    (_req, onResult) => { callback = onResult; onResult?.(true); },
    (text) => sent.push(text),
  );
  expect(callback).toBeUndefined();
  expect(sent).toEqual([]);
});

test("the dashboard shell wires daemon room actions through the answering dispatch (#965)", async () => {
  const { readFileSync } = await import("node:fs");
  const shell = readFileSync(new URL("../shell/AppShell.tsx", import.meta.url), "utf8");
  expect(shell).toContain("dispatchDashboardRoomAction(request, dispatch, (text) => {");
  expect(shell).toContain("wsRef={live.wsRef}");
  const ws = readFileSync(new URL("../../hooks/useWebSocket.ts", import.meta.url), "utf8");
  expect(ws).toContain("const req = roomActionRequestFrom(payload, msg.timestamp);");
});

test("a panel never runs an action that changes more than the screen (#974)", () => {
  for (const [room, action] of [["tasks", "create_task"], ["agents", "spawn_agent"], ["settings", "enable_tts"], ["settings", "not_an_action"]]) {
    const { dispatched, sent } = run(note({ room, action, resultId: "r1" }), true);
    expect(dispatched).toEqual([]);
    expect(sent).toEqual([]);
  }
});
