/**
 * Does this install run the trial's opening instead of the nine-step wizard?
 *
 * Pure, and separated from the gate component precisely so it can be TESTED
 * rather than asserted: the rule that matters here is the negative one, an
 * install with no entitlement, which is every install today, must reach the
 * existing onboarding path untouched.
 */

export type TrialState = "issued" | "active" | "expired";

/** Mirrors `TrialSnapshot` in src/trial/entitlement.ts. */
export interface TrialStatus {
  present: boolean;
  state: TrialState | null;
  started_at: number | null;
  expires_at: number | null;
  ms_remaining: number | null;
  opening_completed_at: number | null;
  /** When the conductor stood down. The trial carries on; only it finished. */
  conductor_finished_at?: number | null;
}

export const NO_TRIAL: TrialStatus = {
  present: false,
  state: null,
  started_at: null,
  expires_at: null,
  ms_remaining: null,
  opening_completed_at: null,
  conductor_finished_at: null,
};

/**
 * True only for a real, unexpired entitlement.
 *
 * `issued` counts: the clock has not started because the founder has not spoken
 * yet (D9), and that is exactly who the opening is for. `expired` does not,
 * a lapsed trial gets the ordinary shell, not a conductor with no voice behind
 * it.
 *
 * A null status (still loading, or the endpoint failed) is NOT a trial. The
 * failure mode has to be "everyone gets today's onboarding", never "a
 * non-trial user is dropped into a microphone gate they cannot get past".
 */
export function trialRunsConductor(trial: TrialStatus | null): boolean {
  if (!trialIsLive(trial)) return false;
  // THE HANDOVER, on a reload.
  //
  // The conducted part of the trial is about an hour of the 48. Once it has
  // finished, coming back at hour 20 must give the founder their shell, not
  // the conversation they already had: the arc is one-way (an OKR tree they
  // built, a folder that has been read, an agent that came back), and running
  // it again would ask them to build a quarter they already own while Jarvis
  // pretended not to know them. Skipping a conducted hour they have already
  // lived is the cheaper mistake by a wide margin.
  //
  // The trial itself is untouched by this: `trialIsLive` is still true, the
  // clock is still running, D1's realtime is still on, and everything the two
  // of them built is still in the vault.
  return !trial!.conductor_finished_at;
}

/**
 * Is there a running trial at all, conducted or not?
 *
 * The gate needs both questions answered separately now. A founder whose
 * conductor has finished is still on a trial: they keep the countdown, they
 * keep realtime, and they must never be dropped into the nine-step wizard the
 * trial replaced.
 */
export function trialIsLive(trial: TrialStatus | null): boolean {
  if (!trial?.present) return false;
  return trial.state === "issued" || trial.state === "active";
}

/** Human-readable time left, for the shell. Null before the clock starts. */
export function formatTimeRemaining(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms <= 0) return "up";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
