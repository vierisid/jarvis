import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb, getDb } from '../../vault/schema';
import { appendUserProfileFact } from '../../vault/user-profile';
import { createGoal, findGoals, deleteGoal } from '../../vault/goals';
import { correctFact, findFacts } from '../../vault/facts';
import { MemoryForget } from '../../brief/memory-forget';
import { saveInitialInterviewGoal } from './initial-goal';
import type { JourneySnapshot } from '../journey/types';
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(closeDb);
const snapshot = (patch = {}) => ({ scopeId: 'owner', journeyId: 'first-run', stepId: 'exited', completion: 'completed', interviewState: 'done', ...patch }) as JourneySnapshot;
const goal = { theme: 'goals', summary: 'Grow the surf brand to 50 orders per month by December', raw_quote: 'I want 50 orders a month by December.' };
test('completion creates one durable draft objective from the latest stated goal, never active work', () => {
  appendUserProfileFact({ ...goal, summary: 'Grow the brand' }); appendUserProfileFact(goal);
  saveInitialInterviewGoal(snapshot({ stepId: 'tour', completion: 'active' })); expect(findGoals()).toHaveLength(0);
  saveInitialInterviewGoal(snapshot()); saveInitialInterviewGoal(snapshot());
  expect(findGoals()).toHaveLength(1);
  expect(findGoals()[0]).toMatchObject({ title: goal.summary, description: goal.raw_quote, status: 'draft', authority_level: 0, deadline: null });
  const id = findGoals()[0]!.id; deleteGoal(id); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
});
test('exploring the dashboard also creates the first goal but skipping or absent goals does not invent one', () => {
  saveInitialInterviewGoal(snapshot({ journeyId: 'empty' })); expect(findGoals()).toHaveLength(0);
  appendUserProfileFact(goal); saveInitialInterviewGoal(snapshot({ interviewState: 'skipped' })); expect(findGoals()).toHaveLength(0);
  saveInitialInterviewGoal(snapshot({ completion: 'explored' })); expect(findGoals()).toHaveLength(1);
});
test('existing user goals are preserved without adding an onboarding duplicate', () => {
  const existing = createGoal('My existing goal', 'objective'); appendUserProfileFact(goal);
  saveInitialInterviewGoal(snapshot()); expect(findGoals().map(g => g.id)).toEqual([existing.id]);
});
test('forgotten or corrected interview sources never become goals', () => {
  appendUserProfileFact(goal); const original = findFacts({ predicate: 'shared about goals' })[0]!;
  correctFact(original.id, 'A corrected outcome', 'Correction'); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
  appendUserProfileFact({ ...goal, summary: 'A different goal' });
  const row = findFacts({ predicate: 'shared about goals' }).find(f => f.object === 'A different goal')!;
  const forget = new MemoryForget(getDb(), () => true); const read = forget.get(row.id);
  if (read.state !== 'ready') throw Error('missing fact');
  forget.forget(row.id, { requestId: 'forget', expectedRevision: read.revision, confirmed: true });
  saveInitialInterviewGoal(snapshot({ journeyId: 'another' })); expect(findGoals()).toHaveLength(0);
});
test('goal failure rolls back its receipt, so a retry can finish', () => {
  appendUserProfileFact(goal);
  getDb().exec("CREATE TRIGGER reject_goal BEFORE INSERT ON goals BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  expect(() => saveInitialInterviewGoal(snapshot())).toThrow('write failed');
  getDb().exec('DROP TRIGGER reject_goal'); saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(1);
});
