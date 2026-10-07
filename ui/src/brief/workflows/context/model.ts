import type { BriefReadState } from "../../contracts";
import type { RunScope } from "../runs/model";

// Presentation contract only. F-21 must authorize, scope and redact the projection.
// Never infer recorded usage by joining today's configured sources to an old run.
export const GROUPS = [
  "goal",
  "memory",
  "bindings",
  "target",
  "rules",
] as const;
export type ContextGroup = (typeof GROUPS)[number];
export const SOURCE_KINDS = [
  "goal",
  "fact",
  "connection",
  "device",
  "rule",
  "step",
  "workflow",
] as const;
export interface ContextSource {
  kind: (typeof SOURCE_KINDS)[number];
  id: string;
}
export interface ContextEntry {
  id: string;
  label: string;
  value: string;
  availability: "available" | "missing" | "removed" | "stale" | "redacted";
  source: ContextSource | null;
}
export type ContextQuery =
  | { basis: "configured" }
  | { basis: "recorded"; runId: string; versionId?: string };
export interface ContextDocument {
  scopeId: string;
  flowId: string;
  versionId: string;
  basis: "configured" | "recorded";
  runId: string | null;
  runLabel: string | null;
  asOf: number | null;
  groups: Record<ContextGroup, BriefReadState<ContextEntry[]>>;
}
export interface WorkflowContextPort {
  read(
    scope: Readonly<RunScope>,
    query: ContextQuery,
    signal: AbortSignal,
  ): Promise<BriefReadState<ContextDocument>>;
}
const text = (v: unknown, max = 12000): v is string =>
  typeof v === "string" && v.length <= max;
const id = (v: unknown): v is string => text(v, 500) && !!v.trim();
const failure = () => {
  throw Error("Invalid workflow context projection");
};
export const queryKey = (q: ContextQuery) =>
  JSON.stringify(
    q.basis === "configured"
      ? [q.basis]
      : [q.basis, q.runId, q.versionId ?? null],
  );
export function validateContext(
  d: ContextDocument,
  scope: RunScope,
  query: ContextQuery,
): ContextDocument {
  if (
    !d ||
    d.scopeId !== scope.scopeId ||
    d.flowId !== scope.flowId ||
    !id(d.versionId) ||
    d.basis !== query.basis ||
    (query.basis === "configured"
      ? d.versionId !== scope.versionId ||
        d.runId !== null ||
        d.runLabel !== null
      : !id(query.runId) ||
        d.runId !== query.runId ||
        !id(d.runLabel) ||
        (!!query.versionId && d.versionId !== query.versionId)) ||
    !(
      d.asOf === null ||
      (Number.isSafeInteger(d.asOf) && Math.abs(d.asOf) <= 8.64e15)
    ) ||
    !d.groups
  )
    failure();
  const groups = {} as ContextDocument["groups"];
  for (const group of GROUPS) {
    const state = d.groups[group];
    if (!state) failure();
    if (state.status === "ready" || state.status === "stale") {
      if (!Array.isArray(state.data) || state.data.length > 200) failure();
      const seen = new Set<string>();
      const data = state.data.map((e) => {
        if (
          !e ||
          !id(e.id) ||
          seen.has(e.id) ||
          !id(e.label) ||
          !text(e.value) ||
          !["available", "missing", "removed", "stale", "redacted"].includes(
            e.availability,
          ) ||
          !(
            e.source === null ||
            (e.source &&
              SOURCE_KINDS.includes(e.source.kind) &&
              id(e.source.id))
          )
        )
          failure();
        seen.add(e.id);
        // Whitelist fields; marked-redacted content never reaches the DOM/cache.
        return {
          id: e.id,
          label: e.availability === "redacted" ? "Restricted source" : e.label,
          value: e.availability === "redacted" ? "Redacted" : e.value,
          availability: e.availability,
          source:
            e.availability === "redacted" || !e.source
              ? null
              : { kind: e.source.kind, id: e.source.id },
        };
      });
      groups[group] =
        state.status === "stale"
          ? { status: "stale", data, reason: "Context may be out of date." }
          : { status: "ready", data };
    } else if (state.status === "loading" || state.status === "empty")
      groups[group] = { status: state.status };
    else if (state.status === "unavailable" || state.status === "unsupported")
      groups[group] = {
        status: state.status,
        reason: "Context is unavailable.",
      };
    else failure();
  }
  return {
    scopeId: scope.scopeId,
    flowId: scope.flowId,
    versionId: d.versionId,
    basis: d.basis,
    runId: d.runId,
    runLabel: d.runLabel,
    asOf: d.asOf,
    groups,
  };
}
