import { useCallback, useEffect, useRef, useState } from "react";

export type Availability = "loading" | "ready" | "stale" | "unavailable";
export type RemoteSource = string | (() => string);
export interface RemoteState<T> {
  data: T | null;
  availability: Availability;
  error: string | null;
  updatedAt: number | null;
}
export interface RemoteData<T> extends RemoteState<T> {
  refresh: () => Promise<void>;
}

export function readObject<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected response.");
  return value as T;
}
export function readArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error("Unexpected response.");
  value.forEach(readObject);
  return value as T[];
}

const initial = <T,>(): RemoteState<T> => ({ data: null, availability: "loading", error: null, updatedAt: null });
function httpError(status: number): string {
  if (status === 401) return "Sign in again to refresh this section (HTTP 401).";
  if (status === 403) return "Access denied (HTTP 403).";
  if (status === 429) return "Too many requests. Try again shortly (HTTP 429).";
  return `Service unavailable (HTTP ${status}).`;
}

/** One independently polled resource. A failed refresh never erases a good snapshot.
 * Decoders and URL factories must have stable identity. A factory is evaluated
 * on each refresh, so rolling query windows retain the same resource snapshot.
 * Snapshots live only in this mounted view,
 * never in persistent storage where they could leak across sign-ins.
 */
export function useRemoteData<T>(source: RemoteSource, decode: (value: unknown) => T, pollMs: number, timeoutMs = 10000): RemoteData<T> {
  const [snapshot, setSnapshot] = useState<{ source: RemoteSource; state: RemoteState<T> }>(() => ({ source, state: initial<T>() }));
  const active = useRef(false);
  const flight = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!active.current) return Promise.resolve();
    if (flight.current) return flight.current.promise;
    const controller = new AbortController();
    const request = { controller, promise: Promise.resolve() };
    flight.current = request;
    request.promise = (async () => {
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(typeof source === "function" ? source() : source, { signal: controller.signal });
        if (!response.ok) throw new Error(httpError(response.status));
        let data: T;
        try { data = decode(await response.json()); }
        catch { throw new Error("Unexpected response. Try refreshing this section."); }
        if (active.current && flight.current === request && !controller.signal.aborted) {
          setSnapshot({ source, state: { data, availability: "ready", error: null, updatedAt: Date.now() } });
        }
      } catch (err) {
        if (active.current && flight.current === request) {
          const error = controller.signal.aborted ? "Request timed out. Try again." :
            err instanceof TypeError ? "Could not connect. Check your connection and try again." :
            err instanceof Error ? err.message : "Could not load this section.";
          setSnapshot(previous => {
            const state = previous.source === source ? previous.state : initial<T>();
            return { source, state: { ...state, availability: state.updatedAt === null ? "unavailable" : "stale", error } };
          });
        }
      } finally {
        window.clearTimeout(timer);
        if (flight.current === request) flight.current = null;
      }
    })();
    return request.promise;
  }, [source, decode, timeoutMs]);

  useEffect(() => {
    active.current = true;
    void refresh();
    const poll = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(poll, pollMs);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", poll);
    return () => {
      active.current = false;
      const request = flight.current;
      flight.current = null;
      request?.controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("online", poll);
    };
  }, [refresh, pollMs]);

  return { ...(snapshot.source === source ? snapshot.state : initial<T>()), refresh };
}

/** Aggregate status only for a display that actually combines these resources. */
export function combinedAvailability(...resources: RemoteState<unknown>[]): Availability {
  if (resources.some(r => r.availability === "unavailable")) return "unavailable";
  if (resources.some(r => r.availability === "loading")) return "loading";
  if (resources.some(r => r.availability === "stale")) return "stale";
  return "ready";
}
export function availabilityLabel(state: Availability): string {
  return { loading: "Loading…", ready: "Current", stale: "Last known; not current", unavailable: "Unavailable" }[state];
}
