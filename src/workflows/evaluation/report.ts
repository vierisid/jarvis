import { fingerprint } from '../../actions/tools/composition-provenance';
import { summarize } from './runner';
import { measure, type ScheduledItem } from './measures';
import type { EvaluationRow, QualityTask } from './types';

/** What a run scheduled, so unrun work stays in each group's denominator. */
export interface ReportContext {
  tasks: QualityTask[]; scheduled: ScheduledItem[];
  run: { kind: EvaluationRow['kind']; split: QualityTask['split']; profileId: string | null };
}
const groupKey = (kind: string, split: string, policy: string, condition: string, profileId: string | null | undefined) =>
  [kind, split, policy, condition].join('/') + (profileId ? '@' + profileId : '');

export function report(rows: EvaluationRow[], context?: ReportContext) {
  const groups = new Map<string, { rows: EvaluationRow[]; notRun: ScheduledItem[] }>();
  const group = (key: string) => groups.get(key) ?? (groups.set(key, { rows: [], notRun: [] }), groups.get(key)!);
  for (const row of rows) group(groupKey(row.kind, row.split, row.policy, row.condition, row.profile?.id)).rows.push(row);
  if (context) {
    const done = new Set(rows.map(r => [r.taskId, r.policy, r.repeat, r.condition].join('\0')));
    for (const item of context.scheduled) {
      if (done.has([item.taskId, item.policy, item.repeat, item.condition].join('\0'))) continue;
      group(groupKey(context.run.kind, context.run.split, item.policy, item.condition, context.run.profileId)).notRun.push(item);
    }
  }
  return Object.fromEntries([...groups].map(([key, g]) => [key, context
    ? { ...summarize(g.rows), measures: measure(g.rows, context.tasks, g.notRun) } : summarize(g.rows)]));
}
export interface HumanReview {
  rowId: string; rowSha256: string; reviewer: string; intentCorrect: boolean;
  elapsedMs: number; edits: number; notes: string;
  /** Would the founder use this? Judged apart from intent; null or absent means not judged. */
  useful?: boolean | null;
  /** For AI steps: does the output stay faithful to its sources? Null or absent means not judged. */
  fidelity?: boolean | null;
}
/** Reviews live beside immutable raw results and are tied to their exact hash. */
export function applyReviews(rows: EvaluationRow[], reviews: unknown): EvaluationRow[] {
  if (!Array.isArray(reviews)) throw new Error('Reviews must be an array');
  const byId = new Map(rows.map(r => [r.id, r]));
  const seen = new Set<string>();
  const copy = structuredClone(rows);
  for (const value of reviews) {
    const v = value as HumanReview;
    const original = byId.get(v?.rowId);
    if (!original || seen.has(v.rowId) || v.rowSha256 !== fingerprint(original))
      throw new Error('Review has unknown, duplicated or changed result');
    if (typeof v.reviewer !== 'string' || !v.reviewer.trim() || typeof v.intentCorrect !== 'boolean'
      || !Number.isSafeInteger(v.elapsedMs) || v.elapsedMs < 0 || !Number.isSafeInteger(v.edits) || v.edits < 0
      || typeof v.notes !== 'string' || ![undefined, null, true, false].includes(v.useful as any)
      || ![undefined, null, true, false].includes(v.fidelity as any)) throw new Error('Invalid human review');
    seen.add(v.rowId);
    const row = copy.find(r => r.id === v.rowId)!;
    row.humanIntentCorrect = v.intentCorrect;
    row.supervision = { reviewer: v.reviewer, elapsedMs: v.elapsedMs, edits: v.edits, notes: v.notes,
      ...(typeof v.useful === 'boolean' ? { useful: v.useful } : {}), ...(typeof v.fidelity === 'boolean' ? { fidelity: v.fidelity } : {}) };
  }
  return copy;
}
