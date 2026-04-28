import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import type { RoomKey } from "../router";

/**
 * Phase C — auto-advance event channel for the spotlight tutorial.
 *
 * The tutorial's steps auto-advance when the user actually performs
 * the highlighted action (press ⌘K → palette opens → step advances).
 * We don't want the AppShell to know what the tutorial wants —
 * AppShell just fires events here as state changes happen, and the
 * tutorial subscribes from outside.
 *
 * `useTutorialEventDispatcher` is what the AppShell calls (cheap;
 * does nothing when the tutorial isn't mounted).
 * `useTutorialEventListener` is what the tutorial calls — registers
 * a callback per event name; subscription is managed via a useEffect
 * so listeners don't pile up across renders.
 *
 * Implemented with refs so AppShell never re-renders when the
 * tutorial mounts/unmounts a listener.
 */

export type TutorialEventName =
  | "palette_opened"
  | "palette_closed"
  | "room_opened"
  | "room_closed"
  | "notif_opened"
  | "voice_recording_started";

export type TutorialEventPayload = {
  palette_opened: void;
  palette_closed: void;
  room_opened: { key: RoomKey };
  room_closed: void;
  notif_opened: void;
  voice_recording_started: void;
};

type Listener<E extends TutorialEventName> = (
  payload: TutorialEventPayload[E],
) => void;

interface TutorialBus {
  fire: <E extends TutorialEventName>(name: E, payload: TutorialEventPayload[E]) => void;
  subscribe: <E extends TutorialEventName>(name: E, listener: Listener<E>) => () => void;
}

const TutorialEventContext = createContext<TutorialBus | null>(null);

export function TutorialEventProvider({ children }: { children: React.ReactNode }) {
  // listeners[name] is a Set; we use refs so adding/removing a
  // listener doesn't churn React re-renders.
  const listenersRef = useRef<Partial<Record<TutorialEventName, Set<Listener<any>>>>>({});

  const fire = useCallback(<E extends TutorialEventName>(
    name: E,
    payload: TutorialEventPayload[E],
  ) => {
    const set = listenersRef.current[name];
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(`[TutorialBus] Listener for "${name}" threw:`, err);
      }
    }
  }, []);

  const subscribe = useCallback(<E extends TutorialEventName>(
    name: E,
    listener: Listener<E>,
  ) => {
    const set = listenersRef.current[name] ?? new Set<Listener<any>>();
    set.add(listener);
    listenersRef.current[name] = set;
    return () => {
      set.delete(listener);
    };
  }, []);

  const bus: TutorialBus = { fire, subscribe };

  return (
    <TutorialEventContext.Provider value={bus}>
      {children}
    </TutorialEventContext.Provider>
  );
}

/**
 * AppShell-side: lightweight no-op when the tutorial isn't mounted
 * (the dispatcher only fires if there's at least one listener for
 * the event). Safe to call from any state-change effect.
 */
export function useTutorialEventDispatcher() {
  const bus = useContext(TutorialEventContext);
  return bus?.fire ?? noopFire;
}

function noopFire() {
  /* no provider in the tree */
}

/**
 * Tutorial-side: register a listener for a single event. Subscribes
 * once per provider lifetime via `useEffect` so stale listeners from
 * earlier renders don't pile up — without this, every step change
 * leaks a fresh listener that still holds a closure over its render's
 * `step`, and a single `room_opened` event can cascade through every
 * stale handler advancing the tutorial multiple times in a single tick.
 *
 * The listener prop is stashed in a ref so the latest closure (with the
 * current step) runs on every event, while the underlying subscription
 * identity stays stable across renders.
 */
export function useTutorialEventListener<E extends TutorialEventName>(
  name: E,
  listener: Listener<E>,
): void {
  const bus = useContext(TutorialEventContext);
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);
  useEffect(() => {
    if (!bus) return;
    const unsubscribe = bus.subscribe(name, ((payload: TutorialEventPayload[E]) => {
      listenerRef.current(payload);
    }) as Listener<E>);
    return unsubscribe;
    // bus + name are stable; listener flows through the ref.
  }, [bus, name]);
}
