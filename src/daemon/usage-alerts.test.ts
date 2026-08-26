import { describe, expect, test } from 'bun:test';
import type { HostedUsageMeter } from './hosted-usage.ts';
import {
  alertKey,
  decideUsageAlerts,
  FLAG_PREFIX,
  staleFlagKeys,
  WARN_PCT,
  type UsageAlert,
} from './usage-alerts.ts';

const SESSION_RESET = '2026-08-26T12:00:00.000Z';
const WEEK_RESET = '2026-08-31T00:00:00.000Z';

const meter = (over: Partial<HostedUsageMeter> = {}): HostedUsageMeter => ({
  entitled: true,
  blocked: false,
  sessionPct: 10,
  weekPct: 10,
  sessionResetsAt: SESSION_RESET,
  weekResetsAt: WEEK_RESET,
  ...over,
});

/** A store that behaves like the settings table, without SQLite. */
function fakeStore(initial: string[] = []) {
  const seen = new Set(initial);
  return {
    seen,
    delivered: (k: string) => seen.has(k),
    record: (alerts: UsageAlert[]) => alerts.forEach((a) => seen.add(a.key)),
  };
}

describe('deciding which warnings are due', () => {
  test('silent below the threshold', () => {
    const s = fakeStore();
    expect(decideUsageAlerts(meter(), s.delivered)).toEqual([]);
  });

  test('fires at the threshold, once, and NOT again on the next check', () => {
    const s = fakeStore();
    const first = decideUsageAlerts(meter({ sessionPct: WARN_PCT }), s.delivered);
    expect(first).toHaveLength(1);
    expect(first[0]!.window).toBe('session');
    expect(first[0]!.level).toBe(75);
    s.record(first);
    // Same window, higher but still under 100 — already warned.
    expect(decideUsageAlerts(meter({ sessionPct: 92 }), s.delivered)).toEqual([]);
  });

  test('a RESTART inside the window does not re-fire', () => {
    // The whole reason the flag is persisted rather than held in a Set: the
    // daemon bounces (upgrade, crash, laptop lid) inside a six-hour window.
    const s = fakeStore([alertKey('session', 75, SESSION_RESET)]);
    expect(decideUsageAlerts(meter({ sessionPct: 80 }), s.delivered)).toEqual([]);
  });

  test('a NEW window fires again, with no cleanup needed', () => {
    // The stamp is part of the key, so the old flag simply cannot match.
    const s = fakeStore([alertKey('session', 75, SESSION_RESET)]);
    const next = decideUsageAlerts(
      meter({ sessionPct: 80, sessionResetsAt: '2026-08-26T18:00:00.000Z' }),
      s.delivered,
    );
    expect(next).toHaveLength(1);
  });

  test('crossing BOTH thresholds between checks sends one notification, not two', () => {
    // 40% → full in a single 15-minute gap is ordinary on a small plan; a
    // "running low" toast immediately followed by "used up" is noise.
    const out = decideUsageAlerts(meter({ sessionPct: 100 }), fakeStore().delivered);
    expect(out).toHaveLength(1);
    expect(out[0]!.level).toBe(100);
  });

  test('having warned at 75 does not suppress the later "used up"', () => {
    const s = fakeStore([alertKey('session', 75, SESSION_RESET)]);
    const out = decideUsageAlerts(meter({ sessionPct: 100 }), s.delivered);
    expect(out).toHaveLength(1);
    expect(out[0]!.level).toBe(100);
  });

  test('the two windows are independent', () => {
    const both = decideUsageAlerts(meter({ sessionPct: 80, weekPct: 100 }), fakeStore().delivered);
    expect(both.map((a) => `${a.window}:${a.level}`).sort()).toEqual(['session:75', 'week:100']);
  });

  test('names the window in copy the user can act on', () => {
    const [a] = decideUsageAlerts(meter({ weekPct: 100 }), fakeStore().delivered);
    expect(a!.body).toContain('this week');
    expect(a!.title).toBe('Included AI usage used up');
  });
});

describe('states that must NOT produce a warning', () => {
  test('no reading at all', () => {
    // An unreachable control plane is not 0% (silent) and not 100% (a false
    // alarm at 3am). It produces nothing and the next check retries.
    expect(decideUsageAlerts(null, fakeStore().delivered)).toEqual([]);
  });

  test('a hosted user with no plan', () => {
    expect(decideUsageAlerts(meter({ entitled: false, blocked: true }), fakeStore().delivered)).toEqual([]);
  });

  test('an unreadable session window is not a signal either way', () => {
    // sessionPct is null when the control plane could not reach the proxy.
    expect(decideUsageAlerts(meter({ sessionPct: null }), fakeStore().delivered)).toEqual([]);
    // The week is still readable and still warns.
    expect(decideUsageAlerts(meter({ sessionPct: null, weekPct: 99 }), fakeStore().delivered)).toHaveLength(1);
  });
});

describe('a key that is switched off', () => {
  test('warns, and does NOT call it "used up"', () => {
    // The control plane sets `blocked` for a user with no plan or a converge
    // that failed part-way — never for spending too much. Since !entitled has
    // already returned, this is a paying user whose assistant does not work.
    // Blaming their usage would send them to a meter reading 3%.
    const out = decideUsageAlerts(meter({ blocked: true, sessionPct: 3, weekPct: 3 }), fakeStore().delivered);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).not.toContain('used up');
    expect(out[0]!.title).toBe('AI is temporarily unavailable');
    expect(out[0]!.key).toBe(`${FLAG_PREFIX}blocked.${SESSION_RESET}`);
  });

  test('stays quiet when a FULL window already explains the refusal', () => {
    const out = decideUsageAlerts(meter({ blocked: true, sessionPct: 100 }), fakeStore().delivered);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe(alertKey('session', 100, SESSION_RESET));
  });

  test('a 75% alert in the same pass does NOT suppress it', () => {
    // "Running low" while nothing works at all is worse than saying nothing:
    // the user reads it as a warning they still have room. Only a window that
    // is actually full explains a refusal.
    const out = decideUsageAlerts(meter({ blocked: true, sessionPct: 80 }), fakeStore().delivered);
    expect(out.map((a) => a.key).sort()).toEqual(
      [`${FLAG_PREFIX}blocked.${SESSION_RESET}`, alertKey('session', 75, SESSION_RESET)].sort(),
    );
  });

  test('repeats at most once per session window while it lasts', () => {
    const s = fakeStore([`${FLAG_PREFIX}blocked.${SESSION_RESET}`]);
    expect(decideUsageAlerts(meter({ blocked: true, sessionPct: 3 }), s.delivered)).toEqual([]);
  });
});

describe('pruning', () => {
  test('keeps the live windows and drops the rest', () => {
    // Keys are only ever added, so without this a long-lived install grows a
    // settings row per window forever.
    const all = [
      alertKey('session', 75, SESSION_RESET),
      alertKey('week', 100, WEEK_RESET),
      alertKey('session', 75, '2026-08-26T06:00:00.000Z'),
      `${FLAG_PREFIX}blocked.2026-01-01T00:00:00.000Z`,
      'llm.provider.default',
    ];
    expect(staleFlagKeys(all, meter())).toEqual([
      alertKey('session', 75, '2026-08-26T06:00:00.000Z'),
      `${FLAG_PREFIX}blocked.2026-01-01T00:00:00.000Z`,
    ]);
  });

  test('never touches a setting that is not one of ours', () => {
    expect(staleFlagKeys(['llm.provider.default', 'voice.realtime.month'], meter())).toEqual([]);
  });
});
