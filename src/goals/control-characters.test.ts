import { beforeEach, expect, test } from 'bun:test';
import { getDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));

test.each(['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\nb', 'a\tb', 'a\u0085b', 'a\u2028b', 'a\u2029b'])('a goal title with a control character is refused: %j', title => {
  expect(() => vault.createGoal(title, 'task')).toThrow('control characters');
  expect(vault.findGoals()).toEqual([]);
});

test('a goal description keeps tabs and line breaks but refuses other control characters', () => {
  expect(vault.createGoal('Ok', 'task', { description: 'one\n\ttwo' }).description).toBe('one\n\ttwo');
  expect(() => vault.createGoal('Ok too', 'task', { description: 'bad\u0000' })).toThrow('control characters');
});

test('renaming a goal to a title with a control character is refused', () => {
  const goal = vault.createGoal('Fine', 'task');
  expect(() => vault.updateGoal(goal.id, { title: 'bad\u0000name' })).toThrow('control characters');
  expect(vault.getGoal(goal.id)!.title).toBe('Fine');
});

test('a lone surrogate is refused in a title and a description', () => {
  expect(() => vault.createGoal('a\ud800b', 'task')).toThrow('must be a valid string');
  expect(() => vault.createGoal('Ok', 'task', { description: 'a\udc00' })).toThrow('must be a valid string');
});

test('a C1 control is refused in a description', () => {
  expect(() => vault.createGoal('Ok', 'task', { description: 'bad\u009b' })).toThrow('control characters');
});

test.each(['לסיים פרויקט', 'إطلاق المنتج', 'می‌خواهم',
  '完成報告書', 'Ship \u{1F680} with the \u{1F468}‍\u{1F469}‍\u{1F467} ❤️'])('a title in any script is kept as written: %j', title => {
  expect(vault.createGoal(title, 'task').title).toBe(title);
});

test('a goal titled before the rule can still have other fields edited', () => {
  const goal = vault.createGoal('Fine', 'task');
  getDb().query('UPDATE goals SET title = ? WHERE id = ?').run('Old\ttitle', goal.id);
  expect(vault.updateGoal(goal.id, { description: 'now with notes' })!.title).toBe('Old\ttitle');
});
