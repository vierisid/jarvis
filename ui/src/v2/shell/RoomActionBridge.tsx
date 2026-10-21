import React, { useEffect, useRef } from "react";
import { useRoomActionDispatcher } from "../rooms/useRoomActionBus";
import { dispatchDashboardRoomAction } from "../rooms/panel-room-action";
import { stillDeliverable, type QueuedRoomActionRequest } from "../../hooks/useWebSocket";

/**
 * Tiny bridge: lives inside RoomActionBusProvider, reads the dispatcher,
 * and dispatches every room action queued from the WS, once each, in the
 * order they came (#1024), then acks them off the queue. Also force-idles
 * the voice orb (the Room handles the action itself, no tts_start ever fires
 * to clear `processing`).
 *
 * Keyed on the queue's own `seq`, never on the message timestamp: two
 * actions stamped in the same millisecond are two actions.
 */
export function RoomActionBridge({
  requests,
  ack,
  forceIdle,
  wsRef,
  beforeDispatch,
}: {
  requests: readonly QueuedRoomActionRequest[];
  ack: (upToSeq: number) => void;
  forceIdle: () => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
  /** Connected workspaces may need to confirm unsaved edits before opening a room. */
  beforeDispatch?: (request: QueuedRoomActionRequest) => Promise<boolean>;
}) {
  const { dispatch } = useRoomActionDispatcher();
  // The last seq dispatched. A ref, so a re-render, or StrictMode running
  // the effect twice, never dispatches one again before the ack lands.
  const doneRef = useRef(0);
  const pendingRef = useRef(Promise.resolve());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const unseen = requests.filter((r) => r.seq > doneRef.current);
    if (unseen.length === 0) return;
    doneRef.current = unseen[unseen.length - 1]!.seq;
    // One that went stale while no bridge was mounted to take it is acked
    // off, not run: the queue prunes only as the next action arrives.
    const now = performance.now();
    for (const request of unseen.filter((r) => stillDeliverable(r, now))) {
      // When the daemon asked, tell it whether the room ran the action, so
      // its acknowledgement says what happened (#965). A queued action
      // answers when its room mounts; after a reconnect the daemon ignores
      // that answer (it asked the old socket) and has already said it got
      // none.
      const deliver = () => dispatchDashboardRoomAction(request, dispatch, (text) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(text);
      });
      if (beforeDispatch) {
        // Preserve queue order across asynchronous navigation. A request can
        // expire or lose its socket while the user considers unsaved changes.
        pendingRef.current = pendingRef.current.then(async () => {
          if (!stillDeliverable(request, performance.now())) return;
          if (await beforeDispatch(request) && stillDeliverable(request, performance.now())) deliver();
        }).catch(() => { /* A failed navigation must not run or replay an action. */ });
      } else deliver();
    }
    ack(doneRef.current);
    forceIdle();
  }, [requests]);
  return null;
}
