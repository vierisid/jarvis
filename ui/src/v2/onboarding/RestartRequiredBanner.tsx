import { useMemo } from "react";
import type { OnboardingStatus } from "./useOnboardingStatus";

/**
 * Banner shown post-setup when the daemon needs to be restarted before
 * background services (heartbeat, commitments, awareness) become active.
 *
 * Background:
 *   `bgAgent`, `commitmentExecutor`, and `awarenessService` are
 *   constructed at daemon boot, gated on `setup_completed_at !== null`.
 *   The setup-completion endpoint flips the flag and hot-reloads LLM
 *   providers, but it doesn't construct those services in-process. Until
 *   the in-process construction lands (follow-up issue F2), users have
 *   to restart the daemon for those features to come online.
 *
 * Detection:
 *   The /api/onboarding/status endpoint now exposes `daemon_started_at`.
 *   We compare against `setup_completed_at`. If the user finished setup
 *   AFTER this daemon process booted, the flag is set but the services
 *   aren't running — show the banner. If the user has restarted since,
 *   `daemon_started_at` will be later than `setup_completed_at` and the
 *   banner stays hidden.
 *
 * Defensive on missing field: pre-fix daemons don't send
 * `daemon_started_at`. In that case we hide the banner rather than
 * showing a false-positive.
 */
export function RestartRequiredBanner({ status }: { status: OnboardingStatus | null }) {
  const visible = useMemo(() => {
    if (!status) return false;
    if (!status.setup_completed_at) return false;
    if (typeof status.daemon_started_at !== "number") return false;
    return status.setup_completed_at > status.daemon_started_at;
  }, [status]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="v2-restart-banner"
      style={{
        background: "rgba(255, 196, 0, 0.12)",
        border: "1px solid rgba(255, 196, 0, 0.35)",
        color: "#cda64f",
        padding: "10px 16px",
        borderRadius: 8,
        margin: "8px 16px",
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span aria-hidden style={{ fontSize: 16 }}>↻</span>
      <span>
        <strong>Restart Jarvis</strong> to enable background processing —
        your heartbeat, commitments, and awareness services will activate
        after the next start.
      </span>
      <code
        style={{
          marginLeft: "auto",
          background: "rgba(0,0,0,0.2)",
          padding: "2px 8px",
          borderRadius: 4,
        }}
      >
        jarvis restart
      </code>
    </div>
  );
}
