import { test, expect, describe, afterEach } from 'bun:test';
import { CronScheduler, setCronTimezone, getCronTimezone } from './cron-scheduler.ts';

describe('cron timezone', () => {
  afterEach(() => {
    setCronTimezone(null);
  });

  test('setCronTimezone validates IANA names', () => {
    setCronTimezone('America/New_York');
    expect(getCronTimezone()).toBe('America/New_York');
    expect(() => setCronTimezone('Mars/Olympus_Mons')).toThrow();
    setCronTimezone(null);
    expect(getCronTimezone()).toBeNull();
  });

  test('matches evaluates the WALL CLOCK of the configured zone, not the host', () => {
    // 2026-07-03 11:00:00 UTC = 07:00 in New York (EDT, UTC-4).
    const utcMoment = new Date('2026-07-03T11:00:00Z');

    setCronTimezone('America/New_York');
    expect(CronScheduler.matches('0 7 * * *', utcMoment)).toBe(true);
    expect(CronScheduler.matches('0 11 * * *', utcMoment)).toBe(false);

    // Same instant in Kolkata (UTC+5:30, a :30 offset zone) is 16:30.
    setCronTimezone('Asia/Kolkata');
    expect(CronScheduler.matches('30 16 * * *', utcMoment)).toBe(true);
    expect(CronScheduler.matches('0 7 * * *', utcMoment)).toBe(false);
  });

  test('day-of-week fields follow the zone (it can be tomorrow in Tokyo)', () => {
    // 2026-07-03 is a Friday; at 23:00 UTC it is already Saturday 08:00 in Tokyo.
    const utcMoment = new Date('2026-07-03T23:00:00Z');
    setCronTimezone('Asia/Tokyo');
    expect(CronScheduler.matches('0 8 * * 6', utcMoment)).toBe(true); // Saturday in Tokyo
    expect(CronScheduler.matches('0 8 * * 5', utcMoment)).toBe(false);
  });

  test('nextRun returns the next wall-clock firing as a UTC instant', () => {
    setCronTimezone('America/New_York');
    // From 2026-07-03 12:00 UTC (08:00 EDT), next "0 20 * * *" (8pm NY) is
    // 2026-07-04 00:00 UTC.
    const next = CronScheduler.nextRun('0 20 * * *', new Date('2026-07-03T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  test('nextRun crosses the fall-back DST transition correctly', () => {
    setCronTimezone('America/New_York');
    // US DST ends 2026-11-01 02:00 EDT (06:00 UTC). Morning cron the day
    // after the shift: 7am EST = 12:00 UTC (was 11:00 UTC in EDT).
    const before = CronScheduler.nextRun('0 7 * * *', new Date('2026-10-31T08:00:00Z'));
    expect(before?.toISOString()).toBe('2026-10-31T11:00:00.000Z'); // still EDT (UTC-4)
    const after = CronScheduler.nextRun('0 7 * * *', new Date('2026-11-01T12:00:00Z'));
    expect(after?.toISOString()).toBe('2026-11-02T12:00:00.000Z'); // now EST
  });

  test('nextRun crosses the spring-forward transition (2:30am does not exist)', () => {
    setCronTimezone('America/New_York');
    // US DST starts 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30 never
    // occurs that day. The next 02:30 wall time is March 9 (EDT, 06:30 UTC).
    const next = CronScheduler.nextRun('30 2 * * *', new Date('2026-03-08T01:00:00-05:00'));
    expect(next?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  test('without a timezone, behavior is unchanged (machine local time)', () => {
    const now = new Date();
    const expr = `${now.getMinutes()} ${now.getHours()} * * *`;
    expect(CronScheduler.matches(expr, now)).toBe(true);
  });
});
