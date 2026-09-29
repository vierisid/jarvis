import { afterEach, expect, test } from 'bun:test';
import { CronScheduler, setCronTimezone, validateCronExpression } from './cron-scheduler';

afterEach(() => setCronTimezone(null));
for (const expression of ['60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '4-1 * * * *', '1junk * * * *', '1//2 * * * *', '@every 0s', 'bad cron', '0 0 31 2 *']) {
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
