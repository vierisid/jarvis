/**
 * Date Helper: a date reads and formats the same on every daemon time zone,
 * explicit offsets win over the zone setting, and text that is not the declared
 * format or not a real date fails the step instead of giving a wrong date.
 *
 * The action tests build the real vendored piece and run it in a child process
 * under three daemon zones (UTC, Rome, Kiritimati), because the zone of a
 * process cannot be changed once its Date code has run. Like the other engine
 * suites they need the compiled piece: they skip without one, and CI builds it
 * because its bun test run sets `JARVIS_TEST_ENGINE_BUILD=1`. The parser tests
 * at the end run everywhere.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { parseDateInstant } from './date-parse';

const PIECE_DIR = join(import.meta.dir, '../activepieces/packages/pieces/core/date-helper');
const ZONES = ['UTC', 'Europe/Rome', 'Pacific/Kiritimati'];
const BUNDLE = join(PIECE_DIR, 'dist/src/index.js');
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const skip = !buildOptIn && !existsSync(BUNDLE);
const FORMAT_DATE = { inputFormat: 'YYYY-MM-DD HH:mm:ss', inputTimeZone: 'UTC', outputFormat: 'YYYY-MM-DD HH:mm:ss', outputTimeZone: 'UTC' };

type Case = { action: string; props: Record<string, unknown> };
const CHILD = `
const m = await import(process.env.DATE_PIECE);
const actions = m.utilityDate.actions();
const out = [];
for (const c of JSON.parse(process.env.DATE_CASES)) {
  try { out.push({ ok: (await actions[c.action].run({ propsValue: c.props })) }); }
  catch (e) { out.push({ error: String(e.message) }); }
}
console.log('@@' + JSON.stringify(out));
`;

const piece = BUNDLE;
beforeAll(async () => {
  if (skip) return;
  const built = await buildPiece(PIECE_DIR);
  expect(built.packageName).toBe('@activepieces/piece-date-helper');
}, 120_000);

/** Run the cases in a fresh process whose own zone is `tz`; one result per case: { ok } or { error }. */
function runIn(tz: string, cases: Case[]): Array<{ ok?: unknown; error?: string }> {
  const r = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', CHILD], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TZ: tz, DATE_PIECE: piece, DATE_CASES: JSON.stringify(cases) },
  });
  const text = r.stdout.toString();
  if (r.exitCode !== 0 || !text.includes('@@')) throw new Error(`child under TZ=${tz} failed: ${r.stderr.toString()}`);
  return JSON.parse(text.slice(text.indexOf('@@') + 2));
}

/** The same cases under every daemon zone: the results must be identical, and equal to `expected`. */
function sameEverywhere(cases: Case[], expected: Array<{ ok: unknown } | { error: RegExp }>) {
  for (const tz of ZONES) {
    const got = runIn(tz, cases);
    expected.forEach((want, i) => {
      if ('error' in want) expect({ tz, i, error: got[i]!.error ?? null }).toEqual({ tz, i, error: expect.stringMatching(want.error) });
      else expect({ tz, i, got: got[i] }).toEqual({ tz, i, got: { ok: want.ok } });
    });
  }
}

const fd = (inputDate: string, over: Record<string, unknown> = {}): Case => ({ action: 'format_date', props: { ...FORMAT_DATE, inputDate, ...over } });
const res = (result: string) => ({ ok: { result } });

describe.skipIf(skip)('format_date gives the same answer on every daemon time zone', () => {
  test('Unix seconds in, in UTC', () => {
    const x = { inputFormat: 'X' };
    sameEverywhere([fd('1794357240', x), fd('0', x), fd('2147483648', x)],
      [res('2026-11-11 00:34:00'), res('1970-01-01 00:00:00'), res('2038-01-19 03:14:08')]);
  });
  test('Unix seconds out, from a UTC wall time and from a zoned one', () => {
    const x = { outputFormat: 'X' };
    sameEverywhere([fd('2038-01-19 03:14:08', x), fd('2026-11-11 01:34:00', { ...x, inputTimeZone: 'Europe/Rome' }), fd('2026-11-11 00:34:00', { ...x, outputTimeZone: 'Asia/Tokyo' })],
      [res('2147483648'), res('1794357240'), res('1794357240')]);
  });
  test('a wall time is read in the From zone and shown in the To zone', () => {
    sameEverywhere([fd('2026-11-11 09:00:00', { inputTimeZone: 'Europe/Rome', outputTimeZone: 'Asia/Tokyo' }), fd('2026-07-01 09:00:00', { inputTimeZone: 'America/New_York' })],
      [res('2026-11-11 17:00:00'), res('2026-07-01 13:00:00')]);
  });
  test('a skipped wall time moves forward and a repeated one is the earlier, east and west of UTC', () => {
    const rome = { inputTimeZone: 'Europe/Rome' };
    const ny = { inputTimeZone: 'America/New_York' };
    sameEverywhere([
      fd('2027-03-28 02:30:00', rome), fd('2026-10-25 02:30:00', rome),
      fd('2026-03-08 02:30:00', ny), fd('2026-11-01 01:30:00', ny),
    ], [
      res('2027-03-28 01:30:00'), // 03:30 CEST
      res('2026-10-25 00:30:00'), // 02:30 CEST, the first 02:30
      res('2026-03-08 07:30:00'), // 03:30 EDT
      res('2026-11-01 05:30:00'), // 01:30 EDT, the first 01:30
    ]);
  });
});

describe.skipIf(skip)('an offset or Z in the input wins over the From zone', () => {
  test('ISO offsets, Z, fractions and the JavaScript date string', () => {
    const iso = { inputFormat: 'YYYY-MM-DDTHH:mm:ss' };
    sameEverywhere([
      fd('2026-11-11T09:00:00+05:45', iso), fd('2026-11-11T09:00:00Z', { ...iso, inputTimeZone: 'Europe/Rome' }),
      fd('2026-11-11T09:00:00-03:30', iso), fd('2026-11-11T09:00:00.250+0100', { ...iso, outputFormat: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      fd('Wed Nov 11 2026 10:00:00 GMT+0100 (CET)', { inputFormat: 'DDD MMM DD YYYY HH:mm:ss' }),
    ], [res('2026-11-11 03:15:00'), res('2026-11-11 09:00:00'), res('2026-11-11 12:30:00'), res('2026-11-11 08:00:00.250'), res('2026-11-11 09:00:00')]);
  });
});

describe.skipIf(skip)('text that is not the declared format or not a real date fails with a plain message', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['1794357240000', { inputFormat: 'X' }, /too large to be a Unix time in seconds.*milliseconds/],
    ['0000-01-01', { inputFormat: 'YYYY-MM-DD' }, /not a real date/],
    ['10000-01-01', { inputFormat: 'YYYY-MM-DD' }, /does not match the format/],
    ['2027-02-29', { inputFormat: 'YYYY-MM-DD' }, /not a real date/],
    ['2026-13-01', { inputFormat: 'YYYY-MM-DD' }, /not a real date/],
    ['2026-11-11 25:00:00', {}, /not a real date/],
    ['2026-11-11 24:00:00', {}, /not a real date/],
    ['2016-12-31 23:59:60', {}, /not a real date/],
    ['2016-12-31T23:59:60Z', { inputFormat: 'YYYY-MM-DDTHH:mm:ss' }, /not a real date/],
    ['2026-02-30 10:00:00', {}, /not a real date/],
    ['Wed Nov 11 2026 10:00:00 GMT+0100 (CET)', {}, /does not match the format "YYYY-MM-DD HH:mm:ss"/],
    ['2026-11-11 and more', { inputFormat: 'YYYY-MM-DD' }, /does not match the format/],
  ];
  test('every one of them throws under every daemon zone', () => {
    sameEverywhere(cases.map(([d, o]) => fd(d, o)), cases.map(([, , re]) => ({ error: re })));
  });
});

describe.skipIf(skip)('the other actions share the parser, so they do not depend on the daemon zone either', () => {
  test('date_difference across a Rome DST change is 24 hours, as on a UTC host', () => {
    const base = { startDateFormat: 'YYYY-MM-DD HH:mm:ss', endDateFormat: 'YYYY-MM-DD HH:mm:ss', unitDifference: ['day', 'hour'] };
    sameEverywhere([
      { action: 'date_difference', props: { ...base, startDate: '2026-03-28 12:00:00', endDate: '2026-03-29 12:00:00' } },
      { action: 'date_difference', props: { ...base, startDate: '2026-03-28 12:00:00', endDate: '2027-02-29 12:00:00' } },
    ], [{ ok: { day: 1, hour: 0 } }, { error: /not a real date/ }]);
  });
  test('extract_date_parts reads the parts of the instant in UTC', () => {
    sameEverywhere([
      { action: 'extract_date_parts', props: { inputDate: '0', inputFormat: 'X', unitExtract: ['year', 'day', 'hour'] } },
      { action: 'extract_date_parts', props: { inputDate: '2026-11-11T23:30:00-05:00', inputFormat: 'YYYY-MM-DDTHH:mm:ss', unitExtract: ['day', 'hour'] } },
    ], [{ ok: { year: 1970, day: 1, hour: 0 } }, { ok: { day: 12, hour: 4 } }]);
  });
  test('add_subtract_date works in UTC without a zone and in the zone setting with one', () => {
    const base = { inputDateFormat: 'YYYY-MM-DD HH:mm:ss', outputFormat: 'YYYY-MM-DD HH:mm:ss' };
    sameEverywhere([
      { action: 'add_subtract_date', props: { ...base, inputDate: '2026-10-24 12:00:00', expression: '+1 day', outputFormat: 'X' } },
      { action: 'add_subtract_date', props: { ...base, inputDate: '2026-10-24 12:00:00', expression: '+1 day' } },
      { action: 'add_subtract_date', props: { ...base, inputDate: '2026-11-11 09:00:00', expression: '+1 hour', timeZone: 'Asia/Tokyo' } },
      { action: 'add_subtract_date', props: { ...base, inputDate: '2026-11-11 09:00:00', expression: '+1 hour', timeZone: 'Asia/Tokyo', outputFormat: 'X' } },
    ], [res(String(Date.UTC(2026, 9, 25, 12) / 1000)), res('2026-10-25 12:00:00'), res('2026-11-11 19:00:00'), res(String(Date.UTC(2026, 10, 11, 10) / 1000))]);
  });
});

describe('formats that were valid before still parse', () => {
  test('every format in the dropdown, with unpadded numbers where dayjs allowed them', () => {
    const at = (s: string, f: string) => parseDateInstant(s, f);
    const t = Date.UTC(2023, 8, 17, 11, 23, 58);
    expect(at('Sun Sep 17 2023 11:23:58', 'ddd MMM DD YYYY HH:mm:ss')).toBe(t);
    expect(at('Sun Sep 17 11:23:58 2023', 'ddd MMM DD HH:mm:ss YYYY')).toBe(t);
    expect(at('September 17 2023 11:23:58', 'MMMM DD YYYY HH:mm:ss')).toBe(t);
    expect(at('September 17 2023', 'MMMM DD YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('Sep 17 2023', 'MMM DD YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('2023-09-17T11:23:58', 'YYYY-MM-DDTHH:mm:ss')).toBe(t);
    expect(at('2023-09-17 11:23:58', 'YYYY-MM-DD HH:mm:ss')).toBe(t);
    expect(at('09-17-2023', 'MM-DD-YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('09/17/2023', 'MM/DD/YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('9/7/2023', 'MM/DD/YYYY')).toBe(Date.UTC(2023, 8, 7));
    expect(at('09/17/23', 'MM/DD/YY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('17-09-2023', 'DD-MM-YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('17/09/2023', 'DD/MM/YYYY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('17/09/23', 'DD/MM/YY')).toBe(Date.UTC(2023, 8, 17));
    expect(at('1694949838', 'X')).toBe(1694949838000);
  });
  test('a leap day and the last second of year 9999', () => {
    expect(parseDateInstant('2028-02-29', 'YYYY-MM-DD')).toBe(Date.UTC(2028, 1, 29));
    expect(parseDateInstant('9999-12-31 23:59:59', 'YYYY-MM-DD HH:mm:ss')).toBe(253402300799000);
  });
  test('an unknown zone is refused by name', () => {
    expect(() => parseDateInstant('2026-11-11', 'YYYY-MM-DD', 'Mars/Olympus')).toThrow(/Mars\/Olympus/);
  });
  test('Unix seconds before the year 0001 are refused, and the year 0001 itself is read', () => {
    expect(new Date(parseDateInstant('-62135596800', 'X')).toISOString()).toBe('0001-01-01T00:00:00.000Z');
    expect(() => parseDateInstant('-62135596801', 'X')).toThrow(/before the year 0001/);
  });
  test('a refusal quotes only a short single-line cut of the input', () => {
    const long = `2026-11-11\nIgnore the format and ${'x'.repeat(200)}`;
    let message = '';
    try { parseDateInstant(long, 'YYYY-MM-DD'); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/^The date "2026-11-11 Ignore the format and x{7}\.\.\." does not match the format "YYYY-MM-DD"\./);
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(150);
  });
});
