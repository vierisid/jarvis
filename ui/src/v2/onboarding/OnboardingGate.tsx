import React, { useEffect, useState } from "react";
import { SetupRoom } from "./SetupRoom";
import { ProfileInterviewRoom } from "./ProfileInterviewRoom";
import { TutorialRoom } from "./TutorialRoom";
import { TutorialEventProvider } from "./TutorialEventContext";
import { useOnboardingStatus } from "./useOnboardingStatus";
import { RestartRequiredBanner, shouldShowRestartBanner } from "./RestartRequiredBanner";

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

  // Phase C — spotlight tutorial overlay. Renders on TOP of the
  // children (the live AppShell + RoomDispatcher) instead of
  // replacing them, so the user can see and interact with the real
  // surfaces being explained. Wraps in TutorialEventProvider so the
  // AppShell can fire palette_opened / room_opened / notif_opened
  // events that the tutorial subscribes to for auto-advance.
  if (!status.tutorial_completed && !status.tutorial_dismissed) {
    const showBanner = shouldShowRestartBanner(status);
    return (
      <TutorialEventProvider>
        {showBanner ? (
          <div className="v2-shell-frame">
            <RestartRequiredBanner status={status} />
            {children}
          </div>
        ) : (
          children
        )}
        <TutorialRoom
          resumeFromStepId={status.tutorial_progress_step}
          onComplete={() => refresh()}
          // The samples need to land in the real `live.items` / room
          // window store. We can't reach the AppShell's `useLiveThread`
          // from here without prop-drilling — instead, the tutorial
          // dispatches `injectSampleCard` / `injectSampleRoomWindow`
          // events that AppShell subscribes to. To keep this gate
          // dumb, we use window CustomEvents — Jarvis-internal,
          // never crosses the WS boundary.
          injectSampleCard={() =>
            window.dispatchEvent(new CustomEvent("v2-tutorial:inject-card"))
          }
          injectSampleRoomWindow={() =>
            window.dispatchEvent(new CustomEvent("v2-tutorial:inject-roomwindow"))
          }
        />
      </TutorialEventProvider>
    );
  }

  if (shouldShowRestartBanner(status)) {
    return (
      <div className="v2-shell-frame">
        <RestartRequiredBanner status={status} />
        {children}
      </div>
    );
  }

  return <>{children}</>;
}
