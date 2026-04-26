import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { RoomKey } from "../router";

/**
 * Phase 6.3.5 — Room control via voice.
 *
 * The bus is a tiny pub/sub between (1) the AppShell, which receives
 * `room_action` notifications from the daemon, and (2) whichever Room
 * is currently mounted, which has registered a typed action dispatcher
 * via `useRoomActions`.
 *
 * Why a bus rather than wiring directly through props:
 *   - Rooms are mounted by RoomDispatcher (overlay) AND RoomBodyRegistry
 *     (inline window) — both render via React.lazy + Suspense, often far
 *     below AppShell. Prop drilling would touch every Room shell.
 *   - A Room may be open both as an inline RoomWindow AND expanded as the
 *     overlay simultaneously. The most-recently-registered handler wins
 *     (typically the overlay), keeping voice control predictable.
 */

export interface RoomActionRequest {
  room: string;
  action: string;
  args: Record<string, unknown>;
  ts: number;
}

/**
 * Per-Room handler signature. Returns a string ack on success, false to
 * mean "I don't know that action" (the bus logs and the user gets nothing
 * — daemon already sent its own ack). Throwing is treated as a bug.
 */
export type RoomActionHandler = (
  action: string,
  args: Record<string, unknown>,
) => boolean | string | void;

interface BusInternal {
  /** Most-recent handler per RoomKey wins. */
  register: (room: RoomKey, handler: RoomActionHandler) => () => void;
  /** AppShell calls this when a WS room_action arrives. */
  dispatch: (req: RoomActionRequest) => void;
}

const BusContext = createContext<BusInternal | null>(null);

export function RoomActionBusProvider({ children }: { children: React.ReactNode }) {
  // Ref-stack per room: when a Room mounts an inline window AND the
  // overlay (rare but possible), both register; the most-recent push
  // (top of stack) handles incoming actions. Unmount pops by identity.
  const handlersRef = useRef<Partial<Record<RoomKey, RoomActionHandler[]>>>({});

  // Pending queue per room — actions that arrived before any body for
  // that room registered a handler. Drained when the next handler
  // registers (within QUEUE_TTL_MS so stale queues don't replay later).
  // Use case: text-driven "go to settings and disable TTS" — the daemon
  // broadcasts the room_action and the navigation request in the same
  // frame, but the SettingsRoom body needs a tick or two to mount + run
  // its `useRoomActions` effect. Without queueing, the action lands in
  // the void and the user sees the room open but TTS not toggle.
  const QUEUE_TTL_MS = 5000;
  const queueRef = useRef<
    Partial<Record<RoomKey, Array<{ req: RoomActionRequest; queuedAt: number }>>>
  >({});

  const drainQueue = useCallback((room: RoomKey, handler: RoomActionHandler) => {
    const queue = queueRef.current[room];
    if (!queue || queue.length === 0) return;
    const now = Date.now();
    const fresh = queue.filter((q) => now - q.queuedAt < QUEUE_TTL_MS);
    queueRef.current[room] = [];
    for (const { req } of fresh) {
      console.log(
        `[RoomActionBus] Draining queued action "${req.action}" for room "${req.room}"`,
      );
      const result = handler(req.action, req.args);
      if (result === false) {
        console.warn(
          `[RoomActionBus] Queued action "${req.action}" rejected by "${req.room}"`,
        );
      }
    }
  }, []);

  const register = useCallback(
    (room: RoomKey, handler: RoomActionHandler) => {
      const stack = handlersRef.current[room] ?? [];
      handlersRef.current[room] = [...stack, handler];
      // Defer the drain so it runs after this register's caller finishes
      // its own mount effect — otherwise the handler may not yet be ready
      // for synchronous dispatch.
      queueMicrotask(() => drainQueue(room, handler));
      return () => {
        const cur = handlersRef.current[room] ?? [];
        handlersRef.current[room] = cur.filter((h) => h !== handler);
      };
    },
    [drainQueue],
  );

  const dispatch = useCallback((req: RoomActionRequest) => {
    const stack = handlersRef.current[req.room as RoomKey];
    if (!stack || stack.length === 0) {
      // No handler yet — queue and wait for one to register. Common
      // when the daemon broadcasts a navigation + room_action pair and
      // the target room's body hasn't finished mounting yet (lazy chunk
      // load + Suspense + effect timing).
      const list = queueRef.current[req.room as RoomKey] ?? [];
      list.push({ req, queuedAt: Date.now() });
      queueRef.current[req.room as RoomKey] = list;
      console.log(
        `[RoomActionBus] Queued action "${req.action}" for room "${req.room}" (no handler yet)`,
      );
      return;
    }
    const top = stack[stack.length - 1]!;
    const result = top(req.action, req.args);
    if (result === false) {
      console.warn(
        `[RoomActionBus] Room "${req.room}" rejected action "${req.action}"`,
      );
    }
  }, []);

  const value = useMemo<BusInternal>(() => ({ register, dispatch }), [register, dispatch]);

  return <BusContext.Provider value={value}>{children}</BusContext.Provider>;
}

/**
 * AppShell hook — wires WS `roomActionRequest` to the bus. Runs an effect
 * on every new request (`ts` bumps even on identical args repeats).
 */
export function useRoomActionDispatcher() {
  const bus = useContext(BusContext);
  if (!bus) {
    // Tolerable in mock shells / SSR — bus not mounted means no voice
    // control, which is the same as "no daemon connected".
    return { dispatch: (_req: RoomActionRequest) => {} };
  }
  return { dispatch: bus.dispatch };
}

/**
 * Per-Room hook — register an action handler when this Room mounts.
 * The handler stays current via a ref so callers can pass an inline
 * arrow function without re-registering on every render.
 *
 * Usage:
 *   useRoomActions("agents", (action, args) => {
 *     switch (action) {
 *       case "switch_tab": setTab(args.tab as Tab); return true;
 *       ...
 *     }
 *     return false;
 *   });
 */
export function useRoomActions(room: RoomKey, handler: RoomActionHandler) {
  const bus = useContext(BusContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!bus) return;
    // Stable wrapper so unregister can find the same identity.
    const wrapped: RoomActionHandler = (action, args) =>
      handlerRef.current(action, args);
    return bus.register(room, wrapped);
  }, [bus, room]);
}
