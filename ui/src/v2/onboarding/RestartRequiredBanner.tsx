import { useMemo } from "react";
import type { OnboardingStatus } from "./useOnboardingStatus";

/**
 * Whether the restart banner should be visible for the given status.
 * Exported so the OnboardingGate can decide whether to wrap the shell
 * in the `.v2-shell-frame` grid container — when the banner is hidden,
 * wrapping causes the shell to collapse into the `auto` row track and
 * the composer ends up mid-page.
 */
export function shouldShowRestartBanner(status: OnboardingStatus | null): boolean {
  if (!status) return false;
  if (!status.setup_completed_at) return false;
  if (status.post_setup_services_ready !== false) return false;
  return true;
}

/**
 * Defensive fallback banner. The normal flow constructs the LLM-
 * dependent services in-process at `/api/onboarding/setup`, so this
 * stays hidden. It only fires when setup is complete AND the daemon
 * reports `post_setup_services_ready: false` — i.e. the in-process
 * construction failed, or the user is on a pre-fix daemon binary that
 * never wires services until restart.
 *
 * Defensive on missing field: status endpoints that don't send
 * `post_setup_services_ready` are treated as "ready" so we never show
 * a false positive against an old daemon that doesn't report the flag.
 */
export function RestartRequiredBanner({ status }: { status: OnboardingStatus | null }) {
  const visible = useMemo(() => shouldShowRestartBanner(status), [status]);

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
