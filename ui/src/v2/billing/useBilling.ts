import { useEffect, useSyncExternalStore } from "react";
import {
  billingRecheckDue,
  classifyBillingResponse,
  type BillingLinks,
  type BillingSummary,
} from "./billing-view";

/**
 * Reads the daemon's GET /api/billing for Settings -> Billing AND the shell
 * banner, through ONE shared store, so the two never disagree and never take a
 * request each.
 *
 * TRI-state like the usage meter (useHostedBudget.ts): "unknown" renders
 * nothing and retries; only a real 503 means self-hosted. A read that fails
 * after a good one KEEPS the good one on screen, marked stale, rather than
 * blanking a user's bill because the control plane hiccupped.
 *
 * Changes happen in the system browser, so coming BACK is the moment the data
 * is most likely stale: focus and visibility trigger a fresh read (the daemon
 * floors those at a few seconds, so a focus storm is not a request storm).
 */

export type BillingLoadState = "unknown" | "self" | "ready" | "unavailable";

export interface BillingSnapshot {
  state: BillingLoadState;
  summary: BillingSummary | null;
  links: BillingLinks | null;
  /** The last read failed or answered "unavailable" while a summary is shown. */
  stale: boolean;
  /** When the current summary (or the self-hosted answer) was read; 0 before any. */
  readAt: number;
}

/** Matches the 60s caches on both sides. */
export const BILLING_POLL_MS = 60_000;
const RETRY_MS = 5_000;

const INITIAL: BillingSnapshot = { state: "unknown", summary: null, links: null, stale: false, readAt: 0 };

let snapshot: BillingSnapshot = INITIAL;
const listeners = new Set<() => void>();
let inFlight = false;
let retryTimer: number | null = null;
let backoff = RETRY_MS;

function publish(next: BillingSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

async function load(fresh: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch(fresh ? "/api/billing?fresh=1" : "/api/billing");
    // The 503 body matters too: only the daemon's own JSON error means self-hosted.
    const body = res.status === 200 || res.status === 503 ? await res.json().catch(() => null) : null;
    const probe = classifyBillingResponse(res.status, body);
    if (probe.kind === "failed") throw new Error(`HTTP ${res.status}`);
    backoff = RETRY_MS;
    if (probe.kind === "self") {
      // readAt stamps the answer, so it is re-asked only rarely (billingRecheckDue).
      publish({ ...INITIAL, state: "self", readAt: Date.now() });
    } else if (probe.kind === "ready") {
      publish({ state: "ready", summary: probe.summary, links: probe.links, stale: false, readAt: Date.now() });
    } else if (snapshot.summary) {
      // Keep the last good bill on screen; say it could not be refreshed.
      publish({ ...snapshot, links: probe.links ?? snapshot.links, stale: true });
    } else {
      publish({ ...INITIAL, state: "unavailable", links: probe.links });
    }
  } catch {
    if (snapshot.summary) publish({ ...snapshot, stale: true });
    if (listeners.size > 0 && retryTimer === null) {
      const wait = backoff;
      backoff = Math.min(wait * 2, BILLING_POLL_MS);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!document.hidden) void load(false);
      }, wait);
    }
  } finally {
    inFlight = false;
  }
}

let pollTimer: number | null = null;

function onReturn(): void {
  if (!document.hidden && billingRecheckDue(snapshot.state, snapshot.readAt, Date.now())) void load(true);
}

function start(): void {
  void load(false);
  pollTimer = window.setInterval(() => {
    if (!document.hidden && billingRecheckDue(snapshot.state, snapshot.readAt, Date.now())) void load(false);
  }, BILLING_POLL_MS);
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
}

function stop(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  pollTimer = null;
  retryTimer = null;
  window.removeEventListener("focus", onReturn);
  document.removeEventListener("visibilitychange", onReturn);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useBilling(
  /**
   * `refreshOnMount: false` for callers that only need the load state (the
   * Settings tab list): they must not turn opening Settings into a read.
   */
  opts: { refreshOnMount?: boolean } = {},
): BillingSnapshot & { refresh: () => void } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => INITIAL);
  const refreshOnMount = opts.refreshOnMount ?? true;
  // Opening Settings -> Billing is itself a reason to look again, including
  // onto an "unavailable" screen, which schedules no retry of its own. The very
  // first mount already loads through subscribe().
  useEffect(() => {
    if (refreshOnMount && (snapshot.state === "ready" || snapshot.state === "unavailable")) void load(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- a mount-time read, by definition
  return { ...snap, refresh: () => void load(true) };
}
