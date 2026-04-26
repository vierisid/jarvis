import { test, expect, describe } from 'bun:test';
import { parseRelativeDate } from './parse-date.ts';

/**
 * Phase 6.7.A — pin the relative-date parser used by the Calendar Room's
 * voice schedule_event action.
 *
 * All tests use a fixed `now` so they stay deterministic across day
 * boundaries (otherwise "tomorrow" would shift in CI runs near midnight).
 * Picked Tuesday 2026-04-28 12:00 local because it's mid-week and mid-day
 * — exercises both forward weekday wraparound and "next" semantics.
 */
const NOW = new Date(2026, 3, 28, 12, 0, 0).getTime(); // Tuesday 2026-04-28 12:00

function ymdhm(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('parseRelativeDate', () => {
  test('absolute ISO date with time', () => {
    const r = parseRelativeDate('2026-04-30 15:30', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-30 15:30');
    expect(r!.confidence).toBe(1);
  });

  test('absolute ISO date without time defaults to 09:00', () => {
    const r = parseRelativeDate('2026-04-30', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-30 09:00');
  });

  test('today at 3pm', () => {
    const r = parseRelativeDate('today at 3pm', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-28 15:00');
  });

  test('tomorrow morning defaults to 09:00', () => {
    const r = parseRelativeDate('tomorrow', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-29 09:00');
  });

  test('next tuesday is one week ahead, not the current tuesday', () => {
    const r = parseRelativeDate('next tuesday at 10am', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-05-05 10:00');
  });

  test('bare weekday picks the same day if today matches', () => {
    // NOW is a Tuesday → "tuesday" should resolve to TODAY at default time
    const r = parseRelativeDate('tuesday at 4pm', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-28 16:00');
  });

  test('bare weekday picks the next instance for a future day', () => {
    const r = parseRelativeDate('friday', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-05-01 09:00');
  });

  test('"in 3 days"', () => {
    const r = parseRelativeDate('in 3 days', NOW);
    expect(r).not.toBeNull();
    // 12:00 today + 3 days = 12:00 three days later
    expect(ymdhm(r!.ts)).toBe('2026-05-01 12:00');
  });

  test('"in 30 minutes"', () => {
    const r = parseRelativeDate('in 30 minutes', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-28 12:30');
  });

  test('bare time "3pm" assumes today (still in the future at 12:00 base)', () => {
    const r = parseRelativeDate('3pm', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-28 15:00');
  });

  test('bare time slides to tomorrow when already past', () => {
    const r = parseRelativeDate('9am', NOW);
    expect(r).not.toBeNull();
    // 9am on the same day is past 12:00 → shift to tomorrow
    expect(ymdhm(r!.ts)).toBe('2026-04-29 09:00');
  });

  test('24-hour time format', () => {
    const r = parseRelativeDate('today at 17:30', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-28 17:30');
  });

  test('garbage returns null', () => {
    expect(parseRelativeDate('whenever-ish', NOW)).toBeNull();
    expect(parseRelativeDate('', NOW)).toBeNull();
    expect(parseRelativeDate('mañana', NOW)).toBeNull();
  });

  test('case insensitive', () => {
    const r = parseRelativeDate('TOMORROW AT 2PM', NOW);
    expect(r).not.toBeNull();
    expect(ymdhm(r!.ts)).toBe('2026-04-29 14:00');
  });
});
