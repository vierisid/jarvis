import { describe, expect, test } from 'bun:test';
import {
  bannerFor,
  barWidthPct,
  formatPct,
  formatResetIn,
  meterTone,
  WARN_PCT,
  type HostedMeter,
} from './hosted-budget.ts';

const meter = (over: Partial<HostedMeter> = {}): HostedMeter => ({
  entitled: true,
  blocked: false,
  sessionPct: 10,
  weekPct: 10,
  sessionResetsAt: '2026-08-26T12:00:00.000Z',
  weekResetsAt: '2026-08-31T00:00:00.000Z',
  ...over,
});

const NOW = Date.parse('2026-08-26T09:30:00.000Z');

describe('meter tone', () => {
  test('turns at the SAME threshold the daemon notifies on', () => {
    // If these drift, a user gets an OS notification while the room still
    // shows a calm bar, or the reverse.
    expect(meterTone(WARN_PCT - 0.1)).toBe('mut');
    expect(meterTone(WARN_PCT)).toBe('hold');
    expect(meterTone(100)).toBe('fail');
  });

  test('BLOCKED is fail regardless of the percentage', () => {
    // The proxy enforces a rolling 7d while we display a Monday-aligned week,
    // so it can refuse at a percentage that looks fine.
    expect(meterTone(4, true)).toBe('fail');
    expect(meterTone(null, true)).toBe('fail');
  });

  test('an UNKNOWN reading is not a warning', () => {
    expect(meterTone(null)).toBe('mut');
  });
});

describe('rendering a reading', () => {
  test('null reads as unavailable and draws an EMPTY bar, never a full-looking zero', () => {
    expect(formatPct(null)).toBe('unavailable');
    expect(barWidthPct(null)).toBe(0);
  });

  test('an overshoot keeps its true number in the label but clamps the bar', () => {
    // max_budget can be exceeded by the request that crosses it, so >100 is a
    // real state; a silently capped "100%" would hide it.
    expect(formatPct(104.4)).toBe('104%');
    expect(barWidthPct(104.4)).toBe(100);
  });
});

describe('reset countdown', () => {
  test('reads in the units the window actually has', () => {
    expect(formatResetIn('2026-08-26T12:00:00.000Z', NOW)).toBe('resets in 2h 30m');
    expect(formatResetIn('2026-08-31T00:00:00.000Z', NOW)).toBe('resets in 4d 14h');
    expect(formatResetIn('2026-08-26T09:44:00.000Z', NOW)).toBe('resets in 14m');
  });

  test('a reset already PAST is "resetting…", never a negative countdown', () => {
    // Both sides cache the meter for up to a minute, so the boundary routinely
    // passes while a reading is still being served. That is not an error.
    expect(formatResetIn('2026-08-26T09:29:00.000Z', NOW)).toBe('resetting…');
    expect(formatResetIn('2026-08-26T09:30:00.000Z', NOW)).toBe('resetting…');
  });

  test('never rounds down to a stuck-looking "0m"', () => {
    expect(formatResetIn('2026-08-26T09:30:20.000Z', NOW)).toBe('resets in 1m');
  });

  test('an unparseable stamp renders nothing rather than "NaN"', () => {
    expect(formatResetIn('not a date', NOW)).toBe('');
  });
});

describe('banner', () => {
  test('silent below the threshold', () => {
    expect(bannerFor(meter())).toBeNull();
    expect(bannerFor(null)).toBeNull();
  });

  test('a user with no plan gets no banner and no meter', () => {
    // Not entitled is not "used up" — there is no window at all.
    expect(bannerFor(meter({ entitled: false, blocked: true }))).toBeNull();
  });

  test('names WHICH window is hot, and both when both are', () => {
    expect(bannerFor(meter({ sessionPct: 80 }))?.text).toContain('this 6-hour window');
    expect(bannerFor(meter({ weekPct: 91 }))?.text).toContain('this week');
    const both = bannerFor(meter({ sessionPct: 80, weekPct: 91 }))!;
    expect(both.text).toContain('this 6-hour window and this week');
    expect(both.tone).toBe('hold');
  });

  test('BLOCKED wins over the percentages', () => {
    // The whole reason the banner keys off `blocked`: the proxy can be
    // refusing while our Monday-aligned week still shows headroom, and the
    // room must not tell a user they have room they do not have.
    const b = bannerFor(meter({ blocked: true, sessionPct: 3, weekPct: 3 }))!;
    expect(b.tone).toBe('fail');
    expect(b.text).toContain('used up');
  });

  test('an unreadable session window alone does not raise a banner', () => {
    expect(bannerFor(meter({ sessionPct: null }))).toBeNull();
    // …but a hot week still does.
    expect(bannerFor(meter({ sessionPct: null, weekPct: 88 }))?.text).toContain('this week');
  });
});
