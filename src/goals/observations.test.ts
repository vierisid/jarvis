/**
 * Q-17: a measured goal moves because of evidence. A counted measure's value
 * is the number of distinct things whose latest cited entry counts them, so
 * six signed partners trace to six entries, never to six runs, six accepted
 * tasks or a typed six. Duplicates, several goals, parents and children,
 * reopened goals and negative corrections are covered here; the routes in
 * `daemon/api-brief-goal-measurements.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { ensureWorkflowSchema } from '../workflows/db';
import * as vault from '../vault/goals';
import { getGoalApplication } from './application-service';
import { GoalMeasurementConflict, validateMeasurementCommand } from './measurements';
import { listObservations, readObservationReceipt, subjectKey, type ObservationCommand } from './observations';
import { GoalValidationError } from './validation';
import { buildGoalReviewBundle } from './review-evidence';
import { checkWorkResult, createWorkItem, decideWorkItem } from './work-items';
import { projectMeasuredGoal } from '../brief/goal-measurements';
import type { GoalEvent } from './events';

let directory: string, database: string, id: string, events: GoalEvent[], requests = 0;
const app = () => getGoalApplication();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-q17-')); database = join(directory, 'vault.db');
  initDatabase(database, { quiet: true });
  id = app().createGoal('Sign ten partners', 'objective', { status: 'active' }).id;
  events = []; app().setEventCallback(event => { events.push(event); });
});
afterEach(() => { app().stopDelivery(); closeDb(); rmSync(directory, { recursive: true, force: true }); });

const goal = (goalId = id) => vault.getGoal(goalId)!;
const count = (goalId = id) => goal(goalId).measurement?.value;
const entries = (goalId = id) => listObservations(getDb(), goalId);
function define(goalId = id, overrides: { target?: number; baseline?: number; unit?: string; revision?: number } = {}) {
  return app().defineCountedMeasurement(goalId, { requestId: `define-${++requests}`,
    revision: overrides.revision ?? goal(goalId).measurement?.revision ?? 0,
    definition: { unit: overrides.unit ?? 'signed partners', baseline: overrides.baseline ?? 0, target: overrides.target ?? 10 } });
}
function entry(subject: string, overrides: Partial<ObservationCommand['entry']> & { requestId?: string } = {}): ObservationCommand {
  const { requestId, ...rest } = overrides;
  return { requestId: requestId ?? `entry-${++requests}`, entry: { kind: 'counted', subject, observedAt: Date.now() - 60_000,
    source: { id: `crm:${subjectKey(subject)}`, revision: 'signed-v1' }, corrects: null, ...rest } };
}
const record = (command: ObservationCommand, goalId = id) => app().recordObservation(goalId, command);
const measuredScores = (goalId = id) => vault.getProgressHistory(goalId).filter(p => p.source === 'user_measurement').map(p => p.score_after).sort();
const PARTNERS = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries'];

test('six signed partners trace to six distinct cited entries; activity, accepted work and checked results never count', () => {
  ensureWorkflowSchema();
  define();
  app().recordActivity(id, 'A workflow run touched the partner pipeline', Date.now());
  const work = createWorkItem({ title: 'Send partner agreements', goalId: id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Owner accepted the recommendation' });
  checkWorkResult(work.id, { verdict: 'passed', summary: 'Agreements sent', evidence: [{ ref: 'outbox:v1', description: 'Sent mail' }] });
  expect(count()).toBe(0);
  expect(entries()).toEqual([]);

  const receipts = PARTNERS.map(name => record(entry(name)));
  expect(receipts.at(-1)).toMatchObject({ score: 0.6, measurement: { value: 6, basis: 'observations', qualification: 'user_reported',
    evidence: { id: `observations:${id}`, revision: `r${receipts.at(-1)!.measurement.revision}` } } });
  const view = projectMeasuredGoal(goal());
  expect(view).toMatchObject({ score: 0.6, progress: { value: 0.6, basis: 'measurement' },
    measurementDefinition: { unit: 'signed partners', baseline: 0, target: 10, basis: 'observations' },
    measurement: { value: 6, qualification: 'user_reported' } });
  // Each reference resolves to one entry: a distinct partner, its own source version, what it records.
  const byId = new Map(entries().map(e => [e.id, e]));
  expect(view.measurement!.provenance.map(ref => [ref.kind, byId.get(ref.id)?.subject, byId.get(ref.id)?.source.id, byId.get(ref.id)?.kind]))
    .toEqual(PARTNERS.map(name => ['observation', name, `crm:${subjectKey(name)}`, 'counted']));
  // The activity stays what it was: a note that moved nothing.
  expect(vault.getProgressHistory(id).filter(p => p.type === 'auto_detected').map(p => [p.score_before, p.score_after])).toEqual([[0, 0]]);
  expect(measuredScores()).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  // A build without Q-17 reads the snapshot as a typed total: every field it expects is there and valid.
  const { unit, baseline, target, value, measuredAt, evidence } = goal().measurement!;
  expect(() => validateMeasurementCommand({ requestId: 'older-build', revision: 0, measurement: { unit, baseline, target, value, measuredAt, evidence } })).not.toThrow();
});

test('a duplicate business event cannot count twice: the same partner, the same source version or the same request', () => {
  define();
  const acme = record(entry('Acme Corp'));
  expect(() => record(entry('  ACME   corp ', { source: { id: 'email:acme-signed', revision: 'm1' } }))).toThrow(GoalValidationError);
  expect(() => record(entry('ACME   corp', { source: { id: 'email:acme-signed', revision: 'm1' } }))).toThrow(/already counted/);
  expect(() => record(entry('Globex', { source: acme.entry.source }))).toThrow(/already cited/);
  expect(count()).toBe(1);
  // The same request again is the same entry: a replay, not a second count.
  const initech = entry('Initech', { requestId: 'initech-1' });
  const first = record(initech);
  expect(record(initech)).toEqual(first);
  expect(() => record({ ...initech, entry: { ...initech.entry, subject: 'Hooli' } })).toThrow(/different entry/);
  expect(count()).toBe(2);
  expect(entries()).toHaveLength(2);
});

test('an entry receipt survives a restart, and its replay afterwards changes nothing', () => {
  define();
  const command = entry('Acme', { requestId: 'acme-1' }), receipt = record(command);
  app().stopDelivery(); closeDb(); initDatabase(database, { quiet: true });
  expect(record(command)).toEqual(receipt);
  expect(readObservationReceipt(getDb(), id, 'acme-1')).toEqual(receipt);
  expect(count()).toBe(1);
});

test('a partner who backs out is taken back out by an entry linked to the one it corrects, and can be counted again', () => {
  define();
  const [acme] = ['Acme', 'Globex', 'Initech'].map(name => record(entry(name)));
  const out = record(entry('Acme', { kind: 'retracted', corrects: acme!.entry.id, source: { id: 'email:acme-withdrew', revision: 'm7' } }));
  expect(out).toMatchObject({ score: 0.2, measurement: { value: 2 }, entry: { kind: 'retracted', corrects: acme!.entry.id } });
  expect(goal().score).toBe(0.2);
  // Only the latest entry for a thing can be corrected, only a counted thing taken out, and a thing taken out is counted again by correcting that.
  expect(() => record(entry('Acme', { kind: 'retracted', corrects: acme!.entry.id, source: { id: 'email:again', revision: '1' } }))).toThrow(/latest entry/);
  expect(() => record(entry('Acme', { kind: 'retracted', corrects: out.entry.id, source: { id: 'email:again', revision: '2' } }))).toThrow(/Only a counted thing/);
  expect(() => record(entry('Acme', { source: { id: 'crm:acme', revision: 'signed-v2' } }))).toThrow(/taken back out/);
  const again = record(entry('Acme', { corrects: out.entry.id, source: { id: 'crm:acme', revision: 'signed-v2' } }));
  expect(again).toMatchObject({ score: 0.3, measurement: { value: 3 } });
  expect(entries().filter(e => e.subjectKey === 'acme').map(e => [e.kind, e.corrects]))
    .toEqual([['counted', null], ['retracted', acme!.entry.id], ['counted', out.entry.id]]);
  expect(measuredScores()).toEqual([0, 0.1, 0.2, 0.2, 0.3, 0.3]);
});

test('correcting a detail of a counted entry replaces its reference without moving the count or the progress history', () => {
  define();
  const acme = record(entry('Acme'));
  const progress = vault.getProgressHistory(id).length, scored = events.filter(e => e.type === 'goal_scored').length;
  const fixed = record(entry('Acme', { corrects: acme.entry.id, observedAt: acme.entry.observedAt - 86_400_000,
    source: { id: 'docusign:envelope-41', revision: 'completed' } }));
  expect(fixed).toMatchObject({ score: 0.1, progressId: null, measurement: { value: 1, revision: acme.measurement.revision + 1, counted: [fixed.entry.id] } });
  expect(vault.getProgressHistory(id)).toHaveLength(progress);
  expect(events.filter(e => e.type === 'goal_scored')).toHaveLength(scored);
  expect(events.at(-1)).toMatchObject({ type: 'goal_measurement_recorded',
    data: { basis: 'observations', entryId: fixed.entry.id, kind: 'counted', corrects: acme.entry.id, progressId: null } });
  expect(projectMeasuredGoal(goal()).measurement!.provenance).toEqual([{ kind: 'observation', id: fixed.entry.id, revision: null }]);
});

test('one partner can support several goals, counted once in each', () => {
  const eu = app().createGoal('Sign four partners in the EU', 'key_result', { status: 'active' }).id;
  define(); define(eu, { target: 4 });
  const acme = entry('Acme');
  record(acme);
  record({ ...acme, requestId: 'acme-eu' }, eu);
  expect([count(), count(eu)]).toEqual([1, 1]);
  expect(() => record(entry('Acme', { source: { id: 'email:acme', revision: '2' } }), eu)).toThrow(/already counted/);
  expect([goal().score, goal(eu).score]).toEqual([0.1, 0.25]);
});

test('a parent and its child count independently: a child entry, correction or deletion never changes the parent', () => {
  const child = app().createGoal('Sign two partners this month', 'key_result', { status: 'active', parent_id: id }).id;
  define(); define(child, { target: 2 });
  record(entry('Acme'), child); record(entry('Globex'), child);
  expect([count(), count(child)]).toEqual([0, 2]);
  // The parent counts a partner only on its own entry.
  record({ ...entry('Acme'), requestId: 'parent-acme' });
  const before = goal();
  const [childAcme] = entries(child);
  record(entry('Acme', { kind: 'retracted', corrects: childAcme!.id, source: { id: 'email:acme-out', revision: '1' } }), child);
  expect(count(child)).toBe(1);
  app().deleteGoal(child);
  expect(goal()).toMatchObject({ score: before.score, measurement: { value: 1, revision: before.measurement!.revision } });
  expect(entries(child)).toEqual([]);
});

test('a goal completed, corrected and reopened keeps one coherent count', () => {
  define(id, { target: 3 });
  const [, globex] = ['Acme', 'Globex', 'Initech'].map(name => record(entry(name)));
  app().updateStatus(id, 'completed');
  expect(goal()).toMatchObject({ status: 'completed', score: 1, measurement: { value: 3 } });
  record(entry('Globex', { kind: 'retracted', corrects: globex!.entry.id, source: { id: 'email:globex-out', revision: '1' } }));
  expect(goal()).toMatchObject({ status: 'completed', measurement: { value: 2 } });
  app().updateStatus(id, 'active');
  expect(goal()).toMatchObject({ status: 'active', measurement: { value: 2 } });
  record(entry('Umbrella'));
  expect(goal()).toMatchObject({ status: 'active', score: 1, measurement: { value: 3 } });
});

test('a counted goal takes no typed total, no score and no work-result score: its number comes from entries only', () => {
  ensureWorkflowSchema();
  define(); record(entry('Acme'));
  const typed = { requestId: 'typed', revision: goal().measurement!.revision, measurement: { unit: 'signed partners', baseline: 0, target: 10,
    value: 6, measuredAt: Date.now() - 1000, evidence: { id: 'owner:ledger', revision: 'v1' } } };
  expect(() => app().recordMeasurement(id, typed)).toThrow(/counted from its cited entries/);
  expect(() => app().scoreGoal(id, 0.9, 'Feels like nine')).toThrow(GoalValidationError);
  const work = createWorkItem({ title: 'Close Globex', goalId: id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Owner' });
  expect(() => checkWorkResult(work.id, { verdict: 'passed', summary: 'Closed', goalScore: 0.2,
    evidence: [{ ref: 'crm:globex', description: 'Deal won' }] })).toThrow(/new goal measurement/);
  expect(goal()).toMatchObject({ score: 0.1, measurement: { value: 1 } });
});

test('an automatic review stays inside the no-verified-mapping boundary on a counted goal', () => {
  ensureWorkflowSchema();
  define(); record(entry('Acme'));
  const work = createWorkItem({ title: 'Sign Globex', goalId: id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Owner' });
  checkWorkResult(work.id, { verdict: 'passed', summary: 'Globex signed', evidence: [{ ref: 'crm:globex', description: 'Signed' }] });
  const bundle = buildGoalReviewBundle([goal()], null);
  const outcome = bundle.goals[0]!.verifiedOutcomes[0]!;
  const review = app().recordEveningReview(bundle, { assessment: 'Good day', message: 'Keep going',
    score_updates: [{ goalId: id, newScore: 0.2, reason: 'Globex signed', evidenceIds: [outcome.id] }] });
  expect(review.scoreUpdates).toEqual([]);
  expect(review.reviewEvidence.rejectedScoreUpdates).toEqual([{ goalId: id, reason: 'no_verified_score_mapping' }]);
  expect(() => app().scoreGoal(id, 0.2, 'Review', 'daily_review')).toThrow(/verified measurement-to-score mapping/);
  expect(goal()).toMatchObject({ score: 0.1, measurement: { value: 1 } });
  expect(entries()).toHaveLength(1);
});

test('defining a counted measure replaces a typed total, keeps its entries when redefined, and keeps its unit once counted', () => {
  app().recordMeasurement(id, { requestId: 'typed', revision: 0, measurement: { unit: 'signed partners', baseline: 0, target: 10, value: 6,
    measuredAt: Date.now() - 1000, evidence: { id: 'owner:ledger', revision: 'v1' } } });
  expect(goal().score).toBe(0.6);
  // A typed six becomes a count of cited entries: zero until each partner is cited.
  const command = { requestId: 'count', revision: 1, definition: { unit: 'signed partners', baseline: 0, target: 10 } };
  const defined = app().defineCountedMeasurement(id, command);
  expect(defined).toMatchObject({ score: 0, measurement: { value: 0, basis: 'observations', counted: [], revision: 2 } });
  expect(app().defineCountedMeasurement(id, command)).toEqual(defined);
  expect(projectMeasuredGoal(goal())).toMatchObject({ measurement: { value: 0, provenance: [] }, measurementDefinition: { basis: 'observations' } });
  record(entry('Acme')); record(entry('Globex'));
  expect(define(id, { target: 4 })).toMatchObject({ score: 0.5, measurement: { value: 2, target: 4 } });
  expect(() => define(id, { unit: 'customers' })).toThrow(/keeps its unit/);
  expect(() => define(id, { revision: 1 })).toThrow(GoalMeasurementConflict);
  // A count of distinct things grows from a whole-number baseline to a larger whole-number target.
  for (const bounds of [{ baseline: 3, target: 3 }, { baseline: 0, target: 2.5 }, { baseline: -1, target: 4 }, { baseline: 0, target: 1001 }])
    expect(() => app().defineCountedMeasurement(id, { requestId: 'bad', revision: goal().measurement!.revision,
      definition: { unit: 'signed partners', ...bounds } })).toThrow(GoalValidationError);
  // An entry needs a counted measure to count toward.
  const plain = app().createGoal('Hire two engineers', 'key_result').id;
  expect(() => record(entry('Ada'), plain)).toThrow(/Define a counted measure/);
});

test('an entry names one thing, when it happened and a cited source version; anything more or less is refused', () => {
  define();
  const valid = entry('Acme');
  for (const bad of [
    { ...valid.entry, kind: 'measured' },
    { ...valid.entry, subject: ' Acme' },
    { ...valid.entry, observedAt: Date.now() + 60_000 },
    { ...valid.entry, source: { id: 'crm:acme' } },
    { ...valid.entry, kind: 'retracted', corrects: null },
    { ...valid.entry, qualification: 'measured' },
    { ...valid.entry, value: 6 },
  ]) expect(() => record({ requestId: 'bad', entry: bad } as never)).toThrow(GoalValidationError);
  expect(entries()).toEqual([]);
  expect(count()).toBe(0);
});

test('a counted measure holds at most 1,000 things; corrections and retractions still work at the cap', () => {
  define(id, { target: 1000 });
  let last!: ReturnType<typeof record>;
  for (let i = 0; i < 1000; i++) last = record(entry(`Partner ${i}`));
  expect(goal()).toMatchObject({ score: 1, measurement: { value: 1000 } });
  expect(() => record(entry('Partner 1000'))).toThrow(/at most 1000 things/);
  const out = record(entry('Partner 999', { kind: 'retracted', corrects: last.entry.id, source: { id: 'email:p999-out', revision: '1' } }));
  expect(out.measurement.value).toBe(999);
  expect(record(entry('Partner 1000')).measurement.value).toBe(1000);
});
