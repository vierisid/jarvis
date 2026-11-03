import { expect, test } from 'bun:test';
import { collectValidationGaps } from './useWorkflowEditor';
import { flattenSteps } from './tree';
const gaps = (input: Record<string, unknown>) => collectValidationGaps(flattenSteps({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input } }), []);
test('built-in schedules expose missing, malformed and invalid zone/policy fields', () => {
  expect(gaps({}).map(x => x.fieldName)).toEqual(['cron_expression']);
  // Omitted timezone means Jarvis's configured zone (server readiness accepts it); a blank one does not.
  expect(gaps({ cron_expression: '0 9 * * *' })).toEqual([]);
  expect(gaps({ cron_expression: '0 9 * * *', timezone: '' }).map(x => x.fieldName)).toEqual(['timezone']);
  expect(gaps({ cron_expression: 'not a cron', timezone: 'Europe/NotAPlace', dst_policy: 'invalid' }).map(x => x.fieldName)).toEqual(['cron_expression', 'timezone', 'dst_policy']);
  for (const cron of ['0 9 * * 1-5', '0 17 LW * *', '0 9 1-7 1,4,7,10 1']) {
    expect(gaps({ cron_expression: cron, timezone: 'Europe/Rome', dst_policy: 'skip_missing_first_repeated' })).toEqual([]);
  }
});
