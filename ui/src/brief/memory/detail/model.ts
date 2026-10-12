import type { Fact } from "../../../../../src/vault/facts";
import type { MemoryItem } from "../stream/model";

export interface MemoryDetail {
  item: MemoryItem;
  fact: Fact;
}
export type ReadFailure = {
  state:
    | "unavailable"
    | "unsupported"
    | "conflict"
    | "error"
    | "missing"
    | "forgotten";
  reason: string;
};
export type DetailRead = { state: "ready"; data: MemoryDetail } | ReadFailure;
export type HistoryRead = { state: "ready"; items: MemoryItem[] } | ReadFailure;
export interface ForgetScope {
  removed: string[];
  retained: string[];
  suppression: string;
  legacySuppression: string;
  profile: string;
  confirmation: "local_confirmation_required";
}
export interface ForgetReceipt {
  factId: string;
  requestId: string;
  revision: string;
  forgottenAt: number;
  suppressedSources: number;
  scope: ForgetScope;
}
export type ForgetRead =
  | { state: "ready"; factId: string; revision: string; scope: ForgetScope }
  | { state: "forgotten"; receipt: ForgetReceipt }
  | Exclude<ReadFailure, { state: "forgotten" }>;
export interface ForgetCommand {
  requestId: string;
  expectedRevision: string;
  confirmed: true;
}
export interface DecisionCommand {
  kind: "correct" | "confirm";
  factId: string;
  revision: string;
  object: string;
  reason: string;
}
export type DecisionResult =
  | { state: "saved"; factId: string }
  | ReadFailure
  | { state: "unknown"; reason: string };
export type ForgetResult =
  | { state: "forgotten"; receipt: ForgetReceipt }
  | ReadFailure
  | { state: "unknown"; reason: string };
/** Host-scoped structural seam. Neither a new writer nor an implicit fixture fallback. */
export interface MemoryDetailPort {
  source: "live" | "fixture";
  scopeId: string;
  read(factId: string, signal: AbortSignal): Promise<DetailRead>;
  history(factId: string, signal: AbortSignal): Promise<HistoryRead>;
  decide(
    command: DecisionCommand,
    signal: AbortSignal,
  ): Promise<DecisionResult>;
  prepareForget(factId: string, signal: AbortSignal): Promise<ForgetRead>;
  forget(
    factId: string,
    command: ForgetCommand,
    signal: AbortSignal,
  ): Promise<ForgetResult>;
}
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const time = (value: unknown) =>
  Number.isSafeInteger(value) && Math.abs(value as number) <= 8.64e15;
const nullableTime = (value: unknown) => value === null || time(value);
export const validFactId = (value: unknown): value is string =>
  text(value) && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export function validItem(value: unknown): value is MemoryItem {
  if (!record(value)) return false;
  return (
    validFactId(value.factId) &&
    text(value.revision) &&
    !!value.revision &&
    text(value.sentence) &&
    validFactId(value.subjectId) &&
    text(value.scope) &&
    time(value.updatedAt) &&
    ["active", "contested", "superseded"].includes(value.status) &&
    ["confirmed", "reported", "observed", "inferred", "unspecified"].includes(
      value.basis,
    ) &&
    (value.supersededBy === null || validFactId(value.supersededBy)) &&
    record(value.permissions) &&
    value.permissions.canRead === true &&
    typeof value.permissions.canCorrect === "boolean" &&
    typeof value.permissions.canForget === "boolean" &&
    record(value.validity) &&
    nullableTime(value.validity.from) &&
    nullableTime(value.validity.to) &&
    record(value.sourceSummary) &&
    Array.isArray(value.sourceSummary.labels) &&
    value.sourceSummary.labels.every(text) &&
    Number.isSafeInteger(value.sourceSummary.evidenceCount) &&
    value.sourceSummary.evidenceCount >= 0 &&
    Array.isArray(value.provenance) &&
    value.provenance.every(
      (e: unknown) =>
        record(e) &&
        text(e.id) &&
        text(e.kind) &&
        (e.revision === null || text(e.revision)),
    ) &&
    (value.uses === null ||
      (Array.isArray(value.uses) &&
        value.uses.every(
          (use: unknown) =>
            record(use) &&
            use.factId === value.factId &&
            text(use.useId) &&
            text(use.sourceRevision) &&
            time(use.at) &&
            ["selected", "supplied", "outcome_verified"].includes(use.stage) &&
            (use.runId === null || text(use.runId)) &&
            (use.turn === null ||
              (record(use.turn) &&
                text(use.turn.conversationId) &&
                text(use.turn.turnId))),
        )))
  );
}
export function validDetail(value: unknown, id: string): value is MemoryDetail {
  if (
    !record(value) ||
    !validItem(value.item) ||
    value.item.factId !== id ||
    !record(value.fact)
  )
    return false;
  const f = value.fact,
    item = value.item;
  return (
    f.id === id &&
    f.subject_id === item.subjectId &&
    f.scope === item.scope &&
    f.status === item.status &&
    f.basis === item.basis &&
    f.valid_from === item.validity.from &&
    f.valid_to === item.validity.to &&
    f.superseded_by === item.supersededBy &&
    text(f.object) &&
    text(f.predicate) &&
    time(f.created_at) &&
    nullableTime(f.verified_at) &&
    Array.isArray(f.evidence) &&
    f.evidence.every(
      (e: unknown) =>
        record(e) &&
        text(e.id) &&
        e.fact_id === id &&
        text(e.basis) &&
        (e.source === null || text(e.source)) &&
        (e.source_ref === null || text(e.source_ref)) &&
        (e.quote === null || text(e.quote)) &&
        time(e.recorded_at),
    )
  );
}
export function validScope(value: unknown): value is ForgetScope {
  return (
    record(value) &&
    value.confirmation === "local_confirmation_required" &&
    Array.isArray(value.removed) &&
    value.removed.length === 3 &&
    ["chosen_canonical_fact", "its_evidence", "future_canonical_recall"].every(
      (key) => value.removed.includes(key),
    ) &&
    Array.isArray(value.retained) &&
    value.retained.length === 7 &&
    [
      "content_free_receipt_and_usage",
      "other_facts_and_history",
      "entity_identity_and_relationships",
      "original_messages_and_source_documents",
      "profile_settings_and_interview_sources",
      "backups_and_database_free_pages",
      "already_sent_model_context",
    ].every((key) => value.retained.includes(key)) &&
    value.suppression ===
      "same_normalized_assertion_and_automatic_source_revision" &&
    value.legacySuppression ===
      "unknown_revision_blocks_same_automatic_assertion_until_explicit_manual_input" &&
    value.profile ===
      "matching_source_field_is_withheld_from_future_profile_prompts_until_changed"
  );
}
export function validReceipt(
  value: unknown,
  id: string,
): value is ForgetReceipt {
  return (
    record(value) &&
    value.factId === id &&
    validFactId(value.requestId) &&
    text(value.revision) &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    time(value.forgottenAt) &&
    Number.isSafeInteger(value.suppressedSources) &&
    value.suppressedSources >= 0 &&
    validScope(value.scope)
  );
}
export const FAILURE = {
  state: "error",
  reason: "The memory response could not be verified. Reload the current fact.",
} as const;
export const CONFLICT = {
  state: "conflict",
  reason:
    "This fact changed. Reload its current value before making a decision.",
} as const;
