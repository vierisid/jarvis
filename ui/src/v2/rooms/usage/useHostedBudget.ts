import { useCallback, useEffect, useRef, useState } from "react";
import { applyBudgetProbe, classifyBudgetResponse, type HostedMeter } from "./hosted-budget";

/**
 * Polls the daemon's `/api/llm/budget`.
 *
 * ## Why there is no separate hosted probe
 *
 * The route ITSELF is the gate: it answers 503 on a self-hosted install, where
 * there is no key, no plan and no window to report. Probing `/api/config/llm`
 * separately (as the onboarding wizard must, since it renders before any of
 * this exists) would add a second request that can disagree with the first.
 *
 * TRI-state, for the reason recorded in OnboardingWizard.tsx: a slow or
 * erroring probe that defaults to "self-hosted" hides a hosted user's meter
 * exactly when they most need it. Unknown renders NOTHING and retries; only a
 * real 503 means self-hosted.
 */

/** Matches the 60s caches on both sides — polling faster buys nothing. */
export const BUDGET_POLL_MS = 60_000;
/** First retry after a failed probe. Doubles up to RETRY_MAX_MS: a daemon that
 *  is down stays down, and a fixed 5s retry on top of the poll is a request
 *  every five seconds for as long as the room is open. */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = BUDGET_POLL_MS;

export type HostedState = "unknown" | "hosted" | "self";

export interface HostedBudget {
  state: HostedState;
  /** null while unknown, on a self-hosted install, or when the control plane
   *  could not be reached — the strip renders "unavailable", not zeros. */
  meter: HostedMeter | null;
  /** When the last read COMPLETED, successful or not. The strip derives its
   *  countdowns at render, so this is what makes them tick during an outage
   *  instead of freezing on the last good reading. */
  readAt: number;
  refresh: () => void;
}

interface BudgetResponse {
  ok?: boolean;
  meter?: HostedMeter;
}

export function useHostedBudget(): HostedBudget {
  const [state, setState] = useState<HostedState>("unknown");
  const [meter, setMeter] = useState<HostedMeter | null>(null);
  // Bumped on every completed read, including a failed one, so the strip
  // re-renders and its countdowns advance. Without it a room left open across
  // a control-plane outage keeps a last-good meter on screen and goes on
  // printing "resets in 2h 30m" an hour later.
  const [readAt, setReadAt] = useState(0);
  const inFlightRef = useRef(false);
  const retryRef = useRef<number | null>(null);
  const backoffRef = useRef(RETRY_MS);
  const aliveRef = useRef(true);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/llm/budget");
      // A non-2xx that is not 503 has no body worth parsing, and a body that
      // is not JSON must not read as a failed FETCH — both are "failed".
      const body =
        res.ok ? ((await res.json().catch(() => null)) as BudgetResponse | null) : null;
      if (!aliveRef.current) return;
      const probe = classifyBudgetResponse(res.status, body);
      if (probe.kind === "failed") throw new Error(`HTTP ${res.status}`);
      backoffRef.current = RETRY_MS;
      setState((prevState) => applyBudgetProbe({ state: prevState, meter: null }, probe).state);
      setMeter((prevMeter) => applyBudgetProbe({ state: "hosted", meter: prevMeter }, probe).meter);
      setReadAt(Date.now());
    } catch {
      // Unreachable daemon stays UNKNOWN, never "self": the strip must not
      // vanish for a hosted user because one request failed.
      if (!aliveRef.current) return;
      setReadAt(Date.now());
      // Backed off and CLEARED on unmount. A UI newer than its daemon gets a
      // 404 here on every attempt; at a fixed interval that is a request every
      // five seconds forever, and the timer outlived the component besides.
      const wait = backoffRef.current;
      backoffRef.current = Math.min(wait * 2, RETRY_MAX_MS);
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        if (typeof document !== "undefined" && document.hidden) return;
        setAttempt((n) => n + 1);
      }, wait);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  useEffect(() => {
    if (state === "self") return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, BUDGET_POLL_MS);
    return () => window.clearInterval(id);
  }, [load, state]);

  return { state, meter, readAt, refresh: () => void load() };
}
