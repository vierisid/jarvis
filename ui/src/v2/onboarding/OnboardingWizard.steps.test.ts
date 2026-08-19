import { describe, expect, test } from "bun:test";
import { HOSTED_PROVISIONED, STEPS, stepsFor, stepGatedOnProbe, resolveStepKey } from "./OnboardingWizard";

/** Pure-function test (the LLMTab.models.test.ts precedent — this repo has no
 * DOM test infrastructure). The step list is the feature: on a hosted install
 * the platform already answers brain/hearing/speaking, and ASKING is not the
 * only cost — answering writes intent that pins the account off its own plan. */
describe("stepsFor", () => {
  test("self-hosted keeps every screen (configuring an LLM is mandatory there)", () => {
    expect(stepsFor(false)).toEqual(STEPS);
    expect(stepsFor(false).map(([k]) => k)).toContain("brain");
  });

  test("hosted drops exactly brain, hearing and speaking — nothing else", () => {
    const keys = stepsFor(true).map(([k]) => k);
    expect(keys).toEqual(["welcome", "perms", "connect", "interview", "tour", "allset"]);
    for (const hidden of HOSTED_PROVISIONED) expect(keys).not.toContain(hidden);
  });

  test("the steps that survive keep their original relative order", () => {
    const all = STEPS.map(([k]) => k);
    const kept = stepsFor(true).map(([k]) => k);
    expect(kept).toEqual(all.filter((k) => kept.includes(k)));
  });

  // Guards the resume path: startKey returns a KEY ("interview"/"tour"/
  // "allset"), and every one of those must exist in BOTH lists or a resuming
  // hosted user lands on a dead index.
  test("every resume target exists on both installs", () => {
    for (const target of ["welcome", "interview", "tour", "allset"] as const) {
      expect(stepsFor(true).map(([k]) => k)).toContain(target);
      expect(stepsFor(false).map(([k]) => k)).toContain(target);
    }
  });
});

/** The tri-state hosted probe (review pr7#4 / pr3#10): while UNRESOLVED, the
 * provisioned screens gate — a pending or failed probe must never read as
 * self-hosted and collect credentials the server guard will discard. */
describe("stepGatedOnProbe", () => {
  test("unknown probe gates exactly the provisioned screens", () => {
    for (const k of HOSTED_PROVISIONED) expect(stepGatedOnProbe("unknown", k)).toBe(true);
    for (const k of ["welcome", "perms", "connect", "interview", "tour", "allset"] as const) {
      expect(stepGatedOnProbe("unknown", k)).toBe(false);
    }
  });

  test("a resolved probe gates nothing (either verdict)", () => {
    for (const [k] of STEPS) {
      expect(stepGatedOnProbe("hosted", k)).toBe(false);
      expect(stepGatedOnProbe("self", k)).toBe(false);
    }
  });
});

describe("resolveStepKey", () => {
  test("a key present in the list renders as itself", () => {
    expect(resolveStepKey(stepsFor(true), "connect")).toBe("connect");
    expect(resolveStepKey(stepsFor(false), "brain")).toBe("brain");
  });

  test("a hidden key resolves to Permissions, never the terminal screen", () => {
    // Probe resolves to hosted while the user stands on Hearing: the key
    // vanishes from the list. steps.length-1 here would mount "All set".
    expect(resolveStepKey(stepsFor(true), "hear")).toBe("perms");
    expect(resolveStepKey(stepsFor(true), "brain")).toBe("perms");
    expect(resolveStepKey(stepsFor(true), "speak")).toBe("perms");
  });
});
