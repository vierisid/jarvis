import { beforeEach, expect, test } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));

test.each(['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\nb', 'a\tb'])('a goal title with a control character is refused: %j', title => {
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
