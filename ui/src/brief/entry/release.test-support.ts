import type { BriefReleaseConfig, BriefReleaseRuntime, ReleaseEvidence } from "./release";
/** Synthetic policy inputs for tests only; never an activation receipt. */
export function releaseExample() {
  const candidate = "a".repeat(40);
  const proof = (): ReleaseEvidence => ({ candidate, source: "live", status: "passed", artifact: "test-only/evidence.json" });
  const runtime: BriefReleaseRuntime = {
    source: "live", candidate, brain: "test-brain", hosting: null, sidecar: "test-sidecar",
    schema: "test-additive-schema", flags: ["navigationCompatibility", "conversations"],
  };
  const config: BriefReleaseConfig = {
    schemaVersion: 1, rollout: "cohort", candidate,
    gates: { "D-32": proof(), "F-28": proof(), "Q-22": proof() },
    combinations: [{ ...runtime, migration: proof(), rollback: proof() }],
    approval: { candidate, artifact: "test-only/approval.txt" },
  };
  return { config, runtime };
}
