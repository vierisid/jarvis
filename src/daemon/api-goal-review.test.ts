import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import * as goals from '../vault/goals.ts';
import { DailyRhythm } from '../goals/rhythm.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());
type Handler = (req: Request) => Response | Promise<Response>;
const routes = () => createApiRoutes({ config: {}, agentService: {} } as ApiContext) as
  Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
async function score(id: string, body: unknown) {
  const handler = routes()['/api/goals/:id/score']!.POST!;
  return handler(new Request(`http://localhost/api/goals/${id}/score`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }));
}

test('the public score API reports missing review evidence without claiming the goal is missing', async () => {
  const goal = goals.createGoal('Goal', 'task', { status: 'active' });
  const response = await score(goal.id, { score: 0.8, reason: 'Worked today', source: 'daily_review' });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('verified');
  expect(goals.getGoal(goal.id)!.score).toBe(0);
  expect(goals.getProgressHistory(goal.id)).toEqual([]);
});

test('manual scores still work and unknown IDs are rejected', async () => {
  const goal = goals.createGoal('Goal', 'task', { status: 'active' });
  const response = await score(goal.id, { score: 0.5, reason: 'User assessment' });
  expect(response.status).toBe(200);
  expect((await response.json() as { score: number }).score).toBe(0.5);
  expect((await score('unknown', { score: 0.5, reason: 'User assessment' })).status).toBe(404);
  expect((await score(goal.id, { score: '0.9', reason: 'Invalid number' })).status).toBe(400);
  expect(goals.getGoal(goal.id)!.score).toBe(0.5);
});

test('check-in API exposes the stored evidence snapshot and rejected decisions', async () => {
  const goal = goals.createGoal('Goal', 'task', { status: 'active' });
  const review = await new DailyRhythm({ chatTier: async () => ({ content: JSON.stringify({
    score_updates: [{ goalId: goal.id, newScore: 0.9, reason: 'Guessed' }],
  }) }) }).runEveningReview();
  const response = await routes()['/api/goals/check-ins']!.GET!(new Request('http://localhost/api/goals/check-ins?type=evening_review'));
  expect(response.status).toBe(200);
  const body = await response.json() as { review_evidence: unknown }[];
  expect(body[0]!.review_evidence).toEqual(review.reviewEvidence);
  expect(review.reviewEvidence.rejectedScoreUpdates[0]!.reason).toBe('no_evidence');
});
