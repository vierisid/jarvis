import type { RoomActionRequest, RoomActionResultCallback } from "./useRoomActionBus";
import { isPresentationRoomAction } from "../../../../src/daemon/room-actions";
import { roomActionExpiry, type RoomAnswer } from "../../../../src/daemon/room-action-results";

/**
 * A native panel's half of a daemon `room_action` (T20c, #933).
 *
 * The daemon broadcasts a `room_action` notification; a panel hands it to its
 * RoomActionBus. When the notification carries a `resultId`, the daemon is
 * waiting to hear whether the room carried the action out, so it can say what
 * happened instead of announcing success it cannot see. The answer goes back
 * as a `room_action_result` message on the same socket.
 *
 * Panels answer the pebble's requests. The full dashboard answers only a
 * request the daemon addressed to it (`resultFrom: "dashboard"`, sent to the
 * dashboard the user spoke to); see dispatchDashboardRoomAction below.
 */
export function handlePanelRoomActionMessage(
  raw: unknown,
  dispatch: (req: RoomActionRequest, onResult?: RoomActionResultCallback) => void,
  send: (text: string) => void,
): void {
  let msg: unknown;
  try { msg = JSON.parse(typeof raw === "string" ? raw : ""); }
  catch { return; }
  if (!msg || typeof msg !== "object") return;
  const m = msg as {
    type?: string;
    payload?: { source?: string; room?: string; action?: string; args?: Record<string, unknown>; resultId?: unknown; expiresInMs?: unknown };
  };
  const receivedAt = performance.now();
  if (m.type !== "notification" || m.payload?.source !== "room_action") return;
  if (!m.payload.room || !m.payload.action) return;
  // Panels take presentation actions only (the pebble sends tab switches).
  // Anything that changes more than the screen is the addressed dashboard's
  // to run (#974), and a panel running it too would do it twice.
  if (!isPresentationRoomAction(m.payload.room, m.payload.action)) return;
  const resultId = typeof m.payload.resultId === "string" && m.payload.resultId ? m.payload.resultId : null;
  // Only an action the daemon waits on expires (#1010).
  const expiresAt = resultId ? roomActionExpiry(m.payload.expiresInMs, receivedAt) : undefined;
  dispatch(
    {
      room: m.payload.room,
      action: m.payload.action,
      args: m.payload.args ?? {},
      ts: Date.now(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    resultId ? (_accepted, answer) => send(roomActionResultText(resultId, answer)) : undefined,
  );
}

/**
 * The answer to a room_action that carried a resultId (#933, #965): whether
 * the room carried it out, and which answer it was, so a card waiting on the
 * person is not heard as a refusal (#1016).
 */
export function roomActionResultText(resultId: string, answer: RoomAnswer): string {
  return JSON.stringify({
    type: "room_action_result",
    payload: { resultId, accepted: answer === "accepted", outcome: answer },
    timestamp: Date.now(),
  });
}

/**
 * Word that the room has taken an action whose answer waits on work still
 * running (#1015). Not an answer: the answer follows when the work settles.
 */
export function roomActionStartedText(resultId: string): string {
  return JSON.stringify({
    type: "room_action_result",
    payload: { resultId, started: true },
    timestamp: Date.now(),
  });
}

/**
 * The dashboard's half (#965): dispatch a daemon room action and, when the
 * daemon asked this dashboard (`request.resultId`), answer whether the room
 * ran it, and say when it has started work it will answer for later (#1015).
 * Without that the daemon acknowledged room actions blindly.
 */
export function dispatchDashboardRoomAction(
  request: { room: string; action: string; args: Record<string, unknown>; ts: number; resultId?: string; expiresAt?: number; stillAsked?: () => boolean; claim?: () => Promise<boolean> },
  dispatch: (req: RoomActionRequest, onResult?: RoomActionResultCallback) => void,
  send: (text: string) => void,
): void {
  const { resultId, ...req } = request;
  if (!resultId) {
    dispatch(req);
    return;
  }
  dispatch(
    { ...req, onStarted: () => send(roomActionStartedText(resultId)) },
    (_accepted, answer) => send(roomActionResultText(resultId, answer)),
  );
}
