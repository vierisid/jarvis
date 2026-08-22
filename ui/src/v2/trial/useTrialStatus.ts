import { useCallback, useEffect, useState } from "react";
import { NO_TRIAL, type TrialStatus } from "./trialGate";

/**
 * The trial entitlement snapshot, from `GET /api/trial/status`.
 *
 * Fetched once on mount alongside the onboarding status. On every install that
 * has no entitlement — all of them today — this answers `{present: false}` and
 * the gate falls straight through to the existing wizard path.
 *
 * A failed fetch resolves to NO_TRIAL rather than staying null forever: a
 * daemon that cannot answer must not strand a non-trial user on a blank screen.
 */
export function useTrialStatus(): { trial: TrialStatus | null; loading: boolean; refresh: () => Promise<void> } {
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/trial/status");
      setTrial(r.ok ? ((await r.json()) as TrialStatus) : NO_TRIAL);
    } catch {
      setTrial(NO_TRIAL);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { trial, loading, refresh };
}
