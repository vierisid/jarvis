import React from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { useOnboardingStatus } from "./useOnboardingStatus";
import { RestartRequiredBanner, shouldShowRestartBanner } from "./RestartRequiredBanner";
import { WorkflowDraftContext } from "./WorkflowDraftContext";
import type { OnboardingDraft } from "../../brief/onboarding/draft";

/**
 * Gates the live shell on setup, the profile interview and the tutorial.
 * Carries an optional first-workflow request across the final status refresh.
 *
 * Loading state: render nothing for the brief status fetch (~50ms on
 * localhost) instead of a flash of skeleton — the bone background of
 * the dashboard root is already visible.
 */
export function OnboardingGate({ children, brief }: { children: React.ReactNode; brief?: OnboardingDraft }) {
  // Explicit host injection plus the new shell flag. A bookmark cannot install a provider.
  const adapter = typeof window !== "undefined" && new URL(window.location.href).searchParams.get("brief") === "1" ? brief : undefined;
  return adapter ? <BriefOnboardingGate key={adapter.scope} draft={adapter}>{children}</BriefOnboardingGate>
    : <LegacyOnboardingGate>{children}</LegacyOnboardingGate>;
}

function LegacyOnboardingGate({ children }: { children: React.ReactNode }) {
  const { status, loading, refresh } = useOnboardingStatus();
  const [prompt, setPrompt] = React.useState<string | null>(null);
  const consume = React.useCallback(() => setPrompt(null), []);
  const draftContext = React.useMemo(() => ({ prompt, consume }), [prompt, consume]);

  // Tell the cold-start splash the app has booted, the first time the status
  // resolves (to the wizard or the shell — either way boot is done).
  React.useEffect(() => {
    if (!loading && status) window.dispatchEvent(new Event("jarvis:boot-ready"));
  }, [loading, status]);

  // A background refresh must not unmount the wizard or an unsent Talk draft.
  if (!status) {
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
    return <OnboardingWizard status={status} onComplete={async (request) => {
      setPrompt(request ?? null);
      if (!await refresh()) throw new Error("Could not refresh onboarding status");
    }} />;
  }

  return (
    <WorkflowDraftContext.Provider value={draftContext}>
      <div className={`v2-shell-frame${shouldShowRestartBanner(status) ? "" : " v2-shell-frame--plain"}`}>
        <RestartRequiredBanner status={status} />
        {children}
      </div>
    </WorkflowDraftContext.Provider>
  );
}

const incomplete = (status: NonNullable<ReturnType<typeof useOnboardingStatus>["status"]>) =>
  !status.setup_completed || (!status.profile_completed && !status.setup_skipped_profile)
    || (!status.tutorial_completed && !status.tutorial_dismissed);

/** Keep an active wizard mounted through peer status refreshes and the final handoff.
 * Only the user can leave the final prompt; server tutorial completion is independent. */
function BriefOnboardingGate({ children, draft }: { children: React.ReactNode; draft: OnboardingDraft }) {
  const { status, loading, refresh } = useOnboardingStatus();
  const saved = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [active, setActive] = React.useState(false);
  const needsOnboarding = !!status && incomplete(status);
  React.useEffect(() => {
    if (needsOnboarding) setActive(true);
    if (!loading && status) window.dispatchEvent(new Event("jarvis:boot-ready"));
  }, [loading, status, needsOnboarding]);
  if (!status) return null;
  if (needsOnboarding || active || saved.routine || saved.request || saved.storageFailed) return <OnboardingWizard
    key={status.last_reset_at ?? 'initial'} status={status} brief={draft} onComplete={async () => {
      const fresh = await refresh();
      if (!fresh || incomplete(fresh)) throw Error("Onboarding is not complete");
      // Clearing must succeed before releasing the wizard; otherwise its saved request remains recoverable.
      draft.clear();
      setActive(false);
    }} />;
  return <div className={`v2-shell-frame${shouldShowRestartBanner(status) ? "" : " v2-shell-frame--plain"}`}>
    <RestartRequiredBanner status={status} />{children}
  </div>;
}
