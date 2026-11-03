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
  // Omitted timezone is Jarvis's configured one, which readiness accepts; an empty one is not.
  const noZone = (pieceName: string) => label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName, input: { cron_expression: '0 9 * * *' } } });
  expect(noZone('schedule')).toBe('Daily at 09:00');
  expect(noZone('@activepieces/piece-schedule')).toBe('Schedule: setup required');
  expect(schedule('0 9 * * *', '')).toBe('Schedule: setup required');
  expect(label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook' } })).toBe('Incoming webhook');
  expect(label({ name: 'trigger', type: 'EMPTY' })).toBe('Manual');
});
