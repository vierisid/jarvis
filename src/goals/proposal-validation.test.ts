import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NLGoalBuilder } from './nl-builder.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import type { GoalLevel } from './types.ts';

const proposal = (): any => ({
  objective: { title: 'Ship', description: 'Release product', success_criteria: 'Ten customers', time_horizon: 'quarterly', deadline_days: 90 },
  key_results: [{ title: 'Build', description: 'Build core', success_criteria: 'Three features', deadline_days: 60 }],
  milestones: [{ key_result_index: 0, title: 'Auth', description: 'Login shipped', deadline_days: 30 }],
});
const builder = () => new NLGoalBuilder({});
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

for (const [label, mutate] of [
  ['bad later child', (p: any) => p.key_results.push({ title: null })],
  ['missing children', (p: any) => delete p.key_results],
  ['bad horizon', (p: any) => p.objective.time_horizon = 'whenever'],
  ['bad tags', (p: any) => p.objective.tags = [12]],
  ['blank title', (p: any) => p.objective.title = '  '],
  ['wrong child level', (p: any) => p.key_results[0].level = 'objective'],
  ['orphan milestone', (p: any) => p.milestones[0].key_result_index = 8],
  ['fractional index', (p: any) => p.milestones[0].key_result_index = 0.5],
  ['negative days', (p: any) => p.key_results[0].deadline_days = -1],
  ['fractional days', (p: any) => p.key_results[0].deadline_days = 1.5],
  ['child after parent', (p: any) => p.key_results[0].deadline_days = 100],
  ['invalid zone', (p: any) => p.timezone = 'Mars/Orbit'],
] as const) {
  test(`malformed proposal writes nothing: ${label}`, () => {
    const p = proposal(); mutate(p);
    expect(() => builder().createFromProposal(p)).toThrow();
    expect(vault.findGoals()).toEqual([]);
  });
}

test('a database failure on a later insert rolls back the entire proposal', () => {
  getDb().exec("CREATE TRIGGER reject_milestone BEFORE INSERT ON goals WHEN NEW.level = 'milestone' BEGIN SELECT RAISE(ABORT, 'synthetic child failure'); END;");
  expect(() => builder().createFromProposal(proposal())).toThrow('synthetic child failure');
  expect(vault.findGoals()).toEqual([]);
});

test.each(['objective', 'key_result', 'milestone', 'task'] as GoalLevel[])('decomposition of %s creates adjacent children without another objective', level => {
  const levels: GoalLevel[] = ['objective', 'key_result', 'milestone', 'task', 'daily_action'];
  const parent = vault.createGoal('Existing', level);
  const p = proposal();
  if (level === 'task') p.milestones = [];
  const children = builder().createFromProposal(p, parent.id);
  expect(children[0]!.title).toBe('Build');
  expect(children[0]!.parent_id).toBe(parent.id);
  expect(children[0]!.level).toBe(levels[levels.indexOf(level) + 1]!);
  if (level !== 'task') {
    expect(children[1]!.title).toBe('Auth');
    expect(children[1]!.parent_id).toBe(children[0]!.id);
    expect(children[1]!.level).toBe(levels[levels.indexOf(level) + 2]!);
  }
  expect(vault.getGoal(parent.id)!.title).toBe('Existing');
});

test('a leaf parent or mismatched proposal parent is rejected without child writes', () => {
  const leaf = vault.createGoal('Leaf', 'daily_action');
  expect(() => builder().createFromProposal(proposal(), leaf.id)).toThrow();
  const parent = vault.createGoal('Other', 'objective');
  const p = proposal(); p.parent_id = leaf.id; p.parent_level = 'daily_action';
  expect(() => builder().createFromProposal(p, parent.id)).toThrow();
  expect(vault.findGoals()).toHaveLength(2);
});

test('relative zero and all deadlines use one explicit reference, independent of confirmation time', () => {
  const p = proposal(); p.deadline_reference_at = '2026-03-28T12:00:00Z'; p.timezone = 'Europe/Berlin';
  p.milestones[0].deadline_days = 0;
  const goals = builder().createFromProposal(p);
  const base = Date.parse(p.deadline_reference_at);
  expect(goals.map(g => g.deadline)).toEqual([base + 90 * 86400000, base + 60 * 86400000, base]);
});

test('absolute deadlines preserve the exact offset-bearing instant', () => {
  const p = proposal(); p.timezone = 'Europe/Berlin';
  delete p.objective.deadline_days; delete p.key_results[0].deadline_days; delete p.milestones[0].deadline_days;
  p.objective.deadline_at = '2026-10-25T02:30:00.123+01:00';
  p.key_results[0].deadline_at = '2026-10-25T02:30:00+02:00';
  p.milestones[0].deadline_at = '2026-10-24T23:30:00Z';
  expect(builder().createFromProposal(p).map(g => g.deadline)).toEqual([
    Date.parse('2026-10-25T01:30:00.123Z'), Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-24T23:30:00Z'),
  ]);
});

test.each(['2026-02-30T12:00:00Z', '2026-10-25', '2026-10-25T02:30:00', '2026-03-01T24:00:00Z'])('invalid or ambiguous deadline %s writes nothing', deadline => {
  const p = proposal(); delete p.objective.deadline_days; p.objective.deadline_at = deadline;
  expect(() => builder().createFromProposal(p)).toThrow();
  expect(vault.findGoals()).toEqual([]);
});

test('model replies are validated on parse and malformed chat JSON is never returned as a proposal', async () => {
  const p = proposal(); p.key_results[0].title = [];
  const b = new NLGoalBuilder({ chatTier: async () => ({ content: JSON.stringify(p) }) });
  await expect(b.parseGoal('Ship')).rejects.toThrow();
  const chat = new NLGoalBuilder({ chatTier: async () => ({ content: 'Draft\n```json\n' + JSON.stringify(p) + '\n```' }) });
  expect((await chat.chat('missing', 'refine', [])).proposal).toBeUndefined();
  expect(vault.findGoals()).toEqual([]);
});

test('a generated proposal anchors its relative dates before confirmation', async () => {
  const time = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-28T12:00:00Z'));
  try {
    const b = new NLGoalBuilder({ chatTier: async () => ({ content: JSON.stringify(proposal()) }) });
    const p = await b.parseGoal('Ship');
    time.mockReturnValue(Date.parse('2026-03-30T12:00:00Z'));
    expect(b.createFromProposal(p)[0]!.deadline).toBe(Date.parse('2026-03-28T12:00:00Z') + 90 * 86400000);
  } finally { time.mockRestore(); }
});


test.each([NaN, Infinity, 1e30])('nonfinite or overflowing relative days are rejected: %s', days => {
  const p = proposal(); p.objective.deadline_days = days;
  expect(() => builder().createFromProposal(p)).toThrow();
  expect(vault.findGoals()).toEqual([]);
});

test('mixed date fields and unresolved clarification questions cannot be confirmed', () => {
  const p = proposal(); p.objective.deadline_at = '2026-12-01T00:00:00Z';
  expect(() => builder().createFromProposal(p)).toThrow();
  delete p.objective.deadline_at; p.clarifying_questions = ['Which market?'];
  expect(() => builder().createFromProposal(p)).toThrow();
  expect(vault.findGoals()).toEqual([]);
});

test('a missing intermediate deadline does not bypass its ancestor bound', () => {
  const root = vault.createGoal('Root', 'objective', { deadline: 1000 });
  const child = vault.createGoal('Child', 'key_result', { parent_id: root.id });
  expect(() => vault.createGoal('Grandchild', 'milestone', { parent_id: child.id, deadline: 2000 })).toThrow();
  expect(vault.findGoals()).toHaveLength(2);
});

test('failed decomposition rolls back children and preserves the existing parent', () => {
  const parent = vault.createGoal('Parent', 'objective');
  getDb().exec("CREATE TRIGGER reject_milestone BEFORE INSERT ON goals WHEN NEW.level = 'milestone' BEGIN SELECT RAISE(ABORT, 'synthetic child failure'); END;");
  expect(() => builder().createFromProposal(proposal(), parent.id)).toThrow();
  expect(vault.findGoals()).toEqual([parent]);
});


test('a JSON array containing a proposal is not treated as a complete proposal object', async () => {
  const b = new NLGoalBuilder({ chatTier: async () => ({ content: JSON.stringify([proposal()]) }) });
  await expect(b.parseGoal('Ship')).rejects.toThrow();
  expect(vault.findGoals()).toEqual([]);
});

test('valid hierarchy, text and exact UTC deadlines survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-c5-goals-'));
  const path = join(dir, 'goals.db');
  try {
    closeDb(); initDatabase(path, { quiet: true });
    const p = proposal(); p.timezone = 'Europe/Berlin'; p.deadline_reference_at = '2026-03-28T12:00:00Z';
    p.objective.tags = ['release'];
    const written = builder().createFromProposal(p);
    closeDb(); initDatabase(path, { quiet: true });
    expect(written.map(g => vault.getGoal(g.id))).toEqual(written);
    expect(vault.getGoalTree(written[0]!.id).map(g => [g.title, g.level, g.deadline])).toEqual([
      ['Ship', 'objective', Date.parse(p.deadline_reference_at) + 90 * 86400000],
      ['Build', 'key_result', Date.parse(p.deadline_reference_at) + 60 * 86400000],
      ['Auth', 'milestone', Date.parse(p.deadline_reference_at) + 30 * 86400000],
    ]);
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});
