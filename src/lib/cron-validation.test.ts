import { afterEach, expect, test } from 'bun:test';
import { CronScheduler, setCronTimezone, validateCronExpression } from './cron-scheduler';

afterEach(() => setCronTimezone(null));
for (const expression of ['60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '4-1 * * * *', '1junk * * * *', '1//2 * * * *', '@every 0s', 'bad cron', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 2 1']) {
  test(`rejects invalid schedule ${expression}`, () => {
    expect(() => validateCronExpression(expression)).toThrow();
    const scheduler = new CronScheduler();
    try { expect(() => scheduler.schedule('invalid', expression, () => {})).toThrow(); }
    finally { scheduler.cancelAll(); }
  });
}
for (const zone of [null, 'UTC', 'America/New_York']) {
  test(`Sunday 7 matches, schedules and advances like 0 (${zone ?? 'local'})`, () => {
    setCronTimezone(zone);
    const sunday = zone === null ? new Date(2026, 8, 27, 9) : new Date(zone === 'UTC' ? '2026-09-27T09:00:00Z' : '2026-09-27T13:00:00Z');
    for (const dow of ['7', '0,7', '1-7', '5-7', '1-7/2', '7/1']) {
      const expression = `0 9 * * ${dow}`;
      expect(() => validateCronExpression(expression)).not.toThrow();
      expect(CronScheduler.matches(expression, sunday)).toBe(true);
      const from = new Date(sunday.getTime() - 60_000);
      expect(CronScheduler.nextRun(expression, from)?.getTime()).toBe(sunday.getTime());
      const scheduler = new CronScheduler();
      try { scheduler.schedule('sunday', expression, () => {}); expect(scheduler.getJobs()).toHaveLength(1); }
      finally { scheduler.cancelAll(); }
    }
    expect(CronScheduler.matches('0 9 * * 0-7/2', sunday)).toBe(true);
    expect(CronScheduler.matches('0 9 * * 1-7/3', sunday)).toBe(true);
    expect(CronScheduler.nextRun('0 9 * * 7', sunday)?.getTime()).toBe(CronScheduler.nextRun('0 9 * * 0', sunday)?.getTime());
  });
}

test('a leap day is accepted, and its next time is found however far away it is', () => {
  for (const zone of [null, 'UTC', 'America/New_York']) {
    setCronTimezone(zone);
    expect(() => validateCronExpression('0 0 29 2 *')).not.toThrow();
    const from = new Date('2026-11-11T12:00:00Z');
    const next = CronScheduler.nextRun('0 0 29 2 *', from);
    expect(next).not.toBeNull();
    expect(next!.getTime() - from.getTime()).toBeGreaterThan(366 * 24 * 60 * 60_000);
    expect(next!.getTime()).toBeGreaterThan(Date.parse('2028-02-28T00:00:00Z'));
    expect(next!.getTime()).toBeLessThan(Date.parse('2028-03-01T12:00:00Z'));
  }
});

test('a leap day across the 2100 century gap (eight years) is still found', () => {
  setCronTimezone('UTC');
  expect(CronScheduler.nextRun('0 0 29 2 *', new Date('2096-03-01T00:00:00Z'))?.toISOString()).toBe('2104-02-29T00:00:00.000Z');
});

test('a leap day that must fall on a Monday is found, though it is decades away', () => {
  setCronTimezone('UTC');
  expect(CronScheduler.nextRun('0 0 29 2 1', new Date('2026-11-11T12:00:00Z'))?.toISOString()).toBe('2044-02-29T00:00:00.000Z');
});

test('a schedule that can never fire is refused with a plain message', () => {
  expect(() => validateCronExpression('0 0 31 2 *')).toThrow('Invalid cron expression: selected days do not exist in the selected months');
  expect(() => validateCronExpression('0 0 LW * 0,6')).toThrow('Invalid cron expression: LW never falls on the selected days of the week');
});
