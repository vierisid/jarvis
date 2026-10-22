import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb, getDb } from '../../vault/schema';
import { appendUserProfileFact } from '../../vault/user-profile';
import { createGoal, findGoals, deleteGoal } from '../../vault/goals';
import { correctFact, findFacts } from '../../vault/facts';
import { MemoryForget } from '../../brief/memory-forget';
import { createInitialGoalPlanner, saveInitialInterviewGoal } from './initial-goal';
import type { JourneySnapshot } from '../journey/types';
import type { GoalProposal } from '../../goals/proposal';
import { getSetting } from '../../vault/settings';
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(closeDb);
const snapshot = (patch = {}) => ({ scopeId: 'owner', journeyId: 'first-run', stepId: 'exited', completion: 'completed', interviewState: 'done', ...patch }) as JourneySnapshot;
const goal = { theme: 'goals', summary: 'Grow the surf brand to 50 orders per month by December', raw_quote: 'I want 50 orders a month by December.' };
export const proposal = (): GoalProposal => ({
  objective: { title: 'A model paraphrase', description: 'Build the brand', success_criteria: 'Reach 50 orders per month', time_horizon: 'quarterly' },
  key_results: [
    { title: 'Reach 50 monthly orders', description: 'Review the monthly sales total', success_criteria: '50 orders in one month' },
    { title: 'Establish a weekly sales review', description: 'Use the Friday routine', success_criteria: 'A repeatable weekly report is in use' },
  ],
  milestones: [
    { key_result_index: 0, title: 'Establish current order baseline', description: 'Read the current order total' },
    { key_result_index: 1, title: 'Prepare the first weekly sales report', description: 'Use the totals provided by the user' },
  ],
});
const prepare = createInitialGoalPlanner(async () => proposal());
const ready = async (s = snapshot()) => prepare(s, () => {});
test('completion atomically creates one active OKR through the application service, with canonical events', async () => {
  appendUserProfileFact({ ...goal, summary: 'Grow the brand' }); appendUserProfileFact(goal);
  await ready(); expect(findGoals()).toHaveLength(0);
  saveInitialInterviewGoal(snapshot({ stepId: 'tour', completion: 'active' })); expect(findGoals()).toHaveLength(0);
  saveInitialInterviewGoal(snapshot()); saveInitialInterviewGoal(snapshot());
  const goals = findGoals(); expect(goals).toHaveLength(5);
  const root = goals.find(g => g.level === 'objective')!;
  expect(root.title).toBe(goal.summary);
  const results = goals.filter(g => g.level === 'key_result'); expect(results).toHaveLength(2);
  expect(results.every(g => g.parent_id === root.id && g.success_criteria)).toBe(true);
  for (const result of results) expect(goals.some(g => g.level === 'milestone' && g.parent_id === result.id)).toBe(true);
  expect(goals.every(g => g.status === 'active' && g.started_at !== null && g.authority_level === 0 && g.score === 0 && g.measurement === null)).toBe(true);
  expect(getDb().query('SELECT count(*) AS n FROM goal_events').get()).toEqual({ n: 15 });
  for (const g of [...goals].reverse()) deleteGoal(g.id);
  await ready(); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
});
test('explore creates the same active tree; skipped/absent goals do not invent one', async () => {
  saveInitialInterviewGoal(snapshot({ journeyId: 'empty' })); expect(findGoals()).toHaveLength(0);
  appendUserProfileFact(goal); await ready(snapshot({ interviewState: 'skipped' }));
  saveInitialInterviewGoal(snapshot({ interviewState: 'skipped' })); expect(findGoals()).toHaveLength(0);
  await ready(); saveInitialInterviewGoal(snapshot({ completion: 'explored' })); expect(findGoals()).toHaveLength(5);
});
test('existing user goals are preserved without adding or activating an onboarding duplicate', async () => {
  const existing = createGoal('My existing goal', 'objective'); appendUserProfileFact(goal);
  await createInitialGoalPlanner(async () => { throw Error('must not generate'); })(snapshot(), () => {});
  saveInitialInterviewGoal(snapshot()); expect(findGoals().map(g => [g.id,g.status])).toEqual([[existing.id,'draft']]);
});
test('forgotten/corrected sources and changes during generation cannot become goals', async () => {
  appendUserProfileFact(goal); await ready(); const original = findFacts({ predicate: 'shared about goals' })[0]!;
  correctFact(original.id, 'A corrected outcome', 'Correction'); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
  appendUserProfileFact({ ...goal, summary: 'A different goal' });
  const row = findFacts({ predicate: 'shared about goals' }).find(f => f.object === 'A different goal')!;
  const forget = new MemoryForget(getDb(), () => true); const read = forget.get(row.id);
  if (read.state !== 'ready') throw Error('missing fact');
  forget.forget(row.id, { requestId: 'forget', expectedRevision: read.revision, confirmed: true });
  saveInitialInterviewGoal(snapshot({ journeyId: 'another' })); expect(findGoals()).toHaveLength(0);
  appendUserProfileFact({ ...goal, summary: 'A newly stated goal' });
  const planner = createInitialGoalPlanner(async () => { appendUserProfileFact({ theme: 'scope', summary: 'Review everything' }); return proposal(); });
  await expect(planner(snapshot({ journeyId: 'changed' }), () => {})).rejects.toThrow('Interview changed');
});
test.each([
  "CREATE TRIGGER reject_write BEFORE INSERT ON goals WHEN NEW.level = 'milestone' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
  "CREATE TRIGGER reject_write BEFORE UPDATE ON goals WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'write failed'); END",
  "CREATE TRIGGER reject_write BEFORE INSERT ON goal_events BEGIN SELECT RAISE(ABORT, 'write failed'); END",
])('a failed hierarchy/status/event write rolls back the whole plan: %s', async trigger => {
  appendUserProfileFact(goal); let calls = 0;
  const planner = createInitialGoalPlanner(async () => { calls++; return proposal(); });
  await planner(snapshot(), () => {});
  getDb().exec(trigger);
  expect(() => saveInitialInterviewGoal(snapshot())).toThrow('write failed');
  expect(findGoals()).toHaveLength(0); expect(getDb().query('SELECT count(*) AS n FROM goal_events').get()).toEqual({ n: 0 });
  getDb().exec('DROP TRIGGER reject_write');
  await planner(snapshot(), () => {}); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(5); expect(calls).toBe(1);
});
test('invalid/partial plans never degrade to a lone objective; generation can retry before exit', async () => {
  appendUserProfileFact(goal);
  for (const invalid of [{ ...proposal(), key_results: [] }, { ...proposal(), milestones: [] }, { ...proposal(), clarifying_questions: ['What target?'] }])
    await expect(createInitialGoalPlanner(async () => invalid)(snapshot(), () => {})).rejects.toThrow();
  expect(findGoals()).toHaveLength(0);
  await ready(); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(5);
});
test('an exit without a prepared plan finishes without a goal and never creates one later', async () => {
  appendUserProfileFact(goal);
  await expect(createInitialGoalPlanner(async () => { throw Error('model down'); })(snapshot(), () => {})).rejects.toThrow('model down');
  expect(() => saveInitialInterviewGoal(snapshot())).not.toThrow(); expect(findGoals()).toHaveLength(0);
  expect(JSON.parse(getSetting('onboarding-next.initial-goal.v1.owner.first-run')!)).toEqual({ goalId: null, plan: 'unavailable' });
  // A plan that lands after the exit is never turned into a goal silently.
  await ready(); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
});
test('a plan for an earlier version of the interview finishes without a goal', async () => {
  appendUserProfileFact(goal); await ready();
  appendUserProfileFact({ theme: 'scope', summary: 'Review everything first' });
  expect(() => saveInitialInterviewGoal(snapshot())).not.toThrow(); expect(findGoals()).toHaveLength(0);
});
test('concurrent preparation shares the model call; a revoked caller cannot save a plan', async () => {
  appendUserProfileFact(goal); let calls = 0;
  const planner = createInitialGoalPlanner(async () => { calls++; await Bun.sleep(10); return proposal(); });
  await Promise.all([planner(snapshot(), () => {}), planner(snapshot(), () => {})]); expect(calls).toBe(1);
  const revoke = createInitialGoalPlanner(async () => { return proposal(); });
  let checks = 0;
  await expect(revoke(snapshot({ journeyId: 'revoked' }), () => { if (++checks > 1) throw Error('revoked'); })).rejects.toThrow('revoked');
  saveInitialInterviewGoal(snapshot({ journeyId: 'revoked' })); expect(findGoals()).toHaveLength(0);
  expect(JSON.parse(getSetting('onboarding-next.initial-goal.v1.owner.revoked')!)).toEqual({ goalId: null, plan: 'unavailable' });
});
