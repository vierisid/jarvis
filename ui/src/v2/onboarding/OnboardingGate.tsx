import React from "react";
import { OnboardingWizard } from "./OnboardingWizard";
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

  // Tell the cold-start splash the app has booted, the first time the status
  // resolves (to the wizard or the shell — either way boot is done).
  React.useEffect(() => {
    if (!loading && status) window.dispatchEvent(new Event("jarvis:boot-ready"));
  }, [loading, status]);

  if (loading || !status) {
    return null;
  }

  // Any incomplete onboarding phase → the nine-screen wizard. It computes
  // its own resume step from the status flags and fires each phase's
  // completion endpoint internally, so the gate just shows it until every
  // flag is set, then falls through to the live shell.
  const needsOnboarding =
    !status.setup_completed ||
    (!status.profile_completed && !status.setup_skipped_profile) ||
    (!status.tutorial_completed && !status.tutorial_dismissed);
  if (needsOnboarding) {
    return <OnboardingWizard status={status} onComplete={() => refresh()} />;
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
