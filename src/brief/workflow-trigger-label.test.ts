import { expect, test } from 'bun:test';
import { workflowTriggerLabel as label } from './workflow-trigger-label';
const trigger = (pieceName: string, input: Record<string, unknown>, chosenTimezone?: string) =>
  label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName, input, ...(chosenTimezone !== undefined ? { chosenTimezone } : {}) } });
test('workflow list distinguishes trigger timing and missing setup', () => {
  // A zone a person chose (settings.chosenTimezone) is where the schedule fires.
  const schedule = (cron: string, timezone = 'Europe/Rome') => trigger('schedule', { cron_expression: cron, timezone }, timezone);
  expect(schedule('0 9 * * 1-5')).toBe('Weekdays at 09:00 Europe/Rome');
  expect(schedule('0 17 LW * *')).toBe('Last weekday of each month at 17:00 Europe/Rome');
  expect(schedule('0 9 1-7 1,4,7,10 1')).toBe('First Monday each quarter at 09:00 Europe/Rome');
  expect(schedule('')).toBe('Schedule: setup required');
  expect(schedule('no cron')).toBe('Schedule: setup required');
  expect(schedule('0 9 * * *', 'bad')).toBe('Schedule: setup required');
  expect(trigger('schedule', { cron_expression: '0 9 * * *', dst_policy: 'invalid' })).toBe('Schedule: setup required');
  expect(label({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook' } })).toBe('Incoming webhook');
  expect(label({ name: 'trigger', type: 'EMPTY' })).toBe('Manual');
});
test('a schedule without a chosen zone runs in Jarvis\'s zone, as readiness and the trigger runtime treat it', () => {
  expect(trigger('schedule', { cron_expression: '0 9 * * *' })).toBe('Daily at 09:00');
  expect(trigger('schedule', { cron_expression: '0 9 * * *', timezone: '' })).toBe('Daily at 09:00');
  // A pre-filled zone nobody chose is not used, so it is neither shown nor refused.
  expect(trigger('schedule', { cron_expression: '0 9 * * *', timezone: 'Not/AZone' })).toBe('Daily at 09:00');
  expect(trigger('schedule', { cron_expression: '0 9 * * *', timezone: 'America/New_York' })).toBe('Daily at 09:00');
  // The bundled piece needs its own valid zone.
  expect(trigger('@activepieces/piece-schedule', { cronExpression: '0 9 * * *' })).toBe('Schedule: setup required');
  expect(trigger('@activepieces/piece-schedule', { cronExpression: '0 9 * * *', timezone: 'UTC' })).toBe('Daily at 09:00 UTC');
});
