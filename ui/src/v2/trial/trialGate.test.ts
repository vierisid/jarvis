import { describe, expect, test } from "bun:test";
import { NO_TRIAL, formatTimeRemaining, trialIsLive, trialRunsConductor, type TrialStatus } from "./trialGate";

/** Pure-function test, the OnboardingWizard.steps.test.ts precedent, this
 *  repo has no DOM test infrastructure. The rule under test is the NEGATIVE
 *  one: an install with no entitlement (every install today) must reach the
 *  existing onboarding path, and the gate's branch is the only thing standing
 *  between them and a microphone screen they cannot get past. */

function trial(over: Partial<TrialStatus> = {}): TrialStatus {
  return { ...NO_TRIAL, present: true, state: "issued", ...over };
}

describe("nobody outside a trial sees the conductor", () => {
  test("no entitlement means the wizard, unchanged", () => {
    expect(trialRunsConductor(NO_TRIAL)).toBe(false);
  });

  test("a status that has not loaded yet is not a trial", () => {
    // The gate holds on `trialLoading` rather than reading this, but a null
    // must never read as a trial even if that ever changes.
    expect(trialRunsConductor(null)).toBe(false);
  });

  test("a failed status fetch falls to the wizard, not to a mic gate", () => {
    // useTrialStatus resolves a failed fetch to NO_TRIAL for exactly this.
    expect(trialRunsConductor(NO_TRIAL)).toBe(false);
  });

  test("a present-but-stateless record is not a trial", () => {
    expect(trialRunsConductor({ ...NO_TRIAL, present: true })).toBe(false);
  });

  test("an expired trial gets the ordinary shell, not a conductor with no voice", () => {
    expect(trialRunsConductor(trial({ state: "expired" }))).toBe(false);
  });
});

describe("who does get it", () => {
  test("an issued grant, before they have spoken, that is the whole point", () => {
    expect(trialRunsConductor(trial({ state: "issued", started_at: null }))).toBe(true);
  });

  test("an active grant, so a reload mid-conversation comes back to it", () => {
    expect(trialRunsConductor(trial({ state: "active", started_at: 1, expires_at: 2 }))).toBe(true);
  });

  test("a completed opening still runs the conductor, the conversation continues (D17)", () => {
    // The seam is not an exit. Beats 06 to 12 happen inside this same surface.
    expect(trialRunsConductor(trial({ state: "active", opening_completed_at: 123 }))).toBe(true);
  });
});

/* ══════════ the handover, seen from a reload ══════════

   The manager's instinct, and mine: re-entering at hour 20 leaves the founder
   in the ordinary shell rather than replaying the conducted hour. The arc is
   one-way. Their quarter is built, their folder has been read, their agent has
   come back; running it again would ask them to build a quarter they already
   own while Jarvis pretended not to know them, and a founder who has to sit
   through an hour they have already lived just to reach their own product is
   the reported bug wearing a different coat. Skipping is the cheaper mistake
   by a wide margin, and the D38 debrief is what will inventory it all at the
   end anyway.

   The trial itself is untouched by any of this. */

describe("after the conductor has stood down", () => {
  test("a reload gets the shell, not the conversation they already had", () => {
    expect(trialRunsConductor(trial({ state: "active", conductor_finished_at: 123 }))).toBe(false);
  });

  test("but the trial is still live, so they still get the clock and realtime", () => {
    expect(trialIsLive(trial({ state: "active", conductor_finished_at: 123 }))).toBe(true);
  });

  test("and they must never fall through to the wizard the trial replaced", () => {
    // The gate checks `trialIsLive` BEFORE the wizard check for this reason:
    // everything Jarvis knows about this founder was learned by voice (D8),
    // and a nine-step setup form halfway through their own trial would be the
    // same bug in different clothes.
    const handedOver = trial({ state: "active", conductor_finished_at: 123 });
    expect(trialRunsConductor(handedOver)).toBe(false);
    expect(trialIsLive(handedOver)).toBe(true);
  });

  test("an expired trial is not live either way", () => {
    expect(trialIsLive(trial({ state: "expired", conductor_finished_at: 123 }))).toBe(false);
    expect(trialRunsConductor(trial({ state: "expired", conductor_finished_at: 123 }))).toBe(false);
  });

  test("nobody outside a trial is affected by any of it", () => {
    expect(trialIsLive(NO_TRIAL)).toBe(false);
    expect(trialIsLive(null)).toBe(false);
  });

  test("a record written before the stand-down existed still runs the conductor", () => {
    // `conductor_finished_at` is absent on every entitlement issued before
    // this shipped, and absent has to mean "has not finished": those founders
    // never got a handover.
    const old = trial({ state: "active" });
    delete (old as { conductor_finished_at?: number | null }).conductor_finished_at;
    expect(trialRunsConductor(old)).toBe(true);
  });
});

describe("time remaining", () => {
  test("reads as unstarted before the first spoken word (D9)", () => {
    expect(formatTimeRemaining(null)).toBeNull();
  });

  test("hours and minutes, then minutes alone, then up", () => {
    expect(formatTimeRemaining(48 * 3_600_000)).toBe("48h 0m");
    expect(formatTimeRemaining(90 * 60_000)).toBe("1h 30m");
    expect(formatTimeRemaining(7 * 60_000)).toBe("7m");
    expect(formatTimeRemaining(0)).toBe("up");
    expect(formatTimeRemaining(-5)).toBe("up");
  });
});
