/**
 * What a trial install needs marked before the conductor can run.
 *
 * The nine-step wizard is the thing that normally writes
 * `onboarding.setup_completed_at`, and D10 removes the wizard for trial users.
 * Without a stand-in, a founder who has just had a forty-minute conversation
 * with their co-founder would land in a shell where chat is refused
 * (`setup_required`) and the background services were never constructed.
 *
 * A trial install is by definition one the platform provisions, the brain,
 * the hearing and the speaking come from the hosted plan, which is exactly why
 * the spec says those three wizard steps "become unnecessary under trial
 * auto-provisioning". So the flag is honest: there is nothing left for the
 * founder to answer.
 *
 * NOT covered by decisions.md, recorded as a judgement made here:
 *  - `setup_completed_at` is stamped when the opening BEGINS, not when it ends.
 *    A daemon restart in the middle of the conversation must not drop the
 *    founder back into a wizard they were deliberately never shown.
 *  - `tutorial_dismissed_at` is stamped with it. The wizard's tour is the thing
 *    the seven room beats replace, and under D17 those happen inside the
 *    conversation. Leaving it unset would pop the old tour over the top of a
 *    live trial.
 *  - The profile interview flag is deliberately NOT touched. The conductor
 *    fills the profile for real, through `capture_fuel`, so it completes
 *    itself; marking it skipped would throw away what it learns.
 */

import type { JarvisConfig } from '../../config/types.ts';
import { saveUserSection } from '../user-settings.ts';

export type TrialProvisionResult = {
  /** True when this call is what marked the install onboarded. */
  marked: boolean;
  setup_completed_at: number;
};

/**
 * Mark a trial install as onboarded. Idempotent: an install that already
 * completed setup (a returning user, or a second conductor session) is left
 * exactly as it is, including its original timestamp.
 */
export function markTrialInstallOnboarded(
  config: JarvisConfig,
  now = Date.now(),
): TrialProvisionResult {
  const existing = config.onboarding?.setup_completed_at;
  if (existing != null) return { marked: false, setup_completed_at: existing };

  const onboarding = {
    setup_completed_at: now,
    tutorial_completed_at: config.onboarding?.tutorial_completed_at ?? null,
    setup_skipped_profile: config.onboarding?.setup_skipped_profile,
    tutorial_dismissed_at: config.onboarding?.tutorial_dismissed_at ?? now,
    tutorial_progress_step: config.onboarding?.tutorial_progress_step,
    last_reset_at: config.onboarding?.last_reset_at,
  };
  saveUserSection('onboarding', onboarding);
  config.onboarding = onboarding;
  return { marked: true, setup_completed_at: now };
}
