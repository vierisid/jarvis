import { useCallback, useEffect, useRef, useState } from "react";
import { requestFeedback, type PermReport, type PermRequestResult, type PermUnavailable } from "./permission-rows";

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

/**
 * Reasons that will not change on their own, so polling them is pure waste: an
 * old sidecar answers METHOD_NOT_FOUND every two seconds forever, and a brain
 * that cannot tell which of several machines this is will not learn. Both keep
 * their manual "Check again", which is the only thing that can actually help.
 */
const SETTLED_REASONS: ReadonlySet<PermUnavailable> = new Set<PermUnavailable>(["unsupported", "ambiguous"]);

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
  /** Resolves true when the settings pane actually came up. */
  request: (name: string, label: string) => Promise<boolean>;
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

  // One fetch at a time.
  //
  // Two bugs in one guard. Without it a wedged sidecar - the daemon waits 8s
  // before giving up - accumulates four or five concurrent RPCs per open tab,
  // forever, and the sidecar's own 700ms coalescing cannot help because the
  // sidecar is the thing not answering. And a poll that started BEFORE a grant
  // can resolve after the re-read that observed it, writing the stale answer
  // back over the fresh one and flickering the row green, amber, green.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Whether there is any point asking again. Read through a ref so changing it
  // does not tear down and rebuild the interval on every poll.
  const settled = report !== null && !report.available && SETTLED_REASONS.has(report.reason);
  const settledRef = useRef(settled);
  settledRef.current = settled;

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => {
      if (settledRef.current) return;
      void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, load, tick]);

  const request = useCallback(async (name: string, label: string): Promise<boolean> => {
    setPending(name);
    setRequestError(null);
    try {
      const r = await fetch("/api/system/permissions/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await r.json().catch(() => null)) as
        | (PermRequestResult & { error?: string })
        | { error?: string }
        | null;
      if (!r.ok) {
        throw new Error((data as { error?: string } | null)?.error || `HTTP ${r.status}`);
      }
      if (!alive.current) return false;

      // The route answers 200 for every `available: false` outcome, so `r.ok`
      // is not the question. requestFeedback is where that is decided.
      const result = data as PermRequestResult | null;
      setRequestError(requestFeedback(result, label));
      return result?.available === true && result.grant === "pane" && result.paneOpened;
    } catch (e) {
      if (!alive.current) return false;
      setRequestError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (alive.current) setPending(null);
      // Re-read straight away rather than waiting out the poll: a "prompt"
      // permission can be granted in the dialog within a second, and the row
      // should follow the click, not the timer.
      void load();
    }
  }, [load]);

  const refresh = useCallback(() => {
    // Back to "loading" so a retry against a still-dead brain visibly does
    // something. Without it the button is decorative: the same error text sits
    // there and nothing on screen changes.
    setPhase("loading");
    setTick((n) => n + 1);
  }, []);

  return { phase, report, error, pending, requestError, request, refresh };
}
