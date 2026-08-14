import { describe, expect, test } from "bun:test";
import { HOSTED_PROVISIONED, STEPS, stepsFor } from "./OnboardingWizard";

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
