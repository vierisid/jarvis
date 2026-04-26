import React from "react";
import { SetupRoom } from "./SetupRoom";
import { useOnboardingStatus } from "./useOnboardingStatus";

/**
 * Phase A — onboarding gate. Sits between AppShellV2's render and the
 * AppShell + RoomDispatcher pair. While `setup_completed === false`,
 * renders the fullscreen setup screens. Once setup completes, refetches
 * the status and falls through to the children (regular shell).
 *
 * Phase B and C will plug in additional renders here:
 *   - profile_completed === false → <ProfileInterviewRoom />
 *   - tutorial_completed === false → AppShell + <TutorialRoom /> overlay
 *
 * Loading state: render nothing for the brief status fetch (~50ms on
 * localhost) instead of a flash of skeleton — the bone background of
 * the dashboard root is already visible.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status, loading, refresh } = useOnboardingStatus();

  if (loading || !status) {
    // Empty bone canvas during the initial fetch. Better than a
    // skeleton that flashes for 50ms.
    return null;
  }

  if (!status.setup_completed) {
    return (
      <SetupRoom
        onComplete={() => {
          // The setup endpoint already wrote `setup_completed_at`.
          // Refetch the status so the gate flips to children on the
          // next render. No hard reload needed — daemon hot-reloaded
          // the LLM + TTS providers in-process.
          refresh();
        }}
      />
    );
  }

  // TODO Phase B: profile interview gate
  // TODO Phase C: tutorial gate (overlay on top of children)
  return <>{children}</>;
}
