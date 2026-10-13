import type { RoomActionRequest, RoomActionResultCallback } from "./useRoomActionBus";

/**
 * A native panel's half of a daemon `room_action` (T20c, #933).
 *
 * The daemon broadcasts a `room_action` notification; a panel hands it to its
 * RoomActionBus. When the notification carries a `resultId`, the daemon is
 * waiting to hear whether the room carried the action out, so it can say what
 * happened instead of announcing success it cannot see. The answer goes back
 * as a `room_action_result` message on the same socket.
 *
 * Only panels answer: the full dashboard dispatches room actions too, but the
 * voice path that asks is the pebble's, and the pebble acts on its panels.
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
  const resultId = typeof m.payload.resultId === "string" && m.payload.resultId ? m.payload.resultId : null;
  dispatch(
    {
      room: m.payload.room,
      action: m.payload.action,
      args: m.payload.args ?? {},
      ts: Date.now(),
    },
    resultId
      ? (accepted) => send(JSON.stringify({
          type: "room_action_result",
          payload: { resultId, accepted },
          timestamp: Date.now(),
        }))
      : undefined,
  );
}
