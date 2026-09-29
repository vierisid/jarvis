import { useCallback, useEffect, useRef, useState } from "react";

/** Phase E — same-origin BroadcastChannel name for cross-tab onboarding
 *  state sync. When one tab finishes a phase (or fires a reset), it
 *  posts on this channel; peer tabs re-fetch their status so the gate
 *  re-renders without a manual refresh. Exported so the resetClient
 *  can also fire the broadcast (covers the reset-from-other-tab case). */
export const ONBOARDING_BROADCAST_CHANNEL = "v2-onboarding-status";

export type OnboardingBroadcastMessage =
  | { type: "status_changed" }
  | { type: "reset"; scope: string };

/** Create a channel object — returns null in environments without
 *  BroadcastChannel (older Safari, SSR, tests). Callers should null-
 *  check before using.
 *
 *  Named `create`, not `get`: every call hands back a FRESH object, and a
 *  channel never delivers to the object that posted while it does deliver
 *  to every other object on the name. Calling this once to listen and
 *  again to post is what made a tab hear itself (#556), so a caller that
 *  does both has to hold on to one object. */
export function createOnboardingBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(ONBOARDING_BROADCAST_CHANNEL);
}

/**
 * Onboarding status snapshot from `GET /api/onboarding/status`.
 * Mirrors the response shape returned by `src/daemon/api-routes.ts`.
 */
export interface OnboardingStatus {
  setup_completed: boolean;
  setup_completed_at: number | null;
  setup_skipped_profile: boolean;
  profile_completed: boolean;
  tutorial_completed: boolean;
  tutorial_completed_at: number | null;
  tutorial_dismissed: boolean;
  tutorial_progress_step: string | null;
  last_reset_at: number | null;
  /** Daemon process boot time (ms). Used in tandem with
   *  `post_setup_services_ready` to detect a stale daemon that needs a
   *  restart. */
  daemon_started_at?: number;
  /** True once the LLM-dependent background services (bgAgent,
   *  commitment executor, awareness) are running. The normal flow
   *  constructs them in-process at `/api/onboarding/setup`, so this
   *  flips to true without a daemon restart. The "Restart Jarvis"
   *  banner only shows when setup is complete but this is false — a
   *  defensive fallback for failed in-process construction or daemons
   *  on a pre-fix binary. */
  post_setup_services_ready?: boolean;
}

interface HookValue {
  status: OnboardingStatus | null;
  loading: boolean;
  /** Network/server error from the last fetch — null on success. */
  error: string | null;
  /** Re-fetch the status. UI calls this after `/api/onboarding/setup`
   *  succeeds so the gate can flip from setup screens to the live
   *  shell without a hard reload. */
  refresh: () => Promise<OnboardingStatus | null>;
}

/**
 * Phase A — onboarding status hook for the OnboardingGate. Single
 * fetch on mount, plus a manual `refresh` for use after a setup-
 * complete or reset. Intentionally NOT polled: the gate only ever
 * needs to react to (a) initial load, (b) the user finishing setup,
 * (c) the user firing a reset. Each of those triggers an explicit
 * refresh. Polling would add noise on a daemon that's barely doing
 * anything in setup mode.
 */
export function useOnboardingStatus(): HookValue {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The one channel object this hook instance both listens on and posts
   *  on — see `channelRef` usage below for why it has to be the same one. */
  const channelRef = useRef<BroadcastChannel | null>(null);
  /** Mirror of `status`, so `refresh` can compare the previous snapshot
   *  without depending on the state value (which would re-create the
   *  callback) and without side-effecting inside a `setStatus` updater
   *  (which React is free to call twice, or later than we read it). */
  const statusRef = useRef<OnboardingStatus | null>(null);

  /** `fromPeer` marks a read we are doing *because* a peer told us to, so
   *  it must not be echoed back. It is a parameter rather than a shared
   *  `broadcasting` flag because the flag could not tell one in-flight
   *  refresh from another: a local flip landing during a peer-driven read
   *  was silently swallowed, and a second peer-driven read outliving the
   *  first one's reset echoed anyway — the exact ping-pong the flag was
   *  there to stop. Kept off the public `refresh` below so no caller can
   *  pass it by accident (a click handler would hand us its event). */
  const read = useCallback(async (fromPeer: boolean) => {
    setLoading(true);
    try {
      const json = await fetchStatusWithRetry();
      const prev = statusRef.current;
      statusRef.current = json;
      setStatus(json);
      setError(null);
      // Phase E — when this read was triggered locally and any phase flag
      // flipped, broadcast so peer tabs re-fetch.
      //
      // Posting on OUR OWN channel object is the point: a BroadcastChannel
      // never delivers to the object that posted, so this cannot come back
      // to our own listener, while every other object on the name — a peer
      // tab, or a second hook instance in this tab — still gets it.
      // Creating a throwaway channel here instead (#556) made the tab hear
      // itself and burn a second status read on every flip.
      //
      // `channelRef` is null before the subscribe effect assigns it, once
      // that effect has torn down, and for the whole mount in an
      // environment with no BroadcastChannel. So a flip that lands after
      // unmount goes unannounced; peers pick it up on their next read,
      // which is the best-effort contract this channel has always had.
      // Wrapped because a post must never be the reason a successful
      // status read looks like a failure to the gate.
      if (!fromPeer && prev !== null && phaseFlagsChanged(prev, json)) {
        try {
          channelRef.current?.postMessage(
            { type: "status_changed" } satisfies OnboardingBroadcastMessage,
          );
        } catch {
          /* best-effort; a peer's next read still picks the change up */
        }
      }
      return json;
    } catch (err) {
      // Keep the last valid snapshot on a background refresh failure. This
      // preserves the user's interview/activation or unsent Talk draft.
      // The initial-load fallback remains available for a new install.
      setError(err instanceof Error ? err.message : String(err));
      statusRef.current = statusRef.current ?? {
        setup_completed: false,
        setup_completed_at: null,
        setup_skipped_profile: false,
        profile_completed: false,
        tutorial_completed: false,
        tutorial_completed_at: null,
        tutorial_dismissed: false,
        tutorial_progress_step: null,
        last_reset_at: null,
      };
      setStatus(statusRef.current);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Phase E — listen for status changes from peer tabs. When a sibling tab
  // finishes setup / wraps the interview / completes the tutorial / fires a
  // reset, it posts on the channel and we re-fetch here. `read(true)` marks
  // that re-fetch as peer-driven so it is not echoed back.
  //
  // This effect owns the channel for the whole mount: it publishes it on
  // `channelRef` for `read` to post on and closes it exactly once, on its
  // own cleanup. Nothing outside this mount holds it, so closing it can
  // never pull the channel out from under another consumer. Declared
  // before the initial-fetch effect so the channel is already in place by
  // the time any read could want to post.
  useEffect(() => {
    const ch = createOnboardingBroadcastChannel();
    if (!ch) return;
    channelRef.current = ch;
    const onMessage = (e: MessageEvent<OnboardingBroadcastMessage>) => {
      if (e.data?.type === "status_changed" || e.data?.type === "reset") {
        void read(true);
      }
    };
    ch.addEventListener("message", onMessage);
    return () => {
      channelRef.current = null;
      ch.removeEventListener("message", onMessage);
      ch.close();
    };
  }, [read]);

  useEffect(() => {
    void read(false);
  }, [read]);

  /** The public re-read: always local, so a flip it observes is announced. */
  const refresh = useCallback(() => read(false), [read]);

  return { status, loading, error, refresh };
}

/** Base backoff between status attempts. Mutable so tests can shorten it. */
export const STATUS_RETRY = { delayMs: 700 };

/** Fetch `/api/onboarding/status` with a few short retries. A daemon
 *  that is mid-restart (or briefly 503ing while services come up) used
 *  to fail the single fetch, and the error fallback re-showed the full
 *  setup flow to an already-onboarded user. Three attempts over ~2s
 *  ride out the transient without meaningfully delaying real new
 *  installs (where the endpoint answers instantly). */
async function fetchStatusWithRetry(): Promise<OnboardingStatus> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * STATUS_RETRY.delayMs));
    }
    try {
      const r = await fetch("/api/onboarding/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as OnboardingStatus;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Compare phase-relevant flags between two snapshots. Returns true if
 *  any flag the gate cares about flipped — used to decide whether to
 *  broadcast a status_changed event to peer tabs. */
function phaseFlagsChanged(a: OnboardingStatus, b: OnboardingStatus): boolean {
  return (
    a.setup_completed !== b.setup_completed ||
    a.setup_skipped_profile !== b.setup_skipped_profile ||
    a.profile_completed !== b.profile_completed ||
    a.tutorial_completed !== b.tutorial_completed ||
    a.tutorial_dismissed !== b.tutorial_dismissed
  );
}
