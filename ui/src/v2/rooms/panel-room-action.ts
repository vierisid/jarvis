import type { RoomActionRequest, RoomActionResultCallback } from "./useRoomActionBus";
import { isPresentationRoomAction } from "../../../../src/daemon/room-actions";

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
    payload?: { source?: string; room?: string; action?: string; args?: Record<string, unknown>; resultId?: unknown };
  };
  if (m.type !== "notification" || m.payload?.source !== "room_action") return;
  if (!m.payload.room || !m.payload.action) return;
  // Panels take presentation actions only (the pebble sends tab switches).
  // Anything that changes more than the screen is the addressed dashboard's
  // to run (#974), and a panel running it too would do it twice.
  if (!isPresentationRoomAction(m.payload.room, m.payload.action)) return;
  const resultId = typeof m.payload.resultId === "string" && m.payload.resultId ? m.payload.resultId : null;
  dispatch(
    {
      room: m.payload.room,
      action: m.payload.action,
      args: m.payload.args ?? {},
      ts: Date.now(),
    },
    resultId ? (accepted) => send(roomActionResultText(resultId, accepted)) : undefined,
  );
}

/** The answer to a room_action that carried a resultId (#933, #965). */
export function roomActionResultText(resultId: string, accepted: boolean): string {
  return JSON.stringify({
    type: "room_action_result",
    payload: { resultId, accepted },
    timestamp: Date.now(),
  });
}

/**
 * The dashboard's half (#965): dispatch a daemon room action and, when the
 * daemon asked this dashboard (`request.resultId`), answer whether the room
 * ran it. Without that the daemon acknowledged room actions blindly.
 */
export function dispatchDashboardRoomAction(
  request: { room: string; action: string; args: Record<string, unknown>; ts: number; resultId?: string },
  dispatch: (req: RoomActionRequest, onResult?: RoomActionResultCallback) => void,
  send: (text: string) => void,
): void {
  const { resultId, ...req } = request;
  dispatch(req, resultId ? (accepted) => send(roomActionResultText(resultId, accepted)) : undefined);
}
