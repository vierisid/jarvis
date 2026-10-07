import type { Database } from 'bun:sqlite';
import { invalid, keys, number, record, text } from './validation';

export interface GoalMeasurementInput {
  unit: string;
  baseline: number;
  target: number;
  /** Null is an unobserved count, not zero. */
  value: number | null;
  measuredAt: number | null;
  /** A user's cited source/version, not a provider verification claim. */
  evidence: { id: string; revision: string } | null;
}
export interface GoalMeasurement extends GoalMeasurementInput {
  revision: number;
  qualification: 'user_reported' | null;
}
export interface GoalMeasurementCommand {
  requestId: string;
  revision: number;
  measurement: GoalMeasurementInput;
}
export interface GoalMeasurementReceipt {
  goalId: string;
  requestId: string;
  measurement: GoalMeasurement;
  score: number;
  progressId: string | null;
}
export class GoalMeasurementConflict extends Error {}
const label = (value: unknown, path: string, max: number) => {
  const result = text(value, path, true, max);
  if (result !== result.trim() || /[\x00-\x1f\x7f]/.test(result)) invalid(path, 'must be trimmed plain text');
  return result;
};
export function validateMeasurementCommand(raw: unknown): GoalMeasurementCommand {
  const input = record(raw, 'request'); keys(input, ['requestId', 'revision', 'measurement'], 'request');
  const requestId = label(input.requestId, 'requestId', 128);
  const revision = number(input.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1, true);
  const m = record(input.measurement, 'measurement');
  keys(m, ['unit', 'baseline', 'target', 'value', 'measuredAt', 'evidence'], 'measurement');
  const unit = label(m.unit, 'measurement.unit', 80);
  const baseline = number(m.baseline, 'measurement.baseline', -1e12, 1e12);
  const target = number(m.target, 'measurement.target', -1e12, 1e12);
  if (baseline === target) invalid('measurement.target', 'must differ from baseline');
  let value: number | null = null, measuredAt: number | null = null, evidence: GoalMeasurementInput['evidence'] = null;
  if (m.value === null) {
    if (m.measuredAt !== null || m.evidence !== null) invalid('measurement', 'an unknown value has no measurement time or evidence');
  } else {
    value = number(m.value, 'measurement.value', -1e12, 1e12);
    measuredAt = number(m.measuredAt, 'measurement.measuredAt', 0, Date.now(), true);
    const e = record(m.evidence, 'measurement.evidence'); keys(e, ['id', 'revision'], 'measurement.evidence');
    evidence = { id: label(e.id, 'measurement.evidence.id', 512), revision: label(e.revision, 'measurement.evidence.revision', 128) };
  }
  return { requestId, revision, measurement: { unit, baseline, target, value, measuredAt, evidence } };
}
/** Absolute progress, including decreasing targets and downward corrections. Never a delta. */
export function measurementProgress(measurement: GoalMeasurementInput): number | null {
  if (measurement.value === null) return null;
  return Math.max(0, Math.min(1, (measurement.value - measurement.baseline) / (measurement.target - measurement.baseline)));
}
export function readGoalMeasurement(db: Database, goalId: string): GoalMeasurement | null {
  const row = db.query<{ snapshot: string }, [string]>('SELECT snapshot FROM goal_measurement WHERE goal_id = ?').get(goalId);
  return row ? JSON.parse(row.snapshot) : null;
}
export function readMeasurementReceipt(db: Database, goalId: string, requestId: string): GoalMeasurementReceipt | null {
  label(requestId, 'requestId', 128);
  const row = db.query<{ receipt: string }, [string, string]>('SELECT receipt FROM goal_measurement_receipt WHERE goal_id = ? AND request_id = ?').get(goalId, requestId);
  return row ? JSON.parse(row.receipt) : null;
}
