import React from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { useOnboardingStatus } from "./useOnboardingStatus";
import { RestartRequiredBanner, shouldShowRestartBanner } from "./RestartRequiredBanner";
import { TrialConductor } from "../trial/TrialConductor";
import { TrialClock } from "../trial/TrialClock";
import { trialIsLive, trialRunsConductor } from "../trial/trialGate";
import { useTrialStatus } from "../trial/useTrialStatus";

/**
 * Phase A + B onboarding gate. Sits between AppShellV2's render and
 * the AppShell + RoomDispatcher pair. Render order:
 *
 *   0. a running trial, conductor unfinished → <TrialConductor /> over the shell
 *   0b. a running trial, conductor finished  → the shell, plus the clock
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
  const { trial, loading: trialLoading } = useTrialStatus();

  // Tell the cold-start splash the app has booted, the first time the status
  // resolves (to the wizard or the shell — either way boot is done).
  React.useEffect(() => {
    if (!loading && status) window.dispatchEvent(new Event("jarvis:boot-ready"));
  }, [loading, status]);

  if (loading || !status || trialLoading) {
    return null;
  }

  // The 48-hour trial replaces the wizard entirely (D10): the microphone is
  // asked for, then Jarvis speaks first and the conversation runs OVER the
  // live shell, which is what lets the founder watch their vault fill while
  // they talk (D22) and is where the seven room beats will attach (D17).
  //
  // `trialRunsConductor` is false for a null or absent entitlement, so an
  // install with no trial, every install today, falls straight through to
  // the existing path below, unchanged.
  if (trialRunsConductor(trial)) {
    return <TrialConductor>{children}</TrialConductor>;
  }

  // The conducted hour has finished and the other 47 have not. This is the
  // reload-at-hour-20 path and it deliberately does NOT restart the conductor:
  // the arc is one-way (a quarter they built, a folder that has been read, an
  // agent that came back), so running it again would ask them to build a
  // quarter they already own while Jarvis pretended not to know them.
  //
  // It also has to come BEFORE the wizard check. The trial replaced the wizard
  // entirely (D10) and everything it knows about the founder was learned by
  // voice; dropping them into a nine-step setup form halfway through their own
  // trial would be the same bug wearing different clothes.
  if (trialIsLive(trial)) {
    return <TrialClock trial={trial}>{children}</TrialClock>;
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
