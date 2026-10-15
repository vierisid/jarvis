import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { createCapture, createSuggestion, markSuggestionActedOn, markSuggestionDismissed } from '../vault/awareness.ts';
import { createGoal, getGoal, getProgressHistory } from '../vault/goals.ts';
import { acceptSuggestion } from './suggestion-feedback.ts';
import { assessJobHypotheses, classifyJobSignals } from './job-hypotheses.ts';
import { assessOpportunities, getOpportunityMetrics, opportunitySuggestion, publishOpportunity, recordOpportunityFeedback, refreshOpportunity } from './opportunities.ts';
import { readOpportunityFeedbackEvidence } from './opportunity-feedback-evidence.ts';
import { applyOpportunityFeedbackPolicy, DISMISS_COOLDOWN_MS, FEEDBACK_POLICY } from './opportunity-feedback-policy.ts';
import { feedbackCaptures, feedbackHypothesis, proposalFeedbackReport } from './evaluation/proposal-feedback-evaluation.ts';
import { EVALUATION_NOW } from './evaluation/routine-evaluation.ts';
import { parseRoutineEvidence } from './routine-signals.ts';
import type { JobKind } from './opportunity-types.ts';
import type { ReportCadence } from './routine-identity.ts';

const DAY = 86_400_000;
let now: number;
beforeEach(() => { now = EVALUATION_NOW; spyOn(Date, 'now').mockImplementation(() => now); initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); mock.restore(); });
function seed(kind: JobKind = 'recurring_report', cadence: ReportCadence = 'weekly') {
  for (const c of feedbackCaptures(kind, cadence, now)) createCapture({ timestamp: c.timestamp, pixelChangePct: 0.5,
    appName: c.app!, ocrText: c.ocrText!, windowTitle: c.windowTitle ?? undefined, sidecarId: c.sidecarId ?? undefined });
}
function propose() { seed(); return refreshOpportunity()!.id; }
function confirm(id: string) {
  recordOpportunityFeedback(id, { requestId: 'confirm', kind: 'validate', job: 'Check report figures', expectedOutcome: 'A checked report', goalId: null, goalReason: null });
}
function outcome(id: string, workRef: string, useful: boolean) {
  return recordOpportunityFeedback(id, { requestId: workRef, kind: 'outcome', workRef, useful, performedAt: now, note: useful ? 'Used the checked figures.' : 'Wrong figures; had to redo it.' });
}

test('labeled feedback cases keep abstention, missing outcomes and source-qualified value distinct', () => {
  const report = proposalFeedbackReport();
  expect(report.total).toBe(18);
  expect(report.cases.filter(c => !c.passed)).toEqual([]);
});

test('wording, app and forged pattern keys cannot republish a dismissed routine', () => {
  const id = propose();
  markSuggestionDismissed(id, 'Already handled by our existing report');
  const renamed = feedbackHypothesis('recurring_report', 'weekly', now);
  renamed.patternKey = 'new-wording-should-not-create-a-new-routine';
  renamed.job.title = 'A more exciting reporting idea';
  renamed.job.proposedOutcome = 'Renamed output';
  renamed.evidence.forEach(e => e.app = 'Different app');
  expect(publishOpportunity(renamed)).toBeNull();
  expect(getOpportunityMetrics().proposed).toBe(1);
  expect(assessOpportunities().feedbackPolicy!.suppressed[0]).toMatchObject({ reason: 'dismissed_routine', until: null });
});

test('dismissal survives disk restart while a supported changed cadence waits for the bounded cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q14-feedback-'));
  try {
    closeDb(); initDatabase(join(dir, 'fixture.db'), { quiet: true });
    const id = propose();
    recordOpportunityFeedback(id, { kind: 'dismiss', requestId: 'dismiss', reason: 'Weekly report is already covered' });
    seed('recurring_report', 'monthly');
    const until = now + DISMISS_COOLDOWN_MS;
    const blocked = assessOpportunities().feedbackPolicy!.suppressed.find(s => s.routineKey.endsWith(':monthly'))!;
    expect(blocked).toMatchObject({ reason: 'feedback_cooldown', until });
    closeDb(); initDatabase(join(dir, 'fixture.db'), { quiet: true });
    now = until - 1;
    expect(assessOpportunities().proposals).toEqual([]);
    expect(assessOpportunities().feedbackPolicy!.suppressed.find(s => s.routineKey.endsWith(':monthly'))!.until).toBe(until);
    now++;
    expect(assessOpportunities().proposals.map(p => p.patternKey)).toEqual(['job-v1:recurring_report:monthly']);
    expect(assessOpportunities().proposals[0]!.job.title).toBe('Prepare a monthly report');
    expect(refreshOpportunity()).not.toBeNull();
    expect(getOpportunityMetrics().quality.reappearanceErrors).toEqual([]);
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});

test('an old report without cadence keeps family-wide suppression and is not backfilled', () => {
  const h = feedbackHypothesis('recurring_report', 'weekly', now);
  delete h.routine!.cadence;
  h.patternKey = 'job-v1:recurring_report';
  const id = publishOpportunity(h)!.id;
  markSuggestionDismissed(id);
  now += 30 * DAY;
  seed('recurring_report', 'monthly');
  expect(refreshOpportunity()).toBeNull();
  const stored = getDb().query('SELECT hypothesis FROM opportunity_hypotheses WHERE suggestion_id = ?').get(id) as { hypothesis: string };
  expect(JSON.parse(stored.hypothesis).routine.cadence).toBeUndefined();
});

test('the first scoped report retains the family storage key understood by older writers', () => {
  const id = propose();
  const keys = getDb().query('SELECT pattern_key FROM opportunity_hypotheses').all() as Array<{ pattern_key: string }>;
  // Q-11 and older writers suppress reports with this exact family key.
  expect(new Set(keys.map(row => row.pattern_key)).has('job-v1:recurring_report')).toBe(true);
  markSuggestionDismissed(id);
  now += 7 * DAY; seed('recurring_report', 'monthly');
  expect(assessOpportunities().proposals[0]!.patternKey).toBe('job-v1:recurring_report:monthly');
  expect(refreshOpportunity()).not.toBeNull();
  expect(getDb().query('SELECT COUNT(*) AS n FROM opportunity_hypotheses').get()).toEqual({ n: 2 });
});

test('old automation aliases without owned hypotheses also preserve suppression', () => {
  const h = feedbackHypothesis('recurring_report', 'weekly', now);
  const suggestion = createSuggestion(opportunitySuggestion(h));
  markSuggestionDismissed(suggestion.id);
  seed();
  expect(assessOpportunities().abstention).toBe('already_proposed');
  expect(refreshOpportunity()).toBeNull();
});

test('publication rechecks a dismissal arriving after assessment, with no partial rows', () => {
  const id = propose();
  now += 2 * DAY;
  seed('recurring_report', 'monthly');
  const candidate = assessOpportunities().proposals[0]!;
  expect(candidate.patternKey).toBe('job-v1:recurring_report:monthly');
  markSuggestionDismissed(id, 'Please stop these reporting proposals');
  expect(publishOpportunity(candidate)).toBeNull();
  expect(getDb().query('SELECT COUNT(*) AS n FROM opportunity_delivery').get()).toEqual({ n: 1 });
});

test('proposal and transport receipt each bound related proposal frequency across restart', () => {
  const id = propose(); seed('recurring_report', 'monthly');
  expect(assessOpportunities().abstention).toBe('feedback_cooldown');
  now += DAY;
  expect(assessOpportunities().proposals).toHaveLength(1);
  getDb().query('UPDATE opportunity_delivery SET delivered_at = ?, channel = ? WHERE opportunity_id = ?').run(now, 'test-transport', id);
  expect(assessOpportunities().proposals).toHaveLength(0);
  expect(getOpportunityMetrics().quality.usefulResultRate.rate).toBeNull();
});

test('click and acceptance alone leave usefulness, measured savings and goal progress unknown', () => {
  const id = propose();
  const g = createGoal('Deliver a weekly sales report', 'objective', { status: 'active' });
  const before = getGoal(g.id);
  markSuggestionActedOn(id);
  expect(getOpportunityMetrics().quality).toMatchObject({ accepted: 0, interested: 1, reportedUses: 0, measuredTimeSaved: null, verifiedResults: 0 });
  acceptSuggestion(id, { requestId: 'accept', reason: 'Try a draft', name: 'Report', description: 'Check report figures', expectedOutcome: 'Checked report', goalId: g.id, goalReason: 'Supports reporting' });
  expect(getOpportunityMetrics().quality).toMatchObject({ accepted: 1, acceptedWithoutOutcomeFeedback: 1,
    usefulResultRate: { numerator: 0, denominator: 0, rate: null }, measuredTimeSaved: null, verifiedResults: 0 });
  now += 2 * DAY; seed('recurring_report', 'monthly');
  expect(assessOpportunities().proposals[0]!.feedbackLearning).toMatchObject({ priority: 0, accepted: 1, reportedUses: 0 });
  expect(getGoal(g.id)).toEqual(before);
  expect(getProgressHistory(g.id)).toEqual([]);
});

test('two distinct useful user reports adjust related priority but cannot override goal evidence', () => {
  const id = propose(); confirm(id);
  outcome(id, 'report/1', true); outcome(id, 'report/2', true);
  now += 2 * DAY; seed('recurring_report', 'monthly'); seed('invoice_review');
  const beforeGoal = assessOpportunities();
  expect(beforeGoal.proposals[0]!.kind).toBe('recurring_report');
  expect(beforeGoal.proposals[0]!.feedbackLearning).toMatchObject({ priority: 1, reportedUses: 2, usefulReports: 2, basis: 'related_routine_user_reports' });
  expect(beforeGoal.proposals[0]!.feedbackLearning!.sourceRefs.every(ref => ref.startsWith('opportunity_feedback:'))).toBe(true);
  createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  expect(assessOpportunities().proposals[0]!.kind).toBe('invoice_review');
  expect(getOpportunityMetrics().quality).toMatchObject({ repeatedUsefulRoutines: 1, usefulResultRate: { numerator: 2, denominator: 2, rate: 1 }, verifiedResults: 0 });
});

test('feedback retries do not inflate useful-result rates; negative results cool related work', () => {
  const id = propose(); confirm(id);
  outcome(id, 'report/1', true); outcome(id, 'report/1', true); outcome(id, 'report/2', false);
  now += 2 * DAY; seed('recurring_report', 'monthly');
  expect(assessOpportunities().proposals).toEqual([]);
  expect(getOpportunityMetrics().quality).toMatchObject({ reportedUses: 2,
    usefulResultRate: { numerator: 1, denominator: 2, rate: 0.5 }, repeatedUsefulRoutines: 0 });
});

test('legacy flags and malformed outcome rows expose missing provenance instead of fabricated usefulness', () => {
  const id = propose();
  getDb().query('UPDATE awareness_suggestions SET dismissed = 1 WHERE id = ?').run(id);
  getDb().query('INSERT INTO opportunity_feedback VALUES (?, ?, ?, ?, ?, ?, ?)').run('bad', id, 'bad', 'outcome', '{"useful":true}', 'bad', now);
  expect(getOpportunityMetrics().quality).toMatchObject({ dismissalsWithoutTimestamp: 1, invalidOutcomeRecords: 1,
    reportedUses: 0, usefulResultRate: { rate: null }, proposalsWithoutOutcomeFeedback: 1 });
});

test('rejection reasons retain their source and imported reappearance errors are counted by semantic identity', () => {
  const id = propose(); markSuggestionDismissed(id, 'We already have this report');
  now++;
  // Simulate an older buggy writer that changed wording and pattern identity.
  const h = feedbackHypothesis('recurring_report', 'weekly', now);
  h.patternKey = 'old-writer-wording-alias';
  const alias = createSuggestion(opportunitySuggestion(h));
  const quality = getOpportunityMetrics().quality;
  expect(quality.rejectionReasons[0]).toMatchObject({ source: 'suggestion_feedback', reason: 'We already have this report', opportunityId: id });
  expect(quality.reappearanceErrors).toEqual([{ opportunityId: alias.id, routineKey: 'job-v1:recurring_report:weekly', sourceRef: `awareness_suggestions:${alias.id}` }]);
});

test('optional prepared decisions inform suppression and missing outcomes without activating preparation', () => {
  // Four-column read contract verified against F-09/F-10's prepared-schema.ts.
  getDb().run('CREATE TABLE prepared_opportunities (id TEXT PRIMARY KEY, opportunity_id TEXT, dismissed_at INTEGER, accepted_at INTEGER)');
  const id = propose();
  now += 2 * DAY; seed('recurring_report', 'monthly');
  expect(assessOpportunities().proposals).toHaveLength(1);
  getDb().query('INSERT INTO prepared_opportunities VALUES (?, ?, ?, ?)').run('prepared', id, now, null);
  expect(assessOpportunities().proposals).toEqual([]);
  expect(getOpportunityMetrics().quality.rejectionReasons[0]).toMatchObject({ source: 'prepared_opportunities', reason: null });
  getDb().query('UPDATE prepared_opportunities SET dismissed_at = NULL, accepted_at = ?').run(now);
  expect(getOpportunityMetrics().quality).toMatchObject({ accepted: 1, acceptedWithoutOutcomeFeedback: 1, usefulResultRate: { rate: null } });
  now += DAY;
  expect(assessOpportunities().proposals[0]!.feedbackLearning).toMatchObject({ priority: 0, accepted: 1, reportedUses: 0 });
  expect(getDb().query('SELECT COUNT(*) AS n FROM suggestion_composition_jobs').get()).toEqual({ n: 0 });
});

test('ambiguous or mixed cadence evidence cannot mint a new routine identity', () => {
  const captures = feedbackCaptures();
  const mixed = captures.map((c, i) => i % 3 === 1 ? { ...c, ocrText: c.ocrText!.replace(/weekly/gi, 'monthly') } : c);
  expect(assessJobHypotheses(mixed.flatMap(classifyJobSignals), [], new Set(), now).proposals).toEqual([]);
  expect(classifyJobSignals({ ...captures[0]!, ocrText: 'Weekly sales report and monthly sales report' })).toEqual([]);
  expect(parseRoutineEvidence({ policy: 'routine-cues-v2', stage: 'source', sidecarId: null, cadence: 'arbitrary customer data' })).toBeUndefined();
  seed();
  const rows = getDb().query('SELECT routine_evidence FROM opportunity_observations').all() as Array<{ routine_evidence: string }>;
  expect(rows.every(r => Object.keys(JSON.parse(r.routine_evidence)).sort().join(',') === 'cadence,policy,sidecarId,stage')).toBe(true);
});

test('ranking does not mutate source hypotheses or feedback records', () => {
  const id = propose(); confirm(id); outcome(id, 'report/1', true);
  now += 2 * DAY;
  const snapshot = readOpportunityFeedbackEvidence();
  const input = { schemaVersion: 1 as const, assessedAt: now, proposals: [feedbackHypothesis('recurring_report', 'monthly', now)], abstention: null };
  const before = structuredClone({ input, snapshot });
  expect(applyOpportunityFeedbackPolicy(input, snapshot, now).feedbackPolicy!.policy).toBe(FEEDBACK_POLICY);
  expect({ input, snapshot }).toEqual(before);
});
