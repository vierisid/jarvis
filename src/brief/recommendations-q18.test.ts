import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb } from '../workflows/db';
import { closeDb, getDb } from '../vault/schema';
import { getGoalApplication } from '../goals/application-service';
import { getGoal } from '../vault/goals';
import { createWorkItem, decideWorkItem, getWorkItem } from '../goals/work-items';
import { ApprovalManager } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { DeferredExecutor } from '../authority/deferred-executor';
import { DecisionQueue } from './decisions';
import { Recommendations } from './recommendations';
import { loadRecommendationPlanner } from './recommendation-planner';

const present = existsSync(new URL('../goals/next-action.ts', import.meta.url));
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jarvis-f13-q18-')); initWorkflowDb(join(directory, 'fixture.db')); });
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const planner = await loadRecommendationPlanner(); expect(planner).not.toBeNull();
  const manager = new ApprovalManager();
  const queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
  return { planner: planner!, queue, provider: new Recommendations(getDb(), queue, planner) };
}
test.skipIf(present)('without Q-18, the loader supplies no substitute planner', async () => {
  expect(await loadRecommendationPlanner()).toBeNull();
});
test.skipIf(!present)('actual Q-18 recommends a concrete goal, accepts once, then links the existing work', async () => {
  const { provider, queue } = await fixture();
  const goal = getGoalApplication().createGoal('Send the reviewed partner follow-up', 'task', { status: 'active' });
  const front = createWorkItem({ title: 'Keep current work at the front' });
  // A prior-day unresolved proposal belongs to F-12, but Q-18 will not choose it as a new step.
  getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [Date.now() - 3 * 86_400_000, front.id]);
  const before = queue.get(`work:${front.id}`);
  const rec = provider.generate('q18-concrete');
  expect(rec).toMatchObject({ state: 'available', plan: { outcome: 'recommend', action: { kind: 'start_step', goal: { goalId: goal.id } } } });
  const receipt = provider.accept(rec.recommendationId, 'q18-accept', rec.revision);
  expect(provider.accept(rec.recommendationId, 'q18-accept', rec.revision)).toEqual(receipt);
  expect((await queue.read()).data.items.map(i => i.decisionId)).toEqual([before.decisionId, receipt.destination.decisionId]);
  expect(queue.get(before.decisionId)).toEqual(before); expect(getGoal(goal.id)).toEqual(goal);
  const next = provider.generate('q18-existing');
  expect(next.plan).toMatchObject({ outcome: 'recommend', action: { kind: 'continue_work', workItemId: receipt.destination.workItemId } });
  expect(provider.accept(next.recommendationId, 'q18-link', next.revision)).toMatchObject({ created: false, destination: receipt.destination });
});
test.skipIf(!present)('actual Q-18 questions, abstention and changed goal state remain non-actions', async () => {
  const { provider } = await fixture();
  expect(provider.generate('empty').state).toBe('none');
  const objective = getGoalApplication().createGoal('Grow partnerships', 'objective', { status: 'active' });
  const question = provider.generate('question'); expect(question.state).toBe('ask');
  expect(() => provider.accept(question.recommendationId, 'question', question.revision)).toThrow();
  getGoalApplication().updateStatus(objective.id, 'paused');
  const goal = getGoalApplication().createGoal('Send the approved proposal', 'task', { status: 'active' });
  const rec = provider.generate('stale'); expect(rec.state).toBe('available');
  getGoalApplication().updateStatus(goal.id, 'paused');
  expect(provider.get(rec.recommendationId).state).toBe('blocked');
  expect(() => provider.accept(rec.recommendationId, 'stale', rec.revision)).toThrow();
  expect((getDb().query('SELECT count(*) AS n FROM commitment_work').get() as { n: number }).n).toBe(0);
});

for (const timing of ['before generation', 'after generation'] as const) {
  test.skipIf(!present)(`actual Q-18 links surviving work after goal deletion ${timing}`, async () => {
    const { provider, queue } = await fixture();
    const goal = getGoalApplication().createGoal('Review the agreed proposal', 'task', { status: 'active' });
    const front = createWorkItem({ title: 'Keep the current front' });
    const first = queue.get(`work:${front.id}`);
    const frontBefore = queue.place(first.decisionId, first.revision, -10);
    const work = createWorkItem({ title: 'Review the agreed proposal', goalId: goal.id });
    decideWorkItem(work.id, { outcome: 'accepted', reason: 'Proceed' });
    const workBefore = getWorkItem(work.id), queuedBefore = queue.get(`work:${work.id}`);
    // Q-18 chooses accepted work ahead of new goals, but today's proposals rank first.
    getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [Date.now() - 3 * 86_400_000, front.id]);
    const retainedFront = queue.get(frontBefore.decisionId);
    const stale = timing === 'after generation' ? provider.generate('before-deletion') : null;
    if (stale) expect(stale.plan).toMatchObject({ outcome: 'recommend', action: { goal: { goalId: goal.id }, workItemId: work.id } });
    getGoalApplication().deleteGoal(goal.id);
    if (stale) {
      expect(provider.get(stale.recommendationId).state).toBe('blocked');
      expect(() => provider.accept(stale.recommendationId, 'stale-deleted-goal', stale.revision)).toThrow('changed');
    }
    const rec = provider.generate('surviving-work');
    expect(rec).toMatchObject({ state: 'available', plan: { outcome: 'recommend', action: { goal: null, workItemId: work.id } } });
    const receipt = provider.accept(rec.recommendationId, 'surviving-work', rec.revision);
    expect(receipt).toMatchObject({ created: false, destination: { decisionId: queuedBefore.decisionId, workItemId: work.id, title: work.title } });
    expect(provider.accept(rec.recommendationId, 'surviving-work', rec.revision)).toEqual(receipt);
    expect((await queue.read()).data.items).toEqual([retainedFront, queuedBefore]);
    expect(getWorkItem(work.id)).toEqual(workBefore); expect(getGoal(goal.id)).toBeNull();
    expect((getDb().query('SELECT count(*) AS n FROM commitment_work').get() as { n: number }).n).toBe(2);
    expect((getDb().query('SELECT count(*) AS n FROM goal_progress').get() as { n: number }).n).toBe(0);
    closeDb(); initWorkflowDb(join(directory, 'fixture.db'));
    const reopened = await fixture();
    expect(reopened.provider.get(rec.recommendationId)).toMatchObject({ state: 'accepted', acceptance: receipt });
    expect(reopened.provider.accept(rec.recommendationId, 'surviving-work', rec.revision)).toEqual(receipt);
    expect((await reopened.queue.read()).data.items).toEqual([retainedFront, queuedBefore]);
  });
}
