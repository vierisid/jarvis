import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { GoalService } from './service.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';
import { createManageGoalsTool } from '../actions/tools/goals.ts';
import type { GoalEvent } from './events.ts';

let service: GoalService;
let events: GoalEvent[];
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  service = new GoalService({ enabled: false } as any);
  events = [];
  service.setEventCallback(event => { events.push(event); });
});
afterEach(async () => { await service.stop(); closeDb(); });
type Handler = (req: Request) => Response | Promise<Response>;
async function api(path: string, body: unknown, method = 'POST') {
  const routes = createApiRoutes({ config: {}, agentService: {}, goalService: service } as ApiContext) as Record<string, Record<string, Handler>>;
  const pathname = path.split('?')[0]!;
  const route = routes[pathname] ? pathname : pathname.replace(/\/api\/goals\/[^/]+(?=\/|$)/, '/api/goals/:id');
  return routes[route]![method]!(new Request('http://localhost' + path, { method, body: JSON.stringify(body) }));
}
function tool() { return createManageGoalsTool({ goalService: service } as any); }
function completionEntities(id: string) {
  return getDb().query("SELECT * FROM entities WHERE json_extract(properties, '$.goal_id') = ?").all(id);
}

test('dashboard and tool scores return the same health and emit equivalent events', async () => {
  const ui = vault.createGoal('UI', 'task', { status: 'active' });
  const chat = vault.createGoal('Chat', 'task', { status: 'active' });
  const response = await api(`/api/goals/${ui.id}/score`, { score: 0.5, reason: 'User assessment' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ score: 0.5, health: 'at_risk' });
  await tool().execute({ action: 'score', goal_id: chat.id, score: 0.5, reason: 'User assessment' });
  expect(vault.getGoal(chat.id)).toMatchObject({ score: 0.5, health: 'at_risk' });
  expect(events.filter(e => e.goalId === ui.id).map(e => e.type)).toEqual(['goal_scored', 'goal_health_changed']);
  expect(events.filter(e => e.goalId === chat.id).map(e => e.type)).toEqual(['goal_scored', 'goal_health_changed']);
  expect(vault.getProgressHistory(ui.id)).toHaveLength(1);
  expect(vault.getProgressHistory(chat.id)).toHaveLength(1);
});

test('dashboard and tool terminal status create completion memory once per transition', async () => {
  const ui = vault.createGoal('Same title', 'task', { status: 'active' });
  const chat = vault.createGoal('Same title', 'task', { status: 'active' });
  expect((await api(`/api/goals/${ui.id}/status`, { status: 'completed' })).status).toBe(200);
  await tool().execute({ action: 'update_status', goal_id: chat.id, status: 'completed' });
  expect(completionEntities(ui.id)).toHaveLength(1);
  expect(completionEntities(chat.id)).toHaveLength(1);
  const before = vault.getGoal(ui.id);
  expect((await api(`/api/goals/${ui.id}/status`, { status: 'completed' })).status).toBe(200);
  expect(vault.getGoal(ui.id)).toEqual(before);
  expect(events.filter(e => e.type === 'goal_completed')).toHaveLength(2);
  expect(completionEntities(ui.id)).toHaveLength(1);
});

test('invalid status and score input are 400 without mutation or events', async () => {
  const goal = vault.createGoal('Goal', 'task');
  const before = vault.getGoal(goal.id);
  for (const [suffix, body] of [['status', { status: 'typo' }], ['score', { score: 3, reason: 'Invalid range' }], ['score', { score: 0.5, reason: [] }], ['health', { health: 'typo' }]] as const) {
    expect((await api(`/api/goals/${goal.id}/${suffix}`, body)).status).toBe(400);
  }
  expect(vault.getGoal(goal.id)).toEqual(before);
  expect(vault.getProgressHistory(goal.id)).toEqual([]);
  expect(events).toEqual([]);
});

test('dashboard create, edit and delete emit the service events', async () => {
  const created = await api('/api/goals', { mode: 'quick', title: 'UI', level: 'task' });
  expect(created.status).toBe(201);
  const goal = await created.json() as { id: string };
  expect((await api(`/api/goals/${goal.id}`, { title: 'Edited' }, 'PATCH')).status).toBe(200);
  expect((await api(`/api/goals/${goal.id}`, undefined, 'DELETE')).status).toBe(200);
  expect(events.map(e => e.type)).toEqual(['goal_created', 'goal_updated', 'goal_deleted']);
});

test('an outer transaction rollback emits nothing and restores the goal and progress', () => {
  const goal = vault.createGoal('Goal', 'task');
  expect(() => getDb().transaction(() => {
    service.scoreGoal(goal.id, 0.5, 'assessment');
    throw new Error('late rollback');
  })()).toThrow('late rollback');
  expect(vault.getGoal(goal.id)!.score).toBe(0);
  expect(vault.getProgressHistory(goal.id)).toEqual([]);
  expect(events).toEqual([]);
});


test('goal event replay exposes ordered cursors and rejects invalid paging', async () => {
  const goal = service.createGoal('Replay', 'task');
  service.updateStatus(goal.id, 'completed');
  const first = await api('/api/goals/events?limit=1', undefined, 'GET');
  const page = await first.json() as { events: GoalEvent[]; nextCursor: number };
  expect(first.status).toBe(200);
  expect(page.events).toHaveLength(1);
  expect(page.events[0]?.type).toBe('goal_created');
  const next = await api(`/api/goals/events?after=${page.nextCursor}`, undefined, 'GET');
  const rest = await next.json() as { events: any[]; nextCursor: number };
  expect(rest.events).toHaveLength(1);
  expect(rest.events[0]).toMatchObject({ type: 'goal_completed', completionMemory: 'recorded' });
  expect(rest.nextCursor).toBeGreaterThan(page.nextCursor);
  for (const query of ['after=-1', 'after=NaN', 'after=1.5', 'limit=101', 'limit=0']) {
    expect((await api('/api/goals/events?' + query, undefined, 'GET')).status).toBe(400);
  }
});

test('dashboard refuses an automatic review source and leaves its score unchanged', async () => {
  const goal = vault.createGoal('Reviewed', 'task');
  expect((await api(`/api/goals/${goal.id}/score`, { score: 0.7, reason: 'Activity', source: 'daily_review' })).status).toBe(400);
  expect(vault.getGoal(goal.id)?.score).toBe(0);
  expect(vault.getProgressHistory(goal.id)).toEqual([]);
  expect(events).toEqual([]);
});

test('dashboard success remains successful when the event sink is unavailable', async () => {
  const goal = vault.createGoal('Completed', 'task');
  service.setEventCallback(() => { throw new Error('synthetic sink failure'); });
  expect((await api(`/api/goals/${goal.id}/status`, { status: 'completed' })).status).toBe(200);
  expect(vault.getGoal(goal.id)?.status).toBe('completed');
  expect(completionEntities(goal.id)).toHaveLength(1);
  service.setEventCallback(event => { events.push(event); });
  service.flushEvents();
  expect(events.map(e => e.type)).toEqual(['goal_completed']);
});


test('creating an already completed goal records its completion time and memory', async () => {
  const response = await api('/api/goals', { mode: 'quick', title: 'Completed on creation', level: 'task', status: 'completed' });
  expect(response.status).toBe(201);
  const goal = await response.json() as { id: string; completed_at: number; created_at: number };
  expect(goal.completed_at).toBe(goal.created_at);
  expect(completionEntities(goal.id)).toHaveLength(1);
});

test('a failed reorder rolls back earlier items and their events', async () => {
  const goal = vault.createGoal('Unchanged order', 'task');
  expect((await api('/api/goals/reorder', [{ id: goal.id, sort_order: 2 }, { id: 'missing', sort_order: 1 }])).status).toBe(400);
  expect(vault.getGoal(goal.id)?.sort_order).toBe(0);
  expect(events).toEqual([]);
  const response = await api('/api/goals/events', undefined, 'GET');
  expect(await response.json()).toMatchObject({ events: [] });
});
