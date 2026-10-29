import { expect, test } from 'bun:test';
import { workflowTriggerLabel as label } from './workflow-trigger-label';
test('workflow list distinguishes trigger timing and missing setup', () => {
  const schedule = (cron: string, timezone = 'Europe/Rome') => label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: cron, timezone } } });
  expect(schedule('0 9 * * 1-5')).toBe('Weekdays at 09:00 Europe/Rome');
  expect(schedule('0 17 LW * *')).toBe('Last weekday of each month at 17:00 Europe/Rome');
  expect(schedule('0 9 1-7 1,4,7,10 1')).toBe('First Monday each quarter at 09:00 Europe/Rome');
  expect(schedule('')).toBe('Schedule: setup required');
  expect(schedule('no cron')).toBe('Schedule: setup required');
  expect(schedule('0 9 * * *', 'bad')).toBe('Schedule: setup required');
  expect(label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook' } })).toBe('Incoming webhook');
  expect(label({ name: 'trigger', type: 'EMPTY' })).toBe('Manual');
});
