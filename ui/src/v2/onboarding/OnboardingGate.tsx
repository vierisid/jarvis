import React, { useEffect, useState } from "react";
import { SetupRoom } from "./SetupRoom";
import { ProfileInterviewRoom } from "./ProfileInterviewRoom";
import { useOnboardingStatus } from "./useOnboardingStatus";

/**
 * Phase A + B onboarding gate. Sits between AppShellV2's render and
 * the AppShell + RoomDispatcher pair. Render order:
 *
 *   1. setup_completed === false        → <SetupRoom />
 *   2. profile_completed === false AND
 *      setup_skipped_profile === false  → <ProfileInterviewRoom />
 *   3. tutorial_completed === false     → (Phase C, future)
 *   4. otherwise                        → children (live shell)
 *
 * Loading state: render nothing for the brief status fetch (~50ms on
 * localhost) instead of a flash of skeleton — the bone background of
 * the dashboard root is already visible.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status, loading, refresh } = useOnboardingStatus();
  const [ttsDisabled, setTtsDisabled] = useState(false);

  // Look up TTS state once we're past setup so Phase B can decide
  // whether to render in voice or text-only mode. Cheap one-shot
  // fetch — TTS choice can change later via Settings but we capture
  // it at interview start.
  useEffect(() => {
    if (!status?.setup_completed) return;
    if (status.profile_completed || status.setup_skipped_profile) return;
    fetch("/api/config/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.enabled === "boolean") setTtsDisabled(!d.enabled);
      })
      .catch(() => setTtsDisabled(false));
  }, [status?.setup_completed, status?.profile_completed, status?.setup_skipped_profile]);

  if (loading || !status) {
    return null;
  }

  if (!status.setup_completed) {
    return (
      <SetupRoom
        onComplete={() => {
          refresh();
        }}
      />
    );
  }

  if (!status.profile_completed && !status.setup_skipped_profile) {
    return (
      <ProfileInterviewRoom
        ttsDisabled={ttsDisabled}
        onComplete={() => {
          refresh();
        }}
      />
    );
  }

  // TODO Phase C: tutorial gate (overlay on top of children)
  return <>{children}</>;
}
