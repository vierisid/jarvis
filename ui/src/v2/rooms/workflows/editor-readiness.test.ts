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
test('a declared whitespace dropdown choice is filled in, as on the server; other blanks are still gaps', () => {
  const catalog = [{ name: 'csv', displayName: 'CSV', description: '', triggers: [], actions: [{ name: 'convert_csv_to_json', displayName: '', description: '', inputSchema: { fields: [
    { name: 'delimiter_type', label: 'Delimiter Type', type: 'enum' as const, required: true, options: [{ value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }] },
    { name: 'csv_text', label: 'CSV Text', type: 'long_text' as const, required: true },
  ] } }] }];
  const csvGaps = (input: Record<string, unknown>) => collectValidationGaps(flattenSteps({ name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'step_1', type: 'PIECE', settings: { pieceName: 'csv', actionName: 'convert_csv_to_json', input } } } as never), catalog).map(x => x.fieldName);
  expect(csvGaps({ delimiter_type: '\t', csv_text: 'a' })).toEqual([]);
  expect(csvGaps({ delimiter_type: ' ', csv_text: '   ' })).toEqual(['delimiter_type', 'csv_text']);
  expect(csvGaps({ delimiter_type: '', csv_text: '\t' })).toEqual(['delimiter_type', 'csv_text']);
});
