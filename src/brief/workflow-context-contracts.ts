/** F-21 read contract shared with the staged D-19/D-20 presentation ports.
 * Values are plain text; consumers must render them as text, never HTML. */
export type InspectionState<T> = { status: 'ready'; data: T } | { status: 'empty' }
  | { status: 'unavailable'; reason: string };
export type InspectionRunStatus = 'queued' | 'running' | 'paused' | 'failed' | 'cancelled' | 'uncertain' | 'succeeded';
export interface InspectionRunSummary {
  scopeId: string; flowId: string; versionId: string; runId: string;
  label: string; status: InspectionRunStatus; createdAt: number; startedAt: number | null;
}
export interface InspectionField { label: string; value: string; redacted?: boolean; redaction?: 'partial' | 'full' }
export interface InspectionStep {
  id: string; title: string; description: string; status: InspectionRunStatus | 'not_run'; fields: InspectionField[];
}
export type ContextGroup = 'goal' | 'memory' | 'bindings' | 'target' | 'rules';
export interface InspectionContextEntry {
  id: string; label: string; value: string;
  availability: 'available' | 'missing' | 'removed' | 'stale' | 'redacted';
  source: { kind: 'goal' | 'fact' | 'connection' | 'device' | 'rule' | 'step' | 'workflow'; id: string } | null;
}
export interface InspectionContext {
  scopeId: string; flowId: string; versionId: string; basis: 'configured' | 'recorded';
  runId: string | null; runLabel: string | null; asOf: number | null;
  groups: Record<ContextGroup, InspectionState<InspectionContextEntry[]>>;
}
export interface InspectionRunDetail extends InspectionRunSummary {
  summary: string; trigger: string | null; finishedAt: number | null; steps: InspectionStep[];
  effects: Array<{ id: string; label: string; status: 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown'; description: string; fields: InspectionField[] }>;
  waits: Array<{ id: string; stepName: string; label: string; status: 'waiting' | 'resolved' }>;
  context: Array<{ kind: 'Goal' | 'Memory' | 'Rule' | 'Connection' | 'Device'; id: string; label: string; availability: 'available' | 'removed' | 'redacted' }>;
  inspection: { status: 'complete' | 'partial'; note: string | null };
}
export interface InspectionSelection {
  scopeId: string; flowId: string; versionId: string; runId: string | null;
  canvas: InspectionState<{ nodes: Array<{ id: string; type: string; title: string; fields: InspectionField[]; edges: string[] }> }>;
  context: InspectionContext;
  run: InspectionRunDetail | null;
}
export interface ManualInspectionRunRequest { requestId: string; scopeId: string; versionId: string }
export interface ManualInspectionRunResult { status: 'accepted'; requestId: string; run: InspectionRunSummary }
