import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { LLMManager } from '../llm/manager.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createCapture } from '../vault/awareness.ts';
import { BehaviorAnalytics } from './analytics.ts';

// The reports must pick "today" and "this week" on the local calendar and key
// every day by its local date, in every zone and on both sides of UTC midnight.

const ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'];
// Instants near local midnight in one zone or another and on both sides of UTC midnight.
const INSTANTS = [
  '2026-11-13T23:30:00Z', // 08:30 Nov 14 in Tokyo, while UTC is still Nov 13
  '2026-11-14T00:30:00Z', // just after UTC midnight
  '2026-11-14T07:30:00Z', // 23:30 Nov 13 in Los Angeles, while UTC is already Nov 14
  '2026-11-14T08:30:00Z', // just after local midnight in Los Angeles
  '2026-11-14T14:30:00Z', // just before local midnight in Tokyo
  '2026-11-14T15:30:00Z', // 00:30 Nov 15 in Tokyo, while UTC is still Nov 14
];

const model = { async chatTier() { return { content: '- ok' }; } } as unknown as LLMManager;
const originalTz = process.env.TZ;

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => {
  setSystemTime();
  closeDb();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** The local calendar date of `at` in `zone`, worked out independently of the code under test. */
function localDate(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Local wall time on a local date, read in the zone set in TZ. */
function local(date: string, time: string): number {
  return new Date(`${date}T${time}`).getTime();
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Two minutes of captures in `app` starting at `start`. */
function activity(app: string, start: number): void {
  for (let i = 0; i <= 2; i++) createCapture({ timestamp: start + i * 60_000, pixelChangePct: 0.1, appName: app });
}

describe('generateDailyReport', () => {
  for (const zone of ZONES) {
    for (const instant of INSTANTS) {
      test(`reports the local day in ${zone} at ${instant}`, async () => {
        process.env.TZ = zone;
        const now = new Date(instant);
        setSystemTime(now);
        const today = localDate(now, zone);
        activity('Yesterday', local(shiftDate(today, -1), '23:50:00'));
        activity('Today', local(today, '00:00:00'));
        activity('Tomorrow', local(shiftDate(today, 1), '00:00:00'));

        const report = await new BehaviorAnalytics(model).generateDailyReport();
        expect(report.date).toBe(today);
        expect(report.appBreakdown.map(a => a.app)).toEqual(['Today']);
      });
    }

    test(`reads an explicit date as a local day in ${zone}`, async () => {
      process.env.TZ = zone;
      setSystemTime(new Date('2026-11-20T12:00:00Z'));
      activity('Before', local('2026-11-13', '23:50:00'));
      activity('Day', local('2026-11-14', '00:00:00'));
      activity('After', local('2026-11-15', '00:00:00'));

      const report = await new BehaviorAnalytics(model).generateDailyReport('2026-11-14');
      expect(report.date).toBe('2026-11-14');
      expect(report.appBreakdown.map(a => a.app)).toEqual(['Day']);
    });
  }
});

describe('generateWeeklyReport', () => {
  const WEEK = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];

  for (const zone of ZONES) {
    for (const instant of ['2026-11-09T00:30:00Z', '2026-11-12T12:00:00Z', '2026-11-15T23:30:00Z']) {
      test(`keys the current local week by local dates in ${zone} at ${instant}`, async () => {
        process.env.TZ = zone;
        const now = new Date(instant);
        setSystemTime(now);
        // The local Monday of the week holding `now`.
        const today = localDate(now, zone);
        const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
        const monday = shiftDate(today, -weekday);
        activity('Monday', local(monday, '00:00:00'));
        activity('Sunday', local(shiftDate(monday, 6), '23:56:00'));
        activity('Outside', local(shiftDate(monday, 7), '00:00:00'));

        const report = await new BehaviorAnalytics(model).generateWeeklyReport();
        const days = Array.from({ length: 7 }, (_, i) => shiftDate(monday, i));
        expect(report.weekStart).toBe(monday);
        expect(report.weekEnd).toBe(days[6]!);
        expect(report.dailyBreakdown.map(d => d.date)).toEqual(days);
        expect(report.dailyBreakdown[0]!.activeMinutes).toBe(2);
        expect(report.dailyBreakdown[6]!.activeMinutes).toBe(2);
        expect(report.topApps.map(a => a.app).sort()).toEqual(['Monday', 'Sunday']);
      });
    }

    test(`reads an explicit weekStart as a local Monday in ${zone}`, async () => {
      process.env.TZ = zone;
      setSystemTime(new Date('2026-11-20T12:00:00Z'));
      activity('Wednesday', local('2026-11-11', '12:00:00'));

      const report = await new BehaviorAnalytics(model).generateWeeklyReport('2026-11-09');
      expect(report.weekStart).toBe('2026-11-09');
      expect(report.weekEnd).toBe('2026-11-15');
      expect(report.dailyBreakdown.map(d => d.date)).toEqual(WEEK);
      expect(report.dailyBreakdown.map(d => d.activeMinutes)).toEqual([0, 0, 2, 0, 0, 0, 0]);
    });
  }

  test('counts the last hour of a 25-hour Sunday when the clocks go back', async () => {
    process.env.TZ = 'America/Los_Angeles'; // DST ends on Sunday 2026-11-01
    setSystemTime(new Date('2026-11-05T12:00:00Z'));
    activity('LateSunday', local('2026-11-01', '23:30:00'));

    const report = await new BehaviorAnalytics(model).generateWeeklyReport('2026-10-26');
    expect(report.weekEnd).toBe('2026-11-01');
    expect(report.topApps.map(a => a.app)).toEqual(['LateSunday']);
  });

  test('refuses a weekStart that is not a date', async () => {
    await expect(new BehaviorAnalytics(model).generateWeeklyReport('not-a-date')).rejects.toThrow('Invalid weekStart');
  });
});
