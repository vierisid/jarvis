/**
 * F-06: the vendored date-helper piece as the engine runs it -- its compiled
 * `dist/`. An expression it cannot read must fail the step instead of leaving
 * the date unchanged, and "Use Current Time" must not demand a time to be
 * given as well.
 *
 * Needs the compiled piece. Like the other engine suites it skips without one,
 * and CI builds it because its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ENGINE_BUILD_PATHS } from './build';
import { buildPiece } from './build-pieces';

const pieceDir = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/date-helper');
const bundle = resolve(pieceDir, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(bundle);
const require = createRequire(import.meta.url);

type Run = (context: { propsValue: Record<string, unknown> }) => Promise<{ result: string }>;
let run: (name: string) => Run;

const addSubtract = (expression: string, extra: Record<string, unknown> = {}) => ({
  inputDate: '2026-01-31', inputDateFormat: 'YYYY-MM-DD', outputFormat: 'YYYY-MM-DD', expression, ...extra,
});

describe.skipIf(skip)('the compiled core date-helper piece', () => {
  beforeAll(async () => {
    if (buildOptIn) await buildPiece(pieceDir);
    const mod = require(bundle) as { utilityDate: { getAction(name: string): { run: Run } | undefined } };
    run = (name) => mod.utilityDate.getAction(name)!.run;
  });

  test('add_subtract_date refuses an expression it cannot read and says what is accepted', async () => {
    for (const bad of ['banana', '1 fortnight', '+ day', '2', '', '+1 day banana', '+ 1.5 hour']) {
      const failure = await run('add_subtract_date')({ propsValue: addSubtract(bad) }).then(() => null, (e: Error) => e);
      expect(failure?.message ?? `${JSON.stringify(bad)} was accepted`).toMatch(/^The expression ".*" could not be read\. .*year, month, day, hour, minute and second\.$/);
    }
  });

  test('add_subtract_date quotes a refused expression as a short single-line cut', async () => {
    const long = `+ 1 day\n${'x'.repeat(200)}`;
    const failure = await run('add_subtract_date')({ propsValue: addSubtract(long) }).then(() => null, (e: Error) => e);
    expect(failure?.message).toStartWith(`The expression "+ 1 day ${'x'.repeat(32)}..." could not be read.`);
    expect(failure?.message).not.toContain('\n');
  });

  test('add_subtract_date refuses a result outside the range a date can hold instead of returning "Invalid Date"', async () => {
    await expect(run('add_subtract_date')({ propsValue: addSubtract('+ 99999999999999999999 day') }))
      .rejects.toThrow('outside the range a date can hold');
  });

  test('add_subtract_date still applies every valid form of the expression', async () => {
    const cases: Array<[string, string]> = [
      ['- 1 day', '2026-01-30'], ['+1 day', '2026-02-01'], ['+ 2 days', '2026-02-02'],
      ['+ 1 month', '2026-02-28'], ['+ 1 year - 3 day', '2027-01-28'], ['5 second', '2026-01-31'],
      ['+1 DAY\n- 1 month', '2026-01-01'], ['+ 24 hours', '2026-02-01'],
      // A templated negative amount ("+ {{n}} day" with n = -3) and other whitespace.
      ['+ -3 day', '2026-01-28'], ['- -3 day', '2026-02-03'], ['+\t1 day', '2026-02-01'], ['+ 1\u00a0day', '2026-02-01'],
    ];
    for (const [expression, expected] of cases) {
      expect((await run('add_subtract_date')({ propsValue: addSubtract(expression) })).result).toBe(expected);
    }
  });

  const currentTimeProps: Array<[string, Record<string, unknown>]> = [
    ['next_day_of_week', { weekday: 1 }],
    ['next_day_of_year', { month: 3, day: 1 }],
    ['first_day_of_previous_month', {}],
    ['last_day_of_previous_month', {}],
  ];
  for (const [action, extra] of currentTimeProps) {
    test(`${action} with "Use Current Time" needs no time, and without it still needs HH:mm`, async () => {
      const props = { ...extra, timeFormat: 'HH:mm', timeZone: 'UTC' };
      const result = await run(action)({ propsValue: { ...props, currentTime: true } });
      expect(result.result).toMatch(/^\d\d:\d\d$/);
      await expect(run(action)({ propsValue: { ...props, currentTime: false, time: '9am' } })).rejects.toThrow();
      await expect(run(action)({ propsValue: { ...props, currentTime: false } })).rejects.toThrow();
      expect((await run(action)({ propsValue: { ...props, currentTime: false, time: '09:30' } })).result).toBe('09:30');
    });
  }
});
