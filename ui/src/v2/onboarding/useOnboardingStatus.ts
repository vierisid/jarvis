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

/** Lazily create the channel — returns null in environments without
 *  BroadcastChannel (older Safari, SSR, tests). Callers should null-
 *  check before using. */
export function getOnboardingBroadcastChannel(): BroadcastChannel | null {
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
  refresh: () => Promise<void>;
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
  const broadcastingRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/onboarding/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as OnboardingStatus;
      setStatus((prev) => {
        // Phase E — when this refresh was triggered locally (not by a
        // peer tab) and any phase flag flipped, broadcast so peers
        // re-fetch. The broadcastingRef guard prevents re-broadcasting
        // a status change we just received from a peer.
        if (!broadcastingRef.current && prev !== null && phaseFlagsChanged(prev, json)) {
          const ch = getOnboardingBroadcastChannel();
          if (ch) {
            try {
              ch.postMessage({ type: "status_changed" } satisfies OnboardingBroadcastMessage);
            } finally {
              ch.close();
            }
          }
        }
        return json;
      });
      setError(null);
    } catch (err) {
      // The status endpoint is one of the few routes that should
      // ALWAYS work — even in setup mode. If it 5xxs we treat it as
      // "not yet onboarded" rather than blocking the user behind a
      // permanent error screen. The OnboardingGate's render path
      // checks `status === null` to mean "still loading"; we set a
      // sentinel below so the gate falls through to setup screens.
      setError(err instanceof Error ? err.message : String(err));
      setStatus({
        setup_completed: false,
        setup_completed_at: null,
        setup_skipped_profile: false,
        profile_completed: false,
        tutorial_completed: false,
        tutorial_completed_at: null,
        tutorial_dismissed: false,
        tutorial_progress_step: null,
        last_reset_at: null,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Phase E — listen for status changes from peer tabs. When a
  // sibling tab finishes setup / wraps the interview / completes the
  // tutorial / fires a reset, it posts on the channel and we re-fetch
  // here. The `broadcastingRef` guard inside `refresh` keeps us from
  // ping-ponging the broadcast back.
  useEffect(() => {
    const ch = getOnboardingBroadcastChannel();
    if (!ch) return;
    const onMessage = (e: MessageEvent<OnboardingBroadcastMessage>) => {
      if (e.data?.type === "status_changed" || e.data?.type === "reset") {
        broadcastingRef.current = true;
        refresh().finally(() => {
          broadcastingRef.current = false;
        });
      }
    };
    ch.addEventListener("message", onMessage);
    return () => {
      ch.removeEventListener("message", onMessage);
      ch.close();
    };
  }, [refresh]);

  return { status, loading, error, refresh };
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
