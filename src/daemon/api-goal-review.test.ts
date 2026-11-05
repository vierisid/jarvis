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

test('a score with a stale expected revision answers 409 with the current goal and writes nothing', async () => {
  const goal = goals.createGoal('Goal', 'task', { status: 'active' });
  const base = goals.getGoal(goal.id)!.updated_at;
  const first = await score(goal.id, { score: 0.4, reason: 'From another tab', expected_updated_at: base });
  expect(first.status).toBe(200);
  const current = goals.getGoal(goal.id)!;
  expect(current.updated_at).not.toBe(base);
  const stale = await score(goal.id, { score: 0.9, reason: 'Old draft', source: 'user', expected_updated_at: base });
  expect(stale.status).toBe(409);
  const body = await stale.json() as { code: string; goal: { score: number; updated_at: number } };
  expect(body.code).toBe('SCORE_CONFLICT');
  expect(body.goal).toMatchObject({ score: 0.4, updated_at: current.updated_at });
  expect(goals.getGoal(goal.id)!.score).toBe(0.4);
  expect(goals.getProgressHistory(goal.id)).toHaveLength(1);
  // Saving again against the new base succeeds; a client without a revision keeps last-write-wins.
  expect((await score(goal.id, { score: 0.9, reason: 'Rebased', expected_updated_at: current.updated_at })).status).toBe(200);
  expect((await score(goal.id, { score: 0.1, reason: 'Legacy client' })).status).toBe(200);
  expect(goals.getGoal(goal.id)!.score).toBe(0.1);
  expect((await score(goal.id, { score: 0.2, expected_updated_at: 'yesterday' })).status).toBe(400);
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
