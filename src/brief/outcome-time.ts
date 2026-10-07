import type { Database } from 'bun:sqlite';
import { keys, number, record, text, invalid } from '../goals/validation';
import type { BriefEvidenceRef, BriefMeasurement } from './contracts';

export class OutcomeConflict extends Error {}
export interface OutcomeTimeRecord {
  workItemId: string; resultCheckId: string; revision: number; recordedAt: number;
  baseline: { minutes: number; evidence: { id: string; revision: string } };
  intervention: { intervals: { start: number; end: number }[]; evidence: { id: string; revision: string } };
}
export const outcomeId = (value: unknown, path: string) => {
  const s = text(value, path, true, 512);
  if (s !== s.trim() || /[\x00-\x1f\x7f]/.test(s)) invalid(path, 'must be trimmed plain text');
  return s;
};
const evidence = (raw: unknown, path: string) => {
  const e = record(raw, path); keys(e, ['id', 'revision'], path);
  return { id: outcomeId(e.id, `${path}.id`), revision: outcomeId(e.revision, `${path}.revision`) };
};
export function timeCommand(raw: unknown) {
  const c = record(raw, 'request'); keys(c, ['requestId', 'revision', 'resultCheckId', 'baseline', 'intervention'], 'request');
  const b = record(c.baseline, 'baseline'); keys(b, ['minutes', 'evidence'], 'baseline');
  const i = record(c.intervention, 'intervention'); keys(i, ['intervals', 'evidence'], 'intervention');
  if (!Array.isArray(i.intervals) || i.intervals.length > 100) invalid('intervention.intervals', 'requires at most 100 observed intervals');
  const intervals = i.intervals.map((raw, index) => {
    const t = record(raw, `intervals[${index}]`); keys(t, ['start', 'end'], 'interval');
    const start = number(t.start, 'interval.start', 0, Number.MAX_SAFE_INTEGER, true);
    const end = number(t.end, 'interval.end', start, Number.MAX_SAFE_INTEGER, true);
    if (end - start > 7 * 86_400_000) invalid('interval', 'cannot exceed seven days');
    return { start, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  return { requestId: outcomeId(c.requestId, 'requestId'), revision: number(c.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1, true),
    resultCheckId: outcomeId(c.resultCheckId, 'resultCheckId'),
    baseline: { minutes: number(b.minutes, 'baseline.minutes', 0, 10_080), evidence: evidence(b.evidence, 'baseline.evidence') },
    intervention: { intervals, evidence: evidence(i.evidence, 'intervention.evidence') } };
}
export function readOutcomeTime(db: Database, workId: string): OutcomeTimeRecord | null {
  const row = db.query<{ snapshot: string }, [string]>(
    'SELECT snapshot FROM outcome_time_record WHERE work_id=? ORDER BY revision DESC LIMIT 1').get(workId);
  return row ? JSON.parse(row.snapshot) : null;
}
export function timeBack(t: OutcomeTimeRecord): BriefMeasurement {
  let elapsed = 0, lastEnd = -1;
  for (const interval of t.intervention.intervals) {
    elapsed += Math.max(0, interval.end - Math.max(interval.start, lastEnd)); lastEnd = Math.max(lastEnd, interval.end);
  }
  const provenance: BriefEvidenceRef[] = [
    { kind: 'source', id: t.baseline.evidence.id, revision: t.baseline.evidence.revision },
    { kind: 'source', id: t.intervention.evidence.id, revision: t.intervention.evidence.revision },
  ];
  return { value: t.baseline.minutes - elapsed / 60_000, unit: 'minutes', baseline: t.baseline.minutes, target: null,
    asOf: t.recordedAt, provenance, qualification: 'user_reported' };
}
