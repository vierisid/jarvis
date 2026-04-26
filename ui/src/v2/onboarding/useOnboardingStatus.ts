import { useCallback, useEffect, useState } from "react";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/onboarding/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as OnboardingStatus;
      setStatus(json);
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

  return { status, loading, error, refresh };
}
