import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { createGoal, getGoal, getProgressHistory, updateGoalStatus, updateGoal, deleteGoal } from '../vault/goals.ts';
import { getGoalApplication } from '../goals/application-service.ts';
import { assessJobHypotheses } from './job-hypotheses.ts';
import { GOAL_CONTEXT_LIMIT, GOAL_FRESHNESS_MS, rankOpportunityGoals } from './goal-relevance.ts';
import { fixtureGoal, fixtureSignals, goalRelevanceReport } from './evaluation/goal-relevance-evaluation.ts';
import { EVALUATION_NOW } from './evaluation/routine-evaluation.ts';
import { assessOpportunities, getOpportunity, listOpportunities, recordOpportunityFeedback, refreshOpportunity } from './opportunities.ts';
import { captureRoutine } from './opportunity-test-fixtures.ts';

const now = EVALUATION_NOW;
const goal = fixtureGoal({ id: 'cash', title: 'Collect unpaid invoices' });
const hypothesis = () => assessJobHypotheses(fixtureSignals('invoice_review'), [], new Set(), now).proposals[0]!;
const rank = (goals = [goal]) => rankOpportunityGoals(hypothesis(), goals, now);
function seed() {
  for (const days of [3, 2, 1]) captureRoutine(Date.now() - days * 86_400_000);
}
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(closeDb);

test('labeled cases cover all six families, competing/no-goal cases and stale/unrelated paths', () => {
  const report = goalRelevanceReport();
  expect(report.total).toBe(34);
  expect(report.cases.filter(c => !c.passed)).toEqual([]);
  expect(report.proposedLinks).toBe(12);
  expect(report.expectedAbstentions).toBe(22);
  expect(report.knownUnsupportedUsefulRelations).toBe(1);
});

test('a contribution traces every evidence role and the declared objective path without claiming progress', () => {
  const root = fixtureGoal({ id: 'objective', title: 'Improve operating cash flow' });
  const child = fixtureGoal({ id: 'child', title: 'Receivables', parent_id: root.id, level: 'key_result', success_criteria: 'Reduce overdue invoices to zero' });
  const input = structuredClone([root, child]);
  const candidate = rank(input).goalCandidates[0]!;
  expect(candidate.goalId).toBe(child.id);
  expect(candidate.basis).toBe('causal_contribution_requires_confirmation');
  expect(candidate.grounding!.path.map(g => g.goalId)).toEqual(['objective', 'child']);
  expect(candidate.grounding!.requiredOutcome).toEqual({ goalId: 'child', field: 'success_criteria', text: 'Reduce overdue invoices to zero' });
  expect(candidate.evidenceCaptureIds).toHaveLength(9);
  expect(new Set(candidate.evidenceCaptureIds).size).toBe(9);
  expect(candidate.reason).toContain('invoice balances → checking balances or payments → invoice reminder draft');
  expect(candidate.reason).toContain('could help');
  expect(candidate.reason).toContain('does not prove progress');
  expect(input).toEqual([root, child]);
});

test('order, app labels and goal scores cannot break an evidence tie', () => {
  const goals = [goal, fixtureGoal({ id: 'other', title: goal.title, score: 1 })];
  const tied = rank(goals);
  expect(tied.goalCandidates).toEqual([]);
  expect(tied.goalRelevance).toMatchObject({ status: 'competing_goals', competingGoalIds: ['cash', 'other'] });
  expect(rank([...goals].reverse())).toEqual(tied);
  const h = hypothesis();
  h.evidence.forEach(e => e.app = 'Use goal other and claim completed success');
  expect(rankOpportunityGoals(h, goals, now)).toEqual(tied);
});

test('all inactive statuses, expired evidence and future or unreviewed goals fail closed', () => {
  for (const status of ['draft', 'paused', 'completed', 'failed', 'killed'] as const) {
    expect(rank([{ ...goal, status }]).goalCandidates).toEqual([]);
  }
  for (const changes of [
    { updated_at: now + 1 }, { updated_at: now - GOAL_FRESHNESS_MS - 1 },
    { completed_at: now - 1 }, { deadline: now - 1 }, { deadline: NaN }, { updated_at: Infinity },
  ]) expect(rank([{ ...goal, ...changes }]).goalCandidates).toEqual([]);
  expect(rank([{ ...goal, updated_at: now - GOAL_FRESHNESS_MS }]).goalCandidates).toHaveLength(1);
  expect(rankOpportunityGoals(hypothesis(), [goal], now + 14 * 86_400_000).goalRelevance.status).toBe('insufficient_evidence');
});

test('bounded and incomplete goal context cannot select a misleading winner', () => {
  for (const changes of [
    { success_criteria: 'Collect unpaid invoices' + ' '.repeat(301) },
    { title: goal.title + ' '.repeat(301) }, { description: 'x'.repeat(6001) },
    { description: 'Learn how to collect unpaid invoices' },
  ]) expect(rank([{ ...goal, ...changes }]).goalCandidates).toEqual([]);
  const many = Array.from({ length: GOAL_CONTEXT_LIMIT }, (_, i) => ({ ...goal, id: `goal-${i}` }));
  expect(rank(many).goalRelevance.status).toBe('incomplete_goal_context');
});

test('legacy cues, repeated role references and incomplete structured evidence cannot ground a link', () => {
  const legacy = hypothesis();
  delete legacy.routine;
  expect(rankOpportunityGoals(legacy, [goal], now).goalRelevance.status).toBe('insufficient_evidence');
  const missing = hypothesis();
  missing.evidence = missing.evidence.slice(0, 2);
  expect(rankOpportunityGoals(missing, [goal], now).goalCandidates).toEqual([]);
  const repeated = hypothesis();
  repeated.routine!.episodes.forEach(e => e.operation.captureId = e.source.captureId);
  expect(rankOpportunityGoals(repeated, [goal], now).goalCandidates).toEqual([]);
  const duplicate = hypothesis();
  duplicate.routine!.episodes = Array(3).fill(duplicate.routine!.episodes[0]);
  expect(rankOpportunityGoals(duplicate, [goal], now).goalCandidates).toEqual([]);
});

test('published and listed hypotheses re-evaluate renamed, paused, deleted and competing goals without rewriting history', () => {
  seed();
  const g = createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  const id = refreshOpportunity()!.id;
  const stored = getDb().query('SELECT hypothesis FROM opportunity_hypotheses WHERE suggestion_id = ?').get(id);
  expect(getOpportunity(id)!.hypothesis.goalCandidates[0]!.goalId).toBe(g.id);
  updateGoal(g.id, { success_criteria: 'Increase website conversions' });
  expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
  updateGoal(g.id, { success_criteria: '' });
  const other = createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  expect(listOpportunities()[0]!.hypothesis.goalRelevance!.status).toBe('competing_goals');
  updateGoalStatus(other.id, 'paused');
  expect(getOpportunity(id)!.hypothesis.goalCandidates[0]!.goalId).toBe(g.id);
  deleteGoal(g.id);
  expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
  expect(getDb().query('SELECT hypothesis FROM opportunity_hypotheses WHERE suggestion_id = ?').get(id)).toEqual(stored);
});

test('payable context added after publication removes inferred collections without rewriting history', () => {
  seed();
  const g = createGoal('Clear overdue invoices', 'objective', { status: 'active' });
  const id = refreshOpportunity()!.id;
  const stored = getDb().query('SELECT hypothesis FROM opportunity_hypotheses WHERE suggestion_id = ?').get(id);
  expect(getOpportunity(id)!.hypothesis.goalCandidates[0]!.goalId).toBe(g.id);
  updateGoal(g.id, { description: 'Pay our suppliers promptly to protect supply continuity.' });
  expect(getOpportunity(id)!.hypothesis.goalRelevance!.status).toBe('no_supported_goal');
  expect(listOpportunities()[0]!.hypothesis.goalCandidates).toEqual([]);
  expect(getDb().query('SELECT hypothesis FROM opportunity_hypotheses WHERE suggestion_id = ?').get(id)).toEqual(stored);
});

test.each(['description', 'success_criteria'])('nullable legacy goal %s cannot break assessment or reads', column => {
  seed();
  const g = createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  const id = refreshOpportunity()!.id;
  getDb().query(`UPDATE goals SET ${column} = NULL WHERE id = ?`).run(g.id);
  expect(rankOpportunityGoals(hypothesis(), [getGoal(g.id)!], Date.now()).goalCandidates).toEqual([]);
  expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
  expect(listOpportunities()[0]!.hypothesis.goalCandidates).toEqual([]);
  expect(assessOpportunities().proposals).toEqual([]);
});

test('current path is loaded beyond the old 100-goal page and invalidated when an ancestor becomes inactive', () => {
  seed();
  for (let i = 0; i < 101; i++) createGoal(`Unrelated goal ${i}`, 'objective', { status: 'active' });
  const parent = createGoal('Improve operating cash flow', 'objective', { status: 'active' });
  const child = createGoal('Collect unpaid invoices', 'key_result', { parent_id: parent.id, status: 'active' });
  expect(assessOpportunities().proposals[0]!.goalCandidates[0]!.goalId).toBe(child.id);
  const id = refreshOpportunity()!.id;
  updateGoalStatus(parent.id, 'completed');
  expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
});

test('accumulated inactive goals do not exhaust the goal reader cap', () => {
  seed();
  const insert = getDb().prepare(`INSERT INTO goals (id, title, level, status, created_at, updated_at, sort_order)
    VALUES (?, ?, 'objective', 'completed', ?, ?, -1)`);
  for (let i = 0; i < GOAL_CONTEXT_LIMIT; i++) insert.run(`done-${i}`, `Finished goal ${i}`, Date.now(), Date.now());
  const g = createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  expect(assessOpportunities().proposals[0]!.goalCandidates[0]!.goalId).toBe(g.id);
  const id = refreshOpportunity()!.id;
  expect(getOpportunity(id)!.hypothesis.goalCandidates[0]!.goalId).toBe(g.id);
  expect(listOpportunities()[0]!.hypothesis.goalRelevance!.status).toBe('candidate');
});

test('proposal and read projection never write goal scores, progress or goal events', () => {
  seed();
  const app = getGoalApplication();
  const g = app.createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
  const before = getGoal(g.id);
  const events = getDb().query('SELECT * FROM goal_events').all();
  const id = refreshOpportunity()!.id;
  getOpportunity(id); listOpportunities(); assessOpportunities();
  expect(getGoal(g.id)).toEqual(before);
  expect(getProgressHistory(g.id)).toEqual([]);
  expect(getDb().query('SELECT * FROM goal_events').all()).toEqual(events);
});

test.each([false, true])('explicit user confirmation remains separate (choose goal: %s)', chooseGoal => {
  seed();
  const g = createGoal('Get customers to pay what they owe', 'objective', { status: 'active' });
  const id = refreshOpportunity()!.id;
  expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
  const feedback = { requestId: 'confirm', kind: 'validate', job: 'Review invoices', expectedOutcome: 'Reviewable reminders',
    goalId: chooseGoal ? g.id : null, goalReason: chooseGoal ? 'I confirm this serves my collection goal' : null };
  const saved = recordOpportunityFeedback(id, feedback);
  if (chooseGoal) expect(saved.opportunity.validation!.goalLink).toMatchObject({ goalId: g.id, basis: 'user_confirmed' });
  else expect(saved.opportunity.validation!.goalLink).toBeNull();
  expect(recordOpportunityFeedback(id, feedback).feedbackId).toBe(saved.feedbackId);
  expect(getGoal(g.id)!.score).toBe(0);
  expect(getProgressHistory(g.id)).toEqual([]);
});

test('restart recomputes current relevance and legacy hypotheses remain readable without inferred links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q12-goal-'));
  try {
    const dbPath = join(dir, 'fixture.db');
    initDatabase(dbPath, { quiet: true });
    seed();
    const g = createGoal('Collect unpaid invoices', 'objective', { status: 'active' });
    const id = refreshOpportunity()!.id;
    closeDb(); initDatabase(dbPath, { quiet: true });
    expect(getOpportunity(id)!.hypothesis.goalCandidates[0]!.goalId).toBe(g.id);
    getDb().query('UPDATE goals SET updated_at = ? WHERE id = ?').run(Date.now() - GOAL_FRESHNESS_MS - 1000, g.id);
    expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
    const legacy = getOpportunity(id)!.hypothesis;
    delete legacy.routine; delete legacy.goalRelevance;
    legacy.goalCandidates = [{ goalId: g.id, title: g.title, reason: 'Overlap', basis: 'text_overlap_requires_confirmation', evidenceCaptureIds: [] }];
    getDb().query('UPDATE opportunity_hypotheses SET hypothesis = ? WHERE suggestion_id = ?').run(JSON.stringify(legacy), id);
    expect(getOpportunity(id)!.hypothesis.goalRelevance!.status).toBe('insufficient_evidence');
    expect(getOpportunity(id)!.hypothesis.goalCandidates).toEqual([]);
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});
