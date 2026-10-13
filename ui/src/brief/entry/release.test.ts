import { expect, test } from "bun:test";
import { assessBriefRelease, BRIEF_RELEASE, RELEASE_GATES } from "./release";
import { releaseExample } from "./release.test-support";

test("the shipped release has no activation or fabricated evidence", () => {
  expect(assessBriefRelease(BRIEF_RELEASE, undefined)).toEqual({ rollout: "off", blockers: [
    "release_disabled", "candidate_missing", "D-32_evidence_required", "F-28_evidence_required",
    "Q-22_evidence_required", "deployment_approval_required", "runtime_unverified",
  ] });
});
test("unknown and malformed manifest versions fail closed without throwing", () => {
  const { config, runtime } = releaseExample();
  for (const value of [null, [], {}, { ...config, schemaVersion: 2 }, { ...config, rollout: "preview" }]) {
    expect(assessBriefRelease(value, runtime).rollout).toBe("off");
  }
});
for (const gate of RELEASE_GATES) {
  test(`${gate} must be passed live evidence for this integrated candidate`, () => {
    const { config, runtime } = releaseExample();
    const original = config.gates[gate]!;
    for (const value of [undefined, { ...original, status: "blocked" }, { ...original, status: "not_run" },
      { ...original, source: "fixture" }, { ...original, candidate: "b".repeat(40) }, { ...original, artifact: " " }]) {
      const result = assessBriefRelease({ ...config, gates: { ...config.gates, [gate]: value } }, runtime);
      expect(result.rollout).toBe("off"); expect(result.blockers).toContain(`${gate}_evidence_required`);
    }
  });
}
test("missing and stale approval is not inferred from passed tests", () => {
  const { config, runtime } = releaseExample();
  for (const approval of [null, {}, { candidate: "b".repeat(40), artifact: "approval.txt" }, { candidate: config.candidate, artifact: "" }]) {
    expect(assessBriefRelease({ ...config, approval }, runtime).blockers).toContain("deployment_approval_required");
  }
});
test("invalid candidate, unknown runtime, fixture runtime and stale build cannot activate", () => {
  const { config, runtime } = releaseExample();
  expect(assessBriefRelease({ ...config, candidate: "short" }, { ...runtime, candidate: "short" }).rollout).toBe("off");
  for (const value of [null, {}, { ...runtime, source: "fixture" }, { ...runtime, candidate: "b".repeat(40) },
    { ...runtime, hosting: undefined }, { ...runtime, brain: "" }, { ...runtime, flags: ["x", "x"] }]) {
    expect(assessBriefRelease(config, value).blockers).toContain("runtime_unverified");
  }
});
test("brain, hosting, sidecar, schema and enabled flags match an exact tested combination", () => {
  const { config, runtime } = releaseExample();
  expect(assessBriefRelease(config, { ...runtime, flags: [...runtime.flags].reverse() }).rollout).toBe("cohort");
  for (const change of [{ brain: "older" }, { hosting: "hosted-v1" }, { sidecar: null }, { schema: "other" },
    { flags: ["conversations"] }, { flags: [...runtime.flags, "unreviewed"] }]) {
    expect(assessBriefRelease(config, { ...runtime, ...change }).blockers).toContain("deployment_combination_unverified");
  }
});
test("migration and rollback evidence are mandatory for every supported combination", () => {
  const { config, runtime } = releaseExample();
  for (const key of ["migration", "rollback"]) {
    for (const value of [null, { candidate: config.candidate, source: "fixture", status: "passed", artifact: "fixture.json" },
      { candidate: config.candidate, source: "live", status: "not_run", artifact: "report.json" }]) {
      expect(assessBriefRelease({ ...config, combinations: [{ ...config.combinations[0], [key]: value }] }, runtime).rollout).toBe("off");
    }
  }
  expect(assessBriefRelease({ ...config, combinations: [] }, runtime).rollout).toBe("off");
});
test("supported hosted/local and browser/sidecar tuples require their own proof", () => {
  const { config, runtime } = releaseExample();
  const hosted = { ...runtime, hosting: "test-hosting", sidecar: null };
  config.combinations = [...config.combinations, { ...config.combinations[0]!, ...hosted }];
  expect(assessBriefRelease(config, runtime)).toEqual({ rollout: "cohort", blockers: [] });
  expect(assessBriefRelease(config, hosted)).toEqual({ rollout: "cohort", blockers: [] });
  expect(assessBriefRelease({ ...config, rollout: "released" }, hosted).rollout).toBe("released");
  expect(assessBriefRelease({ ...config, rollout: "off" }, hosted).rollout).toBe("off");
});
