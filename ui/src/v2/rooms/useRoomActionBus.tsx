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

  const register = useCallback((room: RoomKey, handler: RoomActionHandler) => {
    const stack = handlersRef.current[room] ?? [];
    handlersRef.current[room] = [...stack, handler];
    return () => {
      const cur = handlersRef.current[room] ?? [];
      handlersRef.current[room] = cur.filter((h) => h !== handler);
    };
  }, []);

  const dispatch = useCallback((req: RoomActionRequest) => {
    const stack = handlersRef.current[req.room as RoomKey];
    if (!stack || stack.length === 0) {
      console.warn(`[RoomActionBus] No handler for room "${req.room}"`);
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
