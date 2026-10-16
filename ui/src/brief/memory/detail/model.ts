import type { Fact } from "../../../../../src/vault/facts";
import type { MemoryItem } from "../stream/model";

export interface MemoryDetail {
  item: MemoryItem;
  fact: Fact;
}
export type ReadFailure = {
  state: "unavailable" | "unsupported" | "conflict" | "error" | "missing";
  reason: string;
};
export type DetailRead = { state: "ready"; data: MemoryDetail } | ReadFailure;
export type HistoryRead = { state: "ready"; items: MemoryItem[] } | ReadFailure;
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
/** Host-scoped structural seam. Neither a new writer nor an implicit fixture fallback.
 * Review and correct only: Forget is not offered until F-19 / Q-16 land on main. */
export interface MemoryDetailPort {
  source: "live" | "fixture";
  scopeId: string;
  read(factId: string, signal: AbortSignal): Promise<DetailRead>;
  history(factId: string, signal: AbortSignal): Promise<HistoryRead>;
  decide(
    command: DecisionCommand,
    signal: AbortSignal,
  ): Promise<DecisionResult>;
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
export const FAILURE = {
  state: "error",
  reason: "The memory response could not be verified. Reload the current fact.",
} as const;
export const CONFLICT = {
  state: "conflict",
  reason:
    "This fact changed. Reload its current value before making a decision.",
} as const;
