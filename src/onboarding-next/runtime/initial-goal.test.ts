import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb, getDb } from '../../vault/schema';
import { appendUserProfileFact } from '../../vault/user-profile';
import { createGoal, findGoals, deleteGoal } from '../../vault/goals';
import { correctFact, findFacts } from '../../vault/facts';
import { MemoryForget } from '../../brief/memory-forget';
import { createInitialGoalPlanner, saveInitialInterviewGoal, PLANNER_RETRY, type PlannerRetry } from './initial-goal';
import { LLMProviderError } from '../../llm/provider';
import { initialGoalUnplanned } from '../../goals/initial-goal-notice';
import { GoalValidationError } from '../../goals/validation';
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
    await expect(createInitialGoalPlanner(async () => invalid, fakeRetry().retry)(snapshot(), () => {})).rejects.toThrow();
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

// Retry runs on an injected clock: no real sleeps, no event-ordering dependence.
function fakeRetry(overrides: Partial<PlannerRetry> = {}) {
  let clock = 0; const deadline = new AbortController(); const sleeps: number[] = []; const budgets: number[] = []; let cleared = 0;
  const retry: PlannerRetry = { ...PLANNER_RETRY, now: () => clock,
    deadline: ms => { budgets.push(ms); return { signal: deadline.signal, clear: () => { cleared++; } }; },
    sleep: async ms => { sleeps.push(ms); clock += ms; }, ...overrides };
  return { retry, sleeps, deadline, budgets, cleared: () => cleared, advance: (ms: number) => { clock += ms; } };
}
const transient = () => new LLMProviderError('upstream 503', 'network');
test('a transient planner failure is retried with backoff and the exit then creates the goal', async () => {
  appendUserProfileFact(goal); const { retry, sleeps } = fakeRetry(); let calls = 0;
  await createInitialGoalPlanner(async () => { if (++calls < 3) throw transient(); return proposal(); }, retry)(snapshot(), () => {});
  expect(calls).toBe(3); expect(sleeps).toEqual([2000, 5000]);
  saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(5);
  expect(initialGoalUnplanned()).toBe(false);
});
test('retries stop after the attempt limit; the exit finishes without a goal and the dashboard is told', async () => {
  appendUserProfileFact(goal); const { retry, sleeps } = fakeRetry(); let calls = 0;
  await expect(createInitialGoalPlanner(async () => { calls++; throw new LLMProviderError('rate limited', 'rate_limit'); }, retry)(snapshot(), () => {})).rejects.toThrow('rate limited');
  expect(calls).toBe(3); expect(sleeps).toEqual([2000, 5000]);
  expect(initialGoalUnplanned()).toBe(false);
  saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(0);
  expect(initialGoalUnplanned()).toBe(true);
  // Planning any goal later answers the notice.
  createGoal('Planned from Goals', 'objective'); expect(initialGoalUnplanned()).toBe(false);
});
test('an invalid plan is drawn once more without backoff, never a third time', async () => {
  appendUserProfileFact(goal); const { retry, sleeps } = fakeRetry(); let calls = 0;
  await expect(createInitialGoalPlanner(async () => { calls++; return { ...proposal(), milestones: [] }; }, retry)(snapshot(), () => {})).rejects.toThrow('complete initial OKR');
  expect(calls).toBe(2); expect(sleeps).toEqual([]);
  for (const [name, bad] of [['unparsable', () => { throw new SyntaxError('Unexpected token'); }], ['schema', () => ({ objective: {} })]] as const) {
    calls = 0;
    await expect(createInitialGoalPlanner(async () => { calls++; return (bad as () => GoalProposal)(); }, retry)(snapshot({ journeyId: name }), () => {})).rejects.toThrow();
    expect(calls).toBe(2);
  }
  calls = 0;
  await createInitialGoalPlanner(async () => ++calls === 1 ? { ...proposal(), key_results: [] } : proposal(), retry)(snapshot({ journeyId: 'second-draw' }), () => {});
  expect(calls).toBe(2);
});
test.each([
  ['auth', () => new LLMProviderError('bad key', 'auth')],
  ['content policy', () => new LLMProviderError('blocked', 'content_policy')],
  ['forbidden', () => new LLMProviderError('no model access', 'forbidden')],
  ['quota exhausted', () => new LLMProviderError('plan used up', 'quota_exhausted')],
  ['unclassified', () => Error('Goal planner unavailable')],
  ['over-long prompt', () => new GoalValidationError('text', 'must be at most 20000 characters')],
])('a definitive %s failure is not retried', async (_name, error) => {
  appendUserProfileFact(goal); const { retry, sleeps } = fakeRetry(); let calls = 0;
  await expect(createInitialGoalPlanner(async () => { calls++; throw error(); }, retry)(snapshot(), () => {})).rejects.toThrow();
  expect(calls).toBe(1); expect(sleeps).toEqual([]);
});
test('a revoked caller is never retried around', async () => {
  appendUserProfileFact(goal); const { retry } = fakeRetry(); let calls = 0, revoked = false;
  await expect(createInitialGoalPlanner(async () => { calls++; revoked = true; throw transient(); }, retry)(snapshot(), () => { if (revoked) throw Error('revoked'); })).rejects.toThrow('revoked');
  expect(calls).toBe(1);
});
test('the whole wait is bounded: a hung call ends at the deadline and aborts the provider request', async () => {
  appendUserProfileFact(goal); const { retry, deadline } = fakeRetry(); let seen: AbortSignal | undefined;
  const run = createInitialGoalPlanner((_text, signal) => { seen = signal; return new Promise<GoalProposal>(() => {}); }, retry)(snapshot(), () => {});
  await Promise.resolve(); deadline.abort(Error('planner deadline'));
  // Watchdog only: the bounded planner settles within microtasks of the abort, so
  // this second never elapses unless the bound is broken (then it fails, not hangs).
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([run.then(() => 'resolved', (e: Error) => e.message),
    new Promise<string>(resolve => { watchdog = setTimeout(() => resolve('still waiting'), 1000); })]);
  clearTimeout(watchdog);
  expect(outcome).toBe('planner deadline');
  expect(seen?.aborted).toBe(true);
});
test('no retry starts when its backoff or Retry-After would pass the budget', async () => {
  appendUserProfileFact(goal); const { retry, sleeps, advance } = fakeRetry(); let calls = 0;
  // 75s used + 2s backoff leaves 13s, under the 15s an attempt needs.
  await expect(createInitialGoalPlanner(async () => { calls++; advance(75_000); throw transient(); }, retry)(snapshot(), () => {})).rejects.toThrow('503');
  expect(calls).toBe(1); expect(sleeps).toEqual([]);
  // 70s used + 2s leaves 18s: the retry still runs.
  const inside = fakeRetry(); calls = 0;
  await expect(createInitialGoalPlanner(async () => { calls++; inside.advance(70_000); throw transient(); }, inside.retry)(snapshot({ journeyId: 'inside' }), () => {})).rejects.toThrow('503');
  expect(calls).toBe(2); expect(inside.sleeps).toEqual([2000]); expect(inside.cleared()).toBe(1);
  const hinted = fakeRetry(); calls = 0;
  await createInitialGoalPlanner(async () => { if (++calls === 1) throw new LLMProviderError('slow down', 'rate_limit', 7_000); return proposal(); }, hinted.retry)(snapshot({ journeyId: 'hinted' }), () => {});
  expect(hinted.sleeps).toEqual([7_000]);
  const tooLong = fakeRetry(); calls = 0;
  await expect(createInitialGoalPlanner(async () => { calls++; throw new LLMProviderError('slow down', 'rate_limit', 95_000); }, tooLong.retry)(snapshot({ journeyId: 'too-long' }), () => {})).rejects.toThrow('slow down');
  expect(calls).toBe(1); expect(tooLong.sleeps).toEqual([]);
});
test('the real wiring bounds one exit at 90s, under the 120s client budget', async () => {
  appendUserProfileFact(goal);
  const spy = fakeRetry(); await createInitialGoalPlanner(async () => proposal(), spy.retry)(snapshot(), () => {});
  expect(spy.budgets).toEqual([90_000]); expect(spy.cleared()).toBe(1);
  expect(PLANNER_RETRY.budgetMs + 0).toBeLessThan(120_000);
  // The default deadline really aborts, and clearing it stops the timer (1ms timers checked after a 5ms one).
  const short = PLANNER_RETRY.deadline(1); await Bun.sleep(5); expect(short.signal.aborted).toBe(true);
  const cleared = PLANNER_RETRY.deadline(1); cleared.clear(); await Bun.sleep(5); expect(cleared.signal.aborted).toBe(false);
});
test('shared work survives a waiter who leaves or loses authority while another still waits', async () => {
  appendUserProfileFact(goal); const { retry } = fakeRetry(); let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const planner = createInitialGoalPlanner(async () => { calls++; await gate; if (calls === 1) throw transient(); return proposal(); }, retry);
  let firstRevoked = false; const firstLeft = new AbortController();
  const first = planner(snapshot(), () => { if (firstRevoked) throw Error('first revoked'); }, firstLeft.signal);
  const second = planner(snapshot(), () => {}, new AbortController().signal);
  firstRevoked = true; firstLeft.abort();
  release();
  await expect(first).rejects.toThrow('first revoked');
  await second; expect(calls).toBe(2);
  saveInitialInterviewGoal(snapshot()); expect(findGoals()).toHaveLength(5);
});
test('when every waiter has left, the attempt in flight is cancelled', async () => {
  appendUserProfileFact(goal); const { retry } = fakeRetry(); let seen: AbortSignal | undefined;
  const planner = createInitialGoalPlanner((_text, signal) => { seen = signal; return new Promise<GoalProposal>(() => {}); }, retry);
  const a = new AbortController(), b = new AbortController();
  const runs = [planner(snapshot(), () => {}, a.signal), planner(snapshot(), () => {}, b.signal)].map(run => run.then(() => 'resolved', (e: Error) => e.message));
  await Promise.resolve(); a.abort();
  expect(seen?.aborted).toBe(false);
  b.abort();
  expect(seen?.aborted).toBe(true);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([Promise.all(runs), new Promise<string>(resolve => { watchdog = setTimeout(() => resolve('still waiting'), 1000); })]);
  clearTimeout(watchdog);
  expect(outcome).toEqual(['Every caller left before the plan was ready', 'Every caller left before the plan was ready']);
});
test('the default sleep ends early when the deadline fires', async () => {
  const controller = new AbortController(); const wait = PLANNER_RETRY.sleep(60_000, controller.signal);
  controller.abort(Error('deadline')); await expect(wait).rejects.toThrow('deadline');
});
