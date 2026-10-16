import type { Database } from 'bun:sqlite';
import { plainLabel, type GoalMeasurement, type GoalMeasurementReceipt } from './measurements';
import { enumeration, invalid, keys, number, record } from './validation';

/**
 * Q-17: a counted goal measure is backed by one cited entry per counted thing.
 * Its value is the number of distinct things whose latest entry counts them;
 * nobody types the number. An entry names who or what was counted, when it
 * happened and the source version it came from. A correction is its own entry,
 * linked to the entry it corrects, so every count keeps a readable lineage.
 *
 * Entries are recorded by a person, or confirmed by one: they are user
 * reported, never provider-verified. No activity, accepted work, workflow run
 * or automatic review creates one, which is what keeps those distinguishable
 * from a counted measure. Supported first: counts of distinct things (signed
 * partners, customers, deals, hires). Amounts stay on the typed snapshot.
 */

/** The largest target, and the most things a counted measure holds at once: the read lists one reference per counted thing. */
export const MAX_COUNTED = 1000;
/** Entries one goal keeps, corrections included. */
export const MAX_ENTRIES_PER_GOAL = 20_000;

export interface CountedDefinitionCommand {
  requestId: string;
  /** The goal's current measurement revision; zero when it has none. */
  revision: number;
  definition: { unit: string; baseline: number; target: number };
}
export interface ObservationEntryInput {
  /** `counted` adds the thing; `retracted` takes it back out (a partner who backed out). */
  kind: 'counted' | 'retracted';
  /** Who or what was counted, as the person names it. */
  subject: string;
  /** When it happened, not when it was recorded. */
  observedAt: number;
  /** The cited source version: a reference, never fetched or verified. */
  source: { id: string; revision: string };
  /** The latest entry for the same thing, when there is one; null for a thing not seen before. */
  corrects: string | null;
}
export interface ObservationCommand {
  requestId: string;
  entry: ObservationEntryInput;
}
export interface ObservationEntry extends ObservationEntryInput {
  id: string;
  goalId: string;
  /** The subject compared without case, width or spacing differences. */
  subjectKey: string;
  recordedAt: number;
  qualification: 'user_reported';
}
export interface ObservationReceipt extends GoalMeasurementReceipt {
  entry: ObservationEntry;
}

export function validateCountedDefinition(raw: unknown): CountedDefinitionCommand {
  const input = record(raw, 'request'); keys(input, ['requestId', 'revision', 'definition'], 'request');
  const requestId = plainLabel(input.requestId, 'requestId', 128);
  const revision = number(input.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1, true);
  const d = record(input.definition, 'definition'); keys(d, ['unit', 'baseline', 'target'], 'definition');
  const unit = plainLabel(d.unit, 'definition.unit', 80);
  const baseline = number(d.baseline, 'definition.baseline', 0, MAX_COUNTED - 1, true);
  const target = number(d.target, 'definition.target', 1, MAX_COUNTED, true);
  if (target <= baseline) invalid('definition.target', 'must be above the baseline: a count of distinct things grows');
  return { requestId, revision, definition: { unit, baseline, target } };
}

export function validateObservationCommand(raw: unknown): ObservationCommand {
  const input = record(raw, 'request'); keys(input, ['requestId', 'entry'], 'request');
  const requestId = plainLabel(input.requestId, 'requestId', 128);
  const e = record(input.entry, 'entry'); keys(e, ['kind', 'subject', 'observedAt', 'source', 'corrects'], 'entry');
  const kind = enumeration(e.kind, ['counted', 'retracted'] as const, 'entry.kind');
  const subject = plainLabel(e.subject, 'entry.subject', 200);
  if (!subjectKey(subject)) invalid('entry.subject', 'must name something visible');
  const observedAt = number(e.observedAt, 'entry.observedAt', 0, Date.now(), true);
  const s = record(e.source, 'entry.source'); keys(s, ['id', 'revision'], 'entry.source');
  const source = { id: plainLabel(s.id, 'entry.source.id', 512), revision: plainLabel(s.revision, 'entry.source.revision', 128) };
  const corrects = e.corrects === null ? null : plainLabel(e.corrects, 'entry.corrects', 64);
  if (kind === 'retracted' && corrects === null) invalid('entry.corrects', 'a retraction names the entry it takes back');
  return { requestId, entry: { kind, subject, observedAt, source, corrects } };
}

/** The evidence a counted snapshot names: its goal's entry ledger at that revision. */
export function ledgerEvidence(goalId: string, revision: number): { id: string; revision: string } {
  return { id: `observations:${goalId}`, revision: `r${revision}` };
}

/**
 * Who or what was counted, compared without case, width, spacing or invisible
 * formatting differences: `ＡＣＭＥ`, `Acme` followed by a zero-width space and
 * `acme` are one partner, and `Straße` is `STRASSE`. Computed when an entry is
 * written and stored with it.
 */
export function subjectKey(subject: string): string {
  return subject.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().toUpperCase().toLowerCase();
}

/** An entry no later entry corrects: the latest word on its thing. */
const LATEST = 'NOT EXISTS (SELECT 1 FROM goal_observation later WHERE later.corrects = goal_observation.id)';

/** A snapshot as receipts keep it: without the list of counted entries, which only the current snapshot holds. */
export function receiptMeasurement(measurement: GoalMeasurement): GoalMeasurement {
  const { counted: _counted, ...rest } = measurement;
  return rest;
}

/** Whether the goal has any entry at all, a retraction included: its count is then known, even at zero. */
export function hasObservations(db: Database, goalId: string): boolean {
  return !!db.query<{ one: number }, [string]>('SELECT 1 AS one FROM goal_observation WHERE goal_id = ? LIMIT 1').get(goalId);
}
/** The thing whose current count a source version backs on this goal, or null when it backs none. */
export function sourceBacks(db: Database, goalId: string, sourceKey: string): { id: string; subject: string; subjectKey: string } | null {
  const row = db.query<{ entry: string }, [string, string]>(
    `SELECT entry FROM goal_observation WHERE goal_id = ? AND source_key = ? AND kind = 'counted' AND ${LATEST}`,
  ).get(goalId, sourceKey);
  if (!row) return null;
  const entry = JSON.parse(row.entry) as ObservationEntry;
  return { id: entry.id, subject: entry.subject, subjectKey: entry.subjectKey };
}

/** Every entry of a goal, oldest first, corrections included. */
export function listObservations(db: Database, goalId: string): ObservationEntry[] {
  return db.query<{ entry: string }, [string]>('SELECT entry FROM goal_observation WHERE goal_id = ? ORDER BY seq')
    .all(goalId).map(row => JSON.parse(row.entry));
}
/** The latest entry for one counted thing, or null when the goal has none for it. */
export function latestObservation(db: Database, goalId: string, key: string): ObservationEntry | null {
  const row = db.query<{ entry: string }, [string, string]>(`SELECT entry FROM goal_observation WHERE goal_id = ? AND subject_key = ? AND ${LATEST}`)
    .get(goalId, key);
  return row ? JSON.parse(row.entry) : null;
}
/** The entries that count right now, one per thing, oldest first. */
export function countedObservationIds(db: Database, goalId: string): string[] {
  return db.query<{ id: string }, [string]>(`SELECT id FROM goal_observation WHERE goal_id = ? AND kind = 'counted' AND ${LATEST} ORDER BY seq`)
    .all(goalId).map(row => row.id);
}
export function readObservationReceipt(db: Database, goalId: string, requestId: string): ObservationReceipt | null {
  plainLabel(requestId, 'requestId', 128);
  const row = db.query<{ receipt: string }, [string, string]>('SELECT receipt FROM goal_observation WHERE goal_id = ? AND request_id = ?')
    .get(goalId, requestId);
  return row ? JSON.parse(row.receipt) : null;
}
