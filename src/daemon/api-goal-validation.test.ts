import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { createManageGoalsTool } from '../actions/tools/goals.ts';
import { NLGoalBuilder } from '../goals/nl-builder.ts';

const proposal = (): any => ({
  objective: { title: 'Ship', description: 'Release', success_criteria: 'Ten customers', time_horizon: 'monthly' },
  key_results: [{ title: 'Build', description: 'Features', success_criteria: 'Three shipped' }],
  milestones: [{ key_result_index: 0, title: 'Auth', description: 'Login shipped' }],
});
let modelReply: unknown;
const llm = { chatTier: async () => {
  expect(getDb().inTransaction).toBe(false);
  return { content: JSON.stringify(modelReply) };
} };
type Handler = (request: Request) => Response | Promise<Response>;
const routes = () => createApiRoutes({ config: { timezone: 'Europe/Berlin' }, agentService: { getLLMManager: () => llm } } as unknown as ApiContext) as Record<string, Record<string, Handler>>;
async function request(body: unknown, id?: string) {
  const route = id ? '/api/goals/:id' : '/api/goals';
  const method = id ? 'PATCH' : 'POST';
  return routes()[route]![method]!(new Request(`http://localhost/api/goals${id ? '/' + id : ''}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
beforeEach(() => { initDatabase(':memory:', { quiet: true }); modelReply = proposal(); });
afterEach(() => closeDb());

test.each([null, Date.parse('2026-10-01T12:00:00Z')])('dashboard quick-create payload persists with deadline %j', async deadline => {
  // Match useGoalsData.createQuick, including its explicit mode and null defaults.
  const body = { mode: 'quick', title: 'Dashboard goal', level: 'task', parent_id: null, deadline, description: '' };
  const response = await request(body);
  expect(response.status).toBe(201);
  const created = await response.json() as { id: string };
  const { mode, ...fields } = body;
  expect(vault.getGoal(created.id)).toMatchObject(fields);
  expect(vault.findGoals()).toHaveLength(1);
});

test('quick mode still validates goal fields before writing', async () => {
  const response = await request({ mode: 'quick', title: ' ', level: 'task', parent_id: null, deadline: null, description: '' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'INVALID_GOAL', path: 'goal.title' });
  expect(vault.findGoals()).toEqual([]);
});

test.each([null, [], 4, { mode: 'typo', title: 'Goal' }, { title: [] }, { title: '  ' },
  { title: 'Goal', level: 'invalid' }, { title: 'Goal', deadline: '2026-10-01' },
  { title: 'Goal', estimated_hours: -2 }, { title: 'Goal', authority_level: 11 },
  { title: 'Goal', parent_id: 'missing' }, { title: 'Goal', tags: [3] },
])('invalid direct API write is 4xx and writes nothing: %j', async body => {
  const result = await request(body);
  expect(result.status).toBe(400);
  expect(vault.findGoals()).toEqual([]);
});

test('quick-create and patch enforce the same shape and hierarchy as proposal writes', async () => {
  const parent = vault.createGoal('Root', 'objective', { deadline: 20000 });
  expect((await request({ title: 'Wrong', level: 'task', parent_id: parent.id })).status).toBe(400);
  const created = await request({ title: 'Child', level: 'key_result', parent_id: parent.id, deadline: 10000 });
  expect(created.status).toBe(201);
  const child = await created.json() as { id: string };
  const before = vault.getGoal(child.id);
  const bad = await request({ title: 'Changed', deadline: 'soon' }, child.id);
  expect(bad.status).toBe(400);
  expect((await bad.json() as { path: string }).path).toBe('goal.deadline');
  expect(vault.getGoal(child.id)).toEqual(before);
  expect((await request({ level: 'objective' }, child.id)).status).toBe(400);
  expect((await request({ deadline: 30000 }, child.id)).status).toBe(400);
  expect((await request({ deadline: 5000 }, parent.id)).status).toBe(400);
  expect((await request({ deadline: null }, child.id)).status).toBe(200);
  expect(vault.getGoal(child.id)!.deadline).toBeNull();
});

test('API proposal validation and an insert failure leave no partial tree', async () => {
  const p = proposal(); p.key_results.push({ title: 'bad' });
  const malformed = await request({ mode: 'create_from_proposal', proposal: p });
  expect(malformed.status).toBe(400);
  expect((await malformed.json() as { path: string }).path).toContain('key_results[1]');
  expect(vault.findGoals()).toEqual([]);
  getDb().exec("CREATE TRIGGER reject_child BEFORE INSERT ON goals WHEN NEW.level = 'milestone' BEGIN SELECT RAISE(ABORT, 'synthetic child failure'); END;");
  expect((await request({ mode: 'create_from_proposal', proposal: proposal() })).status).toBe(500);
  expect(vault.findGoals()).toEqual([]);
});

test('the API returns an anchored validated proposal and confirms the same deadlines', async () => {
  const p = proposal(); p.objective.deadline_days = 2; p.key_results[0].deadline_days = 0;
  modelReply = p;
  const response = await request({ mode: 'propose', text: 'Ship' });
  expect(response.status).toBe(200);
  const returned = await response.json() as any;
  expect(returned.timezone).toBe('Europe/Berlin');
  expect(Number.isFinite(Date.parse(returned.deadline_reference_at))).toBe(true);
  const saved = await request({ mode: 'create_from_proposal', proposal: returned });
  expect(saved.status).toBe(201);
  const goals = await saved.json() as { deadline: number | null; parent_id: string | null; id: string }[];
  expect(goals.map(g => g.deadline)).toEqual([Date.parse(returned.deadline_reference_at) + 2 * 86400000, Date.parse(returned.deadline_reference_at), null]);
  expect(goals[1]!.parent_id).toBe(goals[0]!.id);
  expect(goals[2]!.parent_id).toBe(goals[1]!.id);
});

test('the API rejects malformed model output without offering a confirmable proposal', async () => {
  modelReply = { objective: { title: 'Only a title' }, key_results: [] };
  expect((await request({ mode: 'propose', text: 'Ship' })).status).toBe(400);
  expect(vault.findGoals()).toEqual([]);
});

test('decomposition through the real chat tool creates next-level children', async () => {
  const parent = vault.createGoal('Existing key result', 'key_result');
  const tool = createManageGoalsTool({ nlBuilder: new NLGoalBuilder(llm, { timezone: 'Europe/Berlin' }) } as any);
  const result = await tool.execute({ action: 'decompose', goal_id: parent.id });
  expect(result).toContain('Decomposed into 2');
  expect(vault.getGoalTree(parent.id).map(g => g.level)).toEqual(['key_result', 'milestone', 'task']);
});

test('chat quick-create under a parent defaults to the next level', async () => {
  const parent = vault.createGoal('Revenue', 'key_result');
  const tool = createManageGoalsTool({ goalService: { createGoal: vault.createGoal } } as any);
  expect(await tool.execute({ action: 'create', title: 'Pricing page', parent_id: parent.id })).toContain('Created milestone');
  expect(vault.getGoalTree(parent.id).map(g => g.level)).toEqual(['key_result', 'milestone']);
  expect(await tool.execute({ action: 'create', title: 'Standalone' })).toContain('Created task');
});

test('parent identity and level are rechecked at confirmation', async () => {
  const parent = vault.createGoal('Existing', 'key_result');
  const b = new NLGoalBuilder(llm);
  const p = await b.decompose(parent.id);
  expect(p?.parent_id).toBe(parent.id);
  expect(p?.parent_level).toBe('key_result');
  // Simulate a changed legacy row while a proposal is awaiting confirmation.
  getDb().run("UPDATE goals SET level = 'objective' WHERE id = ?", [parent.id]);
  expect((await request({ mode: 'create_from_proposal', proposal: p })).status).toBe(400);
  expect(vault.findGoals()).toHaveLength(1);
  vault.deleteGoal(parent.id);
  expect((await request({ mode: 'create_from_proposal', proposal: p })).status).toBe(400);
  expect(vault.findGoals()).toEqual([]);
});
