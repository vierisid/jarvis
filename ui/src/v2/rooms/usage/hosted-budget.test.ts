import { describe, expect, test } from 'bun:test';
import {
  applyBudgetProbe,
  bannerFor,
  classifyBudgetResponse,
  barWidthPct,
  formatPct,
  formatResetIn,
  meterTone,
  WARN_PCT,
  type BudgetView,
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

  test('a BLOCKED key does not repaint a window that is nearly empty', () => {
    // `blocked` means the key is switched off (no plan, or a converge gap) —
    // not that this window is full. Painting a 4% bar red would contradict the
    // number printed beside it; the block state is the banner's job.
    expect(meterTone(4)).toBe('mut');
    expect(meterTone(null)).toBe('mut');
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

  test('a blocked key reads as OUR fault, not as the user being out of usage', () => {
    // The control plane sets `blocked` for a user with no plan (filtered out
    // above) or a converge that failed part-way — never for spending too much.
    // "Used up" would send someone to a meter reading 3% and blame them for it.
    const b = bannerFor(meter({ blocked: true, sessionPct: 3, weekPct: 3 }))!;
    expect(b.tone).toBe('fail');
    expect(b.text).not.toContain('used up');
    expect(b.text).toContain('being fixed on our side');
  });

  test('an unreadable session window alone does not raise a banner', () => {
    expect(bannerFor(meter({ sessionPct: null }))).toBeNull();
    // …but a hot week still does.
    expect(bannerFor(meter({ sessionPct: null, weekPct: 88 }))?.text).toContain('this week');
  });
});


describe('the hosted gate', () => {
  const hosted: BudgetView = { state: 'hosted', meter: meter() };
  const unknown: BudgetView = { state: 'unknown', meter: null };

  test('ONLY a 503 means self-hosted', () => {
    // It is the route's own hasUsejarvisAi guard. Nothing else is evidence
    // about which kind of install this is.
    expect(classifyBudgetResponse(503, null).kind).toBe('self');
    expect(classifyBudgetResponse(500, null).kind).toBe('failed');
    expect(classifyBudgetResponse(404, null).kind).toBe('failed');
    expect(classifyBudgetResponse(401, null).kind).toBe('failed');
  });

  test('a failure never demotes a hosted user to self-hosted', () => {
    // OnboardingWizard.tsx records the bug this exists to prevent: a probe that
    // read as self-hosted while it was merely slow. Here the cost is a hosted
    // user's meter disappearing for good — the poll stops on 'self'.
    expect(applyBudgetProbe(hosted, { kind: 'failed' })).toEqual(hosted);
    expect(applyBudgetProbe(unknown, { kind: 'failed' })).toEqual(unknown);
  });

  test('a 404 from a daemon older than the route does not read as self-hosted', () => {
    // Version skew during an upgrade: the UI ships before the daemon restarts.
    const after = applyBudgetProbe(hosted, classifyBudgetResponse(404, null));
    expect(after.state).toBe('hosted');
    expect(after.meter).toEqual(hosted.meter!);
  });

  test('hosted-but-unreadable KEEPS the last good meter', () => {
    // A minute-old reading beats a strip that flickers empty every time the
    // control plane hiccups.
    const probe = classifyBudgetResponse(200, { ok: false });
    expect(probe.kind).toBe('unreadable');
    expect(applyBudgetProbe(hosted, probe)).toEqual(hosted);
  });

  test('a reading promotes an unknown install and replaces the meter', () => {
    const fresh = meter({ weekPct: 77 });
    const after = applyBudgetProbe(unknown, classifyBudgetResponse(200, { ok: true, meter: fresh }));
    expect(after).toEqual({ state: 'hosted', meter: fresh });
  });

  test('a 200 with a missing meter is unreadable, not a reading', () => {
    // ok:true with no meter would otherwise set `meter: undefined` and render
    // a strip of blanks.
    expect(classifyBudgetResponse(200, { ok: true }).kind).toBe('unreadable');
    expect(classifyBudgetResponse(200, null).kind).toBe('unreadable');
  });

  test('self-hosted clears any meter it was holding', () => {
    expect(applyBudgetProbe(hosted, { kind: 'self' })).toEqual({ state: 'self', meter: null });
  });
});
