import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { RoomKey } from "../router";
import { ROOM_ACTION_QUEUE_TTL_MS, type RoomAnswer } from "../../../../src/daemon/room-action-results";
import { isRoomAction } from "../../../../src/daemon/room-actions";

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
  /**
   * On this page's monotonic clock (performance.now), when whoever asked
   * stops waiting to hear (#1010). Past it the action is dropped, queued or
   * not: the daemon has already said it got no answer, and a retry that
   * prompted must not be the second run.
   */
  expiresAt?: number;
  /**
   * False once whoever asked can no longer hear the answer (#1010): the
   * socket it came on closed, and the daemon gave up on it then.
   */
  stillAsked?: () => boolean;
}

/** Whether `req`'s caller has stopped waiting for it (#1010). */
function expired(req: RoomActionRequest): boolean {
  const late = req.expiresAt !== undefined && performance.now() >= req.expiresAt;
  if (!late && req.stillAsked?.() !== false) return false;
  console.warn(`[RoomActionBus] Dropped "${req.action}" for room "${req.room}": the daemon stopped waiting for it`);
  return true;
}

/**
 * A handler's answer for an action it asked for that now waits on the person
 * (#1016): a spawn the route held behind a card (202). Nothing has run, and
 * nothing was refused; the daemon says a card is waiting.
 */
export const AWAITING_APPROVAL: unique symbol = Symbol("room-action-awaiting-approval");

/**
 * What a handler answers: true or a string ack when it carried the action
 * out, AWAITING_APPROVAL when it is held for the person's answer, anything
 * else when it did not carry it out.
 */
export type RoomActionAnswer = boolean | string | void | typeof AWAITING_APPROVAL;

/**
 * Per-Room handler signature. Returns a string ack on success, false when
 * the action was not carried out (an action it does not know, arguments it
 * cannot use, or, for a promise, an outcome that was not the action). The
 * bus logs it and the daemon says so. Throwing is treated as a bug.
 *
 * A promise, for an action whose outcome is decided elsewhere (#991): the
 * agents room's spawn is a request the daemon may answer with a card, a
 * refusal or a cap. The answer is reported when it settles; a rejected
 * promise counts as not carried out.
 */
export type RoomActionHandler = (
  action: string,
  args: Record<string, unknown>,
) => RoomActionAnswer | PromiseLike<RoomActionAnswer>;

/**
 * Told whether the room carried an action out (#933): `accepted` is true for
 * `true` or a string ack, false for anything else, and `answer` says which no
 * a false one is: `pending` for AWAITING_APPROVAL (#1016), `rejected` for the
 * rest. Called once, when a handler's answer is known (when its promise
 * settles, for one that returns a promise); an action that waits in the queue
 * and expires is never reported, so a caller waiting on this needs its own
 * timeout.
 */
export type RoomActionResultCallback = (accepted: boolean, answer: RoomAnswer) => void;

function answerOf(result: RoomActionAnswer): RoomAnswer {
  if (result === true || typeof result === "string") return "accepted";
  return result === AWAITING_APPROVAL ? "pending" : "rejected";
}

function isThenable(value: unknown): value is PromiseLike<RoomActionAnswer> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** Report `result` to `onResult` once it is known, and log a rejection. */
function report(
  req: RoomActionRequest,
  result: RoomActionAnswer | PromiseLike<RoomActionAnswer>,
  onResult: RoomActionResultCallback | undefined,
  label: string,
): void {
  const settle = (result: RoomActionAnswer) => {
    const answer = answerOf(result);
    onResult?.(answer === "accepted", answer);
    if (result === false) {
      console.warn(`[RoomActionBus] ${label} "${req.action}" rejected by "${req.room}"`);
    }
  };
  // Any thenable, not only a native Promise: a handler's answer is reported
  // when it settles, never read as "not carried out" because of its type.
  if (isThenable(result)) {
    result.then(settle, (err: unknown) => {
      console.warn(`[RoomActionBus] ${label} "${req.action}" failed in "${req.room}":`, err);
      settle(false);
    });
    return;
  }
  settle(result);
}

/**
 * Hand `room`'s handler only actions it is listed for in ROOM_ACTIONS
 * (#969). The daemon refuses anything else before it broadcasts; this is the
 * dashboard's own check, so no room_action, from whatever path, reaches a
 * handler with an action the table does not name.
 */
function runHandler(handler: RoomActionHandler, req: RoomActionRequest): RoomActionAnswer | PromiseLike<RoomActionAnswer> {
  if (!isRoomAction(req.room, req.action)) {
    console.warn(`[RoomActionBus] Refused "${req.action}" for room "${req.room}": not one of its actions`);
    return false;
  }
  return handler(req.action, req.args);
}

interface BusInternal {
  /** Most-recent handler per RoomKey wins. */
  register: (room: RoomKey, handler: RoomActionHandler) => () => void;
  /** AppShell calls this when a WS room_action arrives. */
  dispatch: (req: RoomActionRequest, onResult?: RoomActionResultCallback) => void;
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
  // Shared with the daemon, whose classifier and pebble paths wait this long
  // for a room to answer. The realtime path waits less; an action it asked
  // for carries its own deadline (`expiresAt`, #1010), which is the bound
  // that counts for it.
  const QUEUE_TTL_MS = ROOM_ACTION_QUEUE_TTL_MS;
  const queueRef = useRef<
    Partial<Record<RoomKey, Array<{ req: RoomActionRequest; queuedAt: number; onResult?: RoomActionResultCallback }>>>
  >({});

  const drainQueue = useCallback((room: RoomKey, handler: RoomActionHandler) => {
    const queue = queueRef.current[room];
    if (!queue || queue.length === 0) return;
    const now = Date.now();
    const fresh = queue.filter((q) => now - q.queuedAt < QUEUE_TTL_MS && !expired(q.req));
    queueRef.current[room] = [];
    for (const { req, onResult } of fresh) {
      console.log(
        `[RoomActionBus] Draining queued action "${req.action}" for room "${req.room}"`,
      );
      report(req, runHandler(handler, req), onResult, "Queued action");
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

  const dispatch = useCallback((req: RoomActionRequest, onResult?: RoomActionResultCallback) => {
    // Refuse before queueing, so an action no room carries out is answered
    // now rather than waiting on a room that may never mount (#969).
    if (!isRoomAction(req.room, req.action)) {
      console.warn(`[RoomActionBus] Refused "${req.action}" for room "${req.room}": not one of its actions`);
      onResult?.(false, "rejected");
      return;
    }
    // Not reported: the daemon no longer listens for this answer.
    if (expired(req)) return;
    const stack = handlersRef.current[req.room as RoomKey];
    if (!stack || stack.length === 0) {
      // No handler yet — queue and wait for one to register. Common
      // when the daemon broadcasts a navigation + room_action pair and
      // the target room's body hasn't finished mounting yet (lazy chunk
      // load + Suspense + effect timing).
      const list = queueRef.current[req.room as RoomKey] ?? [];
      list.push({ req, queuedAt: Date.now(), onResult });
      queueRef.current[req.room as RoomKey] = list;
      console.log(
        `[RoomActionBus] Queued action "${req.action}" for room "${req.room}" (no handler yet)`,
      );
      return;
    }
    const top = stack[stack.length - 1]!;
    report(req, runHandler(top, req), onResult, "Action");
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
    return { dispatch: (_req: RoomActionRequest, _onResult?: RoomActionResultCallback) => {} };
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
