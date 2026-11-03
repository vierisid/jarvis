import { expect, test } from 'bun:test';
import { collectValidationGaps } from './useWorkflowEditor';
import { flattenSteps } from './tree';
const gaps = (input: Record<string, unknown>, chosenTimezone?: string) => collectValidationGaps(flattenSteps({ name: 'trigger', type: 'PIECE_TRIGGER',
  settings: { pieceName: 'schedule', input, ...(chosenTimezone !== undefined ? { chosenTimezone } : {}) } }), []);
test('built-in schedules expose missing, malformed and invalid zone/policy fields', () => {
  expect(gaps({}).map(x => x.fieldName)).toEqual(['cron_expression']);
  expect(gaps({ cron_expression: 'not a cron', timezone: 'Europe/NotAPlace', dst_policy: 'invalid' }, 'Europe/NotAPlace').map(x => x.fieldName)).toEqual(['cron_expression', 'timezone', 'dst_policy']);
  for (const cron of ['0 9 * * 1-5', '0 17 LW * *', '0 9 1-7 1,4,7,10 1']) {
    expect(gaps({ cron_expression: cron, timezone: 'Europe/Rome', dst_policy: 'skip_missing_first_repeated' }, 'Europe/Rome')).toEqual([]);
  }
});
test('zone gaps agree with server readiness: only a chosen zone is checked', () => {
  // No zone, or an empty one, means Jarvis's configured zone.
  expect(gaps({ cron_expression: '0 9 * * *' })).toEqual([]);
  expect(gaps({ cron_expression: '0 9 * * *', timezone: '' })).toEqual([]);
  // A zone nobody chose is not used by the scheduler, so it does not block publishing.
  expect(gaps({ cron_expression: '0 9 * * *', timezone: 'Europe/NotAPlace' })).toEqual([]);
  expect(gaps({ cron_expression: '0 9 * * *', timezone: 'Europe/NotAPlace' }, 'Europe/NotAPlace').map(x => x.fieldName)).toEqual(['timezone']);
  // The server reads the first non-empty of the three cron keys.
  expect(gaps({ cron_expression: '', cronExpression: '0 9 * * *' })).toEqual([]);
});
