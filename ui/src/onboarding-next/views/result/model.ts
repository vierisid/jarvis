/** Local structural projection of draft-result.v1. Optional providers stay optional. */
export interface Issue { node: string; path: string; code: string; message: string }
export interface DraftReference {
  jobId: string; requestId: string; compositionRecordId: string; flowId: string; versionId: string;
  readiness: 'ready' | 'needs_input'; activation: 'disabled';
}
export interface Continuation {
  operation: 'journey.transition';
  input: { journeyId: string; expectedRevision: number; requestId: string; command: { type: 'finish' } };
}
export interface SavedResult {
  availability: 'ready'; state: 'saved'; schemaVersion: 1;
  scopeId: string; journeyId: string; jobId: string; requestId: string;
  compositionRecordId: string; flowId: string; versionId: string; contentRevision: string;
  title: string; graph: Record<string, unknown>; selectedNodeId: string | null;
  activation: 'disabled'; versionState: 'DRAFT'; reference: DraftReference;
  readiness: { ready: boolean; issues: Issue[]; runtimeChecks: (Issue & { guard: string })[] };
  missingBindings: Issue[];
  recovery: { operation: 'result.read'; input: { schemaVersion: 1; jobId: string;
    expected: { compositionRecordId: string; flowId: string; versionId: string } } };
  workflow: { room: 'workflow'; selection: { flowId: string; versionId: string } };
  journey: { sync: 'settled' | 'pending' | 'unavailable'; completion: string | null };
  continuation: Continuation | null;
}
export interface ResultModel {
  /** Host-authenticated presentation scope. Not an authorization credential. */
  scopeId: string; journeyId: string; jobId: string; requestId: string;
  /** Monotonic read/command acknowledgement, not a layout/theme counter. */
  revision: number; theme: 'light' | 'dark'; result: unknown;
  /** Optional exact reference retained by the host across route changes/reloads. */
  expected?: Pick<DraftReference, 'compositionRecordId' | 'flowId' | 'versionId'>;
}
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const issue = (v: unknown): v is Issue => object(v) && ['node', 'path', 'code', 'message'].every(k => typeof v[k] === 'string');
export function nodeIds(graph: unknown): Set<string> | null {
  const ids = new Set<string>(), stack = [graph];
  while (stack.length) {
    const n = stack.pop();
    if (!object(n) || !text(n.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n.name)
      || ['connections', '__proto__', 'prototype', 'constructor'].includes(n.name)
      || typeof n.type !== 'string' || ids.has(n.name) || ids.size >= 100) return null;
    ids.add(n.name);
    for (const key of ['nextAction', 'firstLoopAction']) if (n[key] != null) stack.push(n[key]);
    if (n.children != null) { if (!Array.isArray(n.children) || n.children.length > 100) return null; stack.push(...n.children.filter(x => x != null)); }
  }
  return ids;
}
/** Presentation defense; authorization and fresh-version checks still belong to B10. */
export function savedResult(model: ResultModel): SavedResult | null {
  const r = model.result;
  if (!object(r) || r.availability !== 'ready' || r.state !== 'saved' || r.schemaVersion !== 1
    || !Number.isSafeInteger(model.revision) || model.revision < 0
    || !['scopeId', 'journeyId', 'jobId', 'requestId'].every(k => text(r[k]) && r[k] === model[k as keyof ResultModel])
    || !['compositionRecordId', 'flowId', 'versionId', 'contentRevision', 'title'].every(k => text(r[k]))
    || r.activation !== 'disabled' || r.versionState !== 'DRAFT') return null;
  if (model.expected && !['compositionRecordId', 'flowId', 'versionId'].every(k => r[k] === model.expected![k as keyof typeof model.expected])) return null;
  const ids = nodeIds(r.graph);
  if (!ids || (r.selectedNodeId !== null && !ids.has(r.selectedNodeId))) return null;
  if (!object(r.reference) || !['jobId', 'requestId', 'compositionRecordId', 'flowId', 'versionId', 'activation'].every(k => r.reference[k] === r[k])) return null;
  if (!object(r.readiness) || typeof r.readiness.ready !== 'boolean' || !Array.isArray(r.readiness.issues)
    || !r.readiness.issues.every(issue) || !Array.isArray(r.readiness.runtimeChecks)
    || !r.readiness.runtimeChecks.every((i: unknown) => issue(i) && text((i as { guard?: unknown }).guard))
    || !Array.isArray(r.missingBindings) || !r.missingBindings.every(issue)
    || r.reference.readiness !== (r.readiness.ready ? 'ready' : 'needs_input')) return null;
  if (r.workflow?.room !== 'workflow' || r.workflow.selection?.flowId !== r.flowId || r.workflow.selection?.versionId !== r.versionId
    || r.recovery?.operation !== 'result.read' || r.recovery.input?.schemaVersion !== 1 || r.recovery.input.jobId !== r.jobId
    || !['compositionRecordId', 'flowId', 'versionId'].every(k => r.recovery.input.expected?.[k] === r[k])) return null;
  if (!object(r.journey) || !['settled', 'pending', 'unavailable'].includes(r.journey.sync)) return null;
  if (r.continuation !== null) {
    const c = r.continuation;
    if (c?.operation !== 'journey.transition' || c.input?.journeyId !== r.journeyId || c.input.command?.type !== 'finish'
      || !text(c.input.requestId) || !Number.isSafeInteger(c.input.expectedRevision) || c.input.expectedRevision < 0
      || r.journey.sync !== 'settled' || r.journey.completion !== 'active') return null;
  }
  return r as SavedResult;
}
export function artifactKey(r: SavedResult) { return JSON.stringify([r.scopeId, r.journeyId, r.jobId, r.requestId, r.compositionRecordId, r.flowId, r.versionId]); }
export function unavailableMessage(result: unknown) {
  if (object(result) && result.availability === 'ready' && result.state === 'pending') return 'Your draft is still being verified. Check again to recover this result.';
  if (object(result) && result.availability === 'ready' && result.state === 'no_draft') return 'This build has no saved draft. Return to your request to review the next step.';
  return 'This saved draft is unavailable or has changed. Check again to recover the exact workflow from this build.';
}
