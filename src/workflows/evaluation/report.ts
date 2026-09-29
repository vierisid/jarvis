import { fingerprint } from '../../actions/tools/composition-provenance';
import { summarize } from './runner';
import type { EvaluationRow } from './types';

export function report(rows: EvaluationRow[]) {
  const groups = new Map<string, EvaluationRow[]>();
  for (const row of rows) {
    const key = [row.kind, row.split, row.policy, row.condition].join('/');
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  return Object.fromEntries([...groups].map(([key, values]) => [key, summarize(values)]));
}
export interface HumanReview {
  rowId: string; rowSha256: string; reviewer: string; intentCorrect: boolean;
  elapsedMs: number; edits: number; notes: string;
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
      || typeof v.notes !== 'string') throw new Error('Invalid human review');
    seen.add(v.rowId);
    const row = copy.find(r => r.id === v.rowId)!;
    row.humanIntentCorrect = v.intentCorrect;
    row.supervision = { reviewer: v.reviewer, elapsedMs: v.elapsedMs, edits: v.edits, notes: v.notes };
  }
  return copy;
}
