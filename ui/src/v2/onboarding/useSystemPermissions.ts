import { useCallback, useEffect, useRef, useState } from "react";
import type { PermReport } from "./permission-rows";

/**
 * Live permission state for the onboarding Permissions screen.
 *
 * Polling is the whole point. Two of the four rows have no dialog on macOS:
 * the user leaves for System Settings, flips a toggle, and comes back, and
 * nothing tells the page that happened. The row going green while they watch
 * is the only feedback the OS makes possible, and it is what the old static
 * screen could not do at all.
 *
 * Runs ONLY while the screen is mounted and `enabled`. The wizard renders one
 * step at a time and a user can sit on a later step for many minutes; a poll
 * left running would be a request every two seconds into a screen nobody is
 * looking at.
 */

/** Slow enough not to hammer an RPC round trip, fast enough that coming back
 *  from System Settings feels immediate. The sidecar coalesces reads inside a
 *  700ms window, so overlapping polls cost one status read, not several. */
const POLL_MS = 2000;

export type PermPhase = "loading" | "ready" | "error";

export interface SystemPermissions {
  phase: PermPhase;
  report: PermReport | null;
  /** Transport failure - the brain itself could not be reached. Distinct from
   *  a report that says `available: false`, which IS an answer. */
  error: string | null;
  /** The row currently being asked for, so its button can show it. */
  pending: string | null;
  requestError: string | null;
  request: (name: string) => Promise<void>;
  refresh: () => void;
}

export function useSystemPermissions(enabled: boolean): SystemPermissions {
  const [report, setReport] = useState<PermReport | null>(null);
  const [phase, setPhase] = useState<PermPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Guards every setState after an await. The screen is one step of a wizard
  // the user can leave mid-flight, and a poll resolving into an unmounted
  // component is a React warning at best and a state write that resurrects a
  // stale report at worst.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/system/permissions");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as PermReport;
      if (!alive.current) return;
      setReport(data);
      setPhase("ready");
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // Keep the last good report on screen rather than blanking the rows on
      // one dropped poll: a panel's socket flaps when the machine sleeps, and
      // rows vanishing and reappearing reads as breakage.
      setError(e instanceof Error ? e.message : String(e));
      setPhase((p) => (p === "loading" ? "error" : p));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, load, tick]);

  const request = useCallback(async (name: string) => {
    setPending(name);
    setRequestError(null);
    try {
      const r = await fetch("/api/system/permissions/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error((data as { error?: string } | null)?.error || `HTTP ${r.status}`);
      }
      if (!alive.current) return;

      const result = data as
        | { available: true; paneOpened: boolean; paneError?: string; grant: string }
        | { available: false; reason: string }
        | null;

      // A pane that did not open is the original bug wearing a new hat: the
      // user is told to go and flip a switch in a window that never appeared.
      // Say it plainly and name the pane, so the trip is still makeable by
      // hand.
      if (result && result.available && result.grant === "pane" && !result.paneOpened) {
        setRequestError(
          "Jarvis couldn't open System Settings. Open it yourself: Privacy & Security, then the section named below.",
        );
      }
    } catch (e) {
      if (!alive.current) return;
      setRequestError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setPending(null);
      // Re-read straight away rather than waiting out the poll: a "prompt"
      // permission can be granted in the dialog within a second, and the row
      // should follow the click, not the timer.
      void load();
    }
  }, [load]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return { phase, report, error, pending, requestError, request, refresh };
}
