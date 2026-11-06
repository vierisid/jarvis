import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
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

test('a score write moves the revision even when it and its health change share one millisecond', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    const goal = goals.createGoal('Goal', 'task', { status: 'active' });
    const base = goals.getGoal(goal.id)!.updated_at;
    // A low score also changes health, whose write stamps the (frozen) clock.
    expect((await score(goal.id, { score: 0.1, reason: 'Same instant', expected_updated_at: base })).status).toBe(200);
    expect(goals.getGoal(goal.id)!.health).not.toBe(goal.health);
    expect(goals.getGoal(goal.id)!.updated_at).toBeGreaterThan(base);
    expect((await score(goal.id, { score: 0.9, reason: 'Stale', expected_updated_at: base })).status).toBe(409);
  } finally { clock.mockRestore(); }
});

test('no goal write in the same millisecond can move the revision back to one a stale draft holds', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    const goal = goals.createGoal('Goal', 'task', { status: 'active' });
    const base = goals.getGoal(goal.id)!.updated_at;
    expect((await score(goal.id, { score: 0.4, reason: 'Other tab', expected_updated_at: base })).status).toBe(200);
    const status = routes()['/api/goals/:id/status']!.POST!;
    expect((await status(new Request(`http://localhost/api/goals/${goal.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'paused' }) }))).status).toBe(200);
    goals.updateGoalHealth(goal.id, 'critical');
    expect((await score(goal.id, { score: 0.9, reason: 'Stale draft', expected_updated_at: base })).status).toBe(409);
    expect(goals.getGoal(goal.id)!.score).toBe(0.4);
  } finally { clock.mockRestore(); }
});

test('the score route rejects a revision that is not a whole number', async () => {
  const goal = goals.createGoal('Goal', 'task', { status: 'active' });
  expect((await score(goal.id, { score: 0.2, expected_updated_at: 1.5 })).status).toBe(400);
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
