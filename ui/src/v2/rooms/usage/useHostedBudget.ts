import { useCallback, useEffect, useRef, useState } from "react";
import type { HostedMeter } from "./hosted-budget";

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
const RETRY_MS = 5_000;

export type HostedState = "unknown" | "hosted" | "self";

export interface HostedBudget {
  state: HostedState;
  /** null while unknown, on a self-hosted install, or when the control plane
   *  could not be reached — the strip renders "unavailable", not zeros. */
  meter: HostedMeter | null;
  refresh: () => void;
}

interface BudgetResponse {
  ok?: boolean;
  meter?: HostedMeter;
}

export function useHostedBudget(): HostedBudget {
  const [state, setState] = useState<HostedState>("unknown");
  const [meter, setMeter] = useState<HostedMeter | null>(null);
  const inFlightRef = useRef(false);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/llm/budget");
      if (res.status === 503) {
        // The only answer that means "not a hosted install".
        setState("self");
        setMeter(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BudgetResponse | null;
      setState("hosted");
      // ok:false is hosted-but-unreadable. Keep the LAST GOOD meter rather
      // than blanking the strip on one failed poll — a minute-old reading is
      // far better than a room that flickers empty every time the control
      // plane hiccups.
      if (body?.ok && body.meter) setMeter(body.meter);
    } catch {
      // Unreachable daemon stays UNKNOWN, never "self": the strip must not
      // vanish for a hosted user because one request failed.
      setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
    } finally {
      inFlightRef.current = false;
    }
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

  return { state, meter, refresh: () => void load() };
}
