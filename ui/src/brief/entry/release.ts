import { BRIEF_ROOM_IDS, type BriefRoomRegistry } from "../contracts";
import { canMountNavigation, type BriefNavigationBinding } from "../shell/navigation/model";
import type { BriefConversationBinding } from "../shell/pebble-layout/PebbleLayout";

export const RELEASE_GATES = ["D-32", "F-28", "Q-22"] as const;
export type BriefRollout = "off" | "cohort" | "released";
export interface ReleaseEvidence {
  candidate: string;
  status: "passed" | "blocked" | "not_run";
  source: "live" | "fixture";
  /** Reviewed, sanitized evidence reference; never a credential or account ID. */
  artifact: string;
}
export interface BriefDeployment {
  brain: string;
  hosting: string | null;
  sidecar: string | null;
  schema: string;
  flags: readonly string[];
}
export interface BriefReleaseConfig {
  schemaVersion: 1;
  rollout: BriefRollout;
  /** Full revision of the integrated candidate, not a component PR's head. */
  candidate: string;
  gates: Partial<Record<typeof RELEASE_GATES[number], ReleaseEvidence>>;
  combinations: readonly (BriefDeployment & {
    migration: ReleaseEvidence;
    rollback: ReleaseEvidence;
  })[];
  approval: { candidate: string; artifact: string } | null;
}
/** Supplied by the composition owner from the current authenticated runtime.
 * D33 does not infer versions, register F providers, or enable feature flags. */
export interface BriefReleaseRuntime extends BriefDeployment {
  source: "live";
  candidate: string;
}

/** No release is authorized in this stack. Fill this only after integration,
 * D32/F28/Q22 evidence review and team deployment approval. */
export const BRIEF_RELEASE: BriefReleaseConfig = {
  schemaVersion: 1, rollout: "off", candidate: "", gates: {}, combinations: [], approval: null,
};

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function evidence(value: unknown, candidate: string): boolean {
  return record(value) && value.candidate === candidate && value.status === "passed"
    && value.source === "live" && text(value.artifact);
}
function deployment(value: unknown): value is BriefDeployment {
  return record(value) && text(value.brain) && (value.hosting === null || text(value.hosting))
    && (value.sidecar === null || text(value.sidecar)) && text(value.schema)
    && Array.isArray(value.flags) && value.flags.every(text) && new Set(value.flags).size === value.flags.length;
}
function sameDeployment(a: BriefDeployment, b: BriefDeployment): boolean {
  return a.brain === b.brain && a.hosting === b.hosting && a.sidecar === b.sidecar && a.schema === b.schema
    && a.flags.length === b.flags.length && a.flags.every(flag => b.flags.includes(flag));
}

/** Checks reviewed release records, not the truth of their attestations.
 * Missing, old, fixture, unknown-version and unsupported combinations fail closed. */
export function assessBriefRelease(config: unknown, runtime: unknown): { rollout: BriefRollout; blockers: string[] } {
  if (!record(config) || config.schemaVersion !== 1 || !["off", "cohort", "released"].includes(config.rollout)) {
    return { rollout: "off", blockers: ["invalid_release_config"] };
  }
  const blockers: string[] = [];
  if (config.rollout === "off") blockers.push("release_disabled");
  if (!sha(config.candidate)) blockers.push("candidate_missing");
  for (const gate of RELEASE_GATES) {
    if (!record(config.gates) || !evidence(config.gates[gate], config.candidate)) blockers.push(`${gate}_evidence_required`);
  }
  if (!record(config.approval) || config.approval.candidate !== config.candidate || !text(config.approval.artifact)) {
    blockers.push("deployment_approval_required");
  }
  if (!record(runtime) || runtime.source !== "live" || runtime.candidate !== config.candidate || !deployment(runtime)) {
    blockers.push("runtime_unverified");
  } else if (!Array.isArray(config.combinations) || !config.combinations.some((row: unknown) =>
    record(row) && evidence(row.migration, config.candidate) && evidence(row.rollback, config.candidate)
    && deployment(row) && sameDeployment(row, runtime))) {
    blockers.push("deployment_combination_unverified");
  }
  return { rollout: blockers.length ? "off" : config.rollout, blockers };
}

/** A global switch must not expose links to missing bodies or fixture owners.
 * Per-feature readiness/writers remain with F28 and each room's adapter. */
export function hasReleaseComposition(rooms: BriefRoomRegistry, navigation?: BriefNavigationBinding, conversation?: BriefConversationBinding): boolean {
  return BRIEF_ROOM_IDS.every(id => rooms[id]?.id === id && typeof rooms[id]?.Body === "function")
    && canMountNavigation("live", navigation) && navigation?.view.state.status === "ready"
    && conversation?.source === "live" && conversation.content != null;
}
