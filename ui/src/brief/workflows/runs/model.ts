import type { BriefReadState } from "../../contracts";

// Presentation-only projection. F-21 owns authentication, safe redaction and the
// durable command. Never bind raw run.steps/effect arguments to these fields.
export const RUN_STATES = [
  "queued",
  "running",
  "paused",
  "failed",
  "cancelled",
  "uncertain",
  "succeeded",
] as const;
export type RunStatus = (typeof RUN_STATES)[number];
export interface RunIdentity {
  scopeId: string;
  flowId: string;
  runId: string;
  versionId: string;
}
export interface RunSummary extends RunIdentity {
  label: string;
  status: RunStatus;
  startedAt: number | null;
  createdAt: number;
}
export interface RunPage {
  items: RunSummary[];
  nextCursor: string | null;
  total: number | null;
}
export interface RunStep {
  id: string;
  title: string;
  description: string;
  status: RunStatus | "not_run";
  // Already redacted, human-readable inspection fields, never arbitrary HTML.
  fields: Array<{ label: string; value: string; redacted?: boolean }>;
}
export interface RunDetail extends RunSummary {
  summary: string;
  trigger: string | null;
  finishedAt: number | null;
  steps: RunStep[];
  effects: Array<{
    id: string;
    label: string;
    status:
      | "pending"
      | "dispatching"
      | "succeeded"
      | "failed"
      | "blocked"
      | "unknown";
    description: string;
  }>;
  waits: Array<{
    id: string;
    stepName: string;
    label: string;
    status: "waiting" | "resolved";
  }>;
  context: Array<{
    kind: "Goal" | "Memory" | "Rule" | "Connection" | "Device";
    id: string;
    label: string;
    availability: "available" | "removed" | "redacted";
  }>;
  inspection: { status: "complete" | "partial"; note: string | null };
}
export interface RunScope {
  scopeId: string;
  flowId: string;
  versionId: string;
}
export interface ManualRunRequest extends RunScope {
  requestId: string;
}
export type ManualRunResult =
  | { status: "accepted"; requestId: string; run: RunSummary }
  | { status: "not_submitted"; requestId: string }
  | { status: "uncertain"; requestId: string };
export interface WorkflowRunsPort {
  list(
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<BriefReadState<RunPage>>;
  detail(
    runId: string,
    signal: AbortSignal,
  ): Promise<BriefReadState<RunDetail>>;
  /** Collect/validate explicit bounded input and persist request identity before
   * dispatch. Resolve not_submitted ONLY when no command was sent. No retries. */
  start?: (request: ManualRunRequest) => Promise<ManualRunResult>;
}
export const STATUS: Record<
  RunStatus | "not_run",
  { label: string; tone: string }
> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  paused: { label: "Paused", tone: "attention" },
  failed: { label: "Failed", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  uncertain: { label: "Uncertain", tone: "attention" },
  succeeded: { label: "Succeeded", tone: "success" },
  not_run: { label: "Not run", tone: "neutral" },
};
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const time = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v));
export function validSummary(v: RunSummary, scope: RunScope): boolean {
  return (
    !!v &&
    v.scopeId === scope.scopeId &&
    v.flowId === scope.flowId &&
    string(v.runId) &&
    string(v.versionId) &&
    string(v.label) &&
    RUN_STATES.includes(v.status) &&
    time(v.startedAt) &&
    typeof v.createdAt === "number" &&
    Number.isFinite(v.createdAt)
  );
}
export function validatePage(page: RunPage, scope: RunScope): RunPage {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 200 ||
    page.items.some((r) => !validSummary(r, scope)) ||
    new Set(page.items.map((r) => r.runId)).size !== page.items.length ||
    !(page.nextCursor === null || string(page.nextCursor)) ||
    !(
      page.total === null ||
      (Number.isSafeInteger(page.total) && page.total >= page.items.length)
    )
  )
    throw Error("Invalid run history");
  return page;
}
export function validateDetail(
  d: RunDetail,
  scope: RunScope,
  id: string,
  version?: string,
): RunDetail {
  const unique = (rows: Array<{ id: string }>) =>
    rows.every((r) => string(r.id)) &&
    new Set(rows.map((r) => r.id)).size === rows.length;
  if (
    !validSummary(d, scope) ||
    d.runId !== id ||
    (version && d.versionId !== version) ||
    typeof d.summary !== "string" ||
    !(d.trigger === null || typeof d.trigger === "string") ||
    !time(d.finishedAt) ||
    !Array.isArray(d.steps) ||
    !unique(d.steps) ||
    d.steps.some(
      (s) =>
        !string(s.title) ||
        typeof s.description !== "string" ||
        !Object.hasOwn(STATUS, s.status) ||
        !Array.isArray(s.fields) ||
        s.fields.some(
          (f) =>
            !string(f.label) ||
            typeof f.value !== "string" ||
            (f.redacted !== undefined && typeof f.redacted !== "boolean"),
        ),
    ) ||
    !Array.isArray(d.effects) ||
    !unique(d.effects) ||
    d.effects.some(
      (e) =>
        !string(e.label) ||
        typeof e.description !== "string" ||
        ![
          "pending",
          "dispatching",
          "succeeded",
          "failed",
          "blocked",
          "unknown",
        ].includes(e.status),
    ) ||
    !Array.isArray(d.waits) ||
    !unique(d.waits) ||
    d.waits.some(
      (w) =>
        !string(w.stepName) ||
        !string(w.label) ||
        !["waiting", "resolved"].includes(w.status),
    ) ||
    !Array.isArray(d.context) ||
    d.context.some(
      (c) =>
        !string(c.id) ||
        !string(c.label) ||
        !["Goal", "Memory", "Rule", "Connection", "Device"].includes(c.kind) ||
        !["available", "removed", "redacted"].includes(c.availability),
    ) ||
    !d.inspection ||
    !["complete", "partial"].includes(d.inspection.status) ||
    !(d.inspection.note === null || typeof d.inspection.note === "string")
  )
    throw Error("Invalid run inspection");
  return d;
}
