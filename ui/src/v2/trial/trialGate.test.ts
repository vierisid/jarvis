import { describe, expect, test } from "bun:test";
import { NO_TRIAL, formatTimeRemaining, trialRunsConductor, type TrialStatus } from "./trialGate";

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
