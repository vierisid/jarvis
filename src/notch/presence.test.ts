import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_AWAY_MS, NOTCH_MORNING_AWAY_MS, NotchPresence, notchDayOf } from './presence.ts';
import { NotchSettings } from './settings.ts';

const MIN = 60_000;
/** A Monday at 09:00, on this machine's clock. */
const NINE = new Date(2026, 10, 16, 9, 0).getTime();

function harness(start = NINE, settings = new NotchSettings(new Database(':memory:'))) {
  let now = start;
  const told: string[] = [];
  const timers: { fn: () => void; at: number }[] = [];
  const presence = new NotchPresence({
    settings,
    calm: () => told.push('calm'),
    left: (at) => told.push(`left ${Math.round((at - start) / MIN)}`),
    back: (away) => told.push(`back ${Math.round(away.ms / MIN)}`),
    morning: (away) => told.push(`morning ${Math.round(away.ms / MIN)}`),
    now: () => now,
    clock: {
      setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
      clearTimeout: (handle) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
    },
    log: () => {},
  });
  const pass = (ms: number): void => {
    now += ms;
    for (const timer of [...timers].filter((entry) => entry.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
  };
  return { presence, told, pass, settings, at: () => now };
}

describe('the settings the notch keeps', () => {
  test('a value is kept by name, replaced, and read back after the database is opened again', () => {
    const db = new Database(':memory:');
    const settings = new NotchSettings(db);
    expect(settings.get('quiet', { from: 1 })).toEqual({ from: 1 });
    settings.set('quiet', { from: 22 });
    settings.set('quiet', { from: 23 });
    expect(new NotchSettings(db).get<{ from: number } | null>('quiet', null)).toEqual({ from: 23 });
    db.run(`UPDATE notch_settings SET value = 'not json' WHERE name = 'quiet'`);
    expect(settings.get('quiet', 'fallback')).toBe('fallback');
  });
});

describe('which day a moment belongs to', () => {
  test('a day begins at five in the morning', () => {
    expect(notchDayOf(new Date(2026, 10, 16, 9, 0).getTime())).toBe('2026-11-16');
    expect(notchDayOf(new Date(2026, 10, 17, 1, 30).getTime())).toBe('2026-11-16');
    expect(notchDayOf(new Date(2026, 10, 17, 5, 0).getTime())).toBe('2026-11-17');
  });
});

describe('whether the person is there', () => {
  test('nothing is held back before the desktop app has said anything', () => {
    const { presence } = harness();
    expect(presence.still()).toBe(true);
    expect(presence.isAway()).toBe(false);
  });

  test('hands on is not calm, hands off for four seconds is, and it is told when it changes', () => {
    const { presence, told, settings } = harness();
    settings.set('presence.morning', notchDayOf(NINE));
    presence.hands(false);
    expect(presence.still()).toBe(false);
    presence.hands(true);
    presence.hands(true);
    expect(presence.still()).toBe(true);
    expect(told).toEqual(['calm']);
  });

  test('still for twenty minutes is away, and hands on again is back, with how long', () => {
    const { presence, told, pass, settings } = harness();
    settings.set('presence.morning', notchDayOf(NINE));
    presence.hands(false);
    presence.hands(true);
    pass(NOTCH_AWAY_MS - 1);
    expect(presence.isAway()).toBe(false);
    pass(1);
    expect(presence.isAway()).toBe(true);
    pass(15 * MIN);
    presence.hands(false);
    expect(presence.isAway()).toBe(false);
    expect(told).toEqual(['calm', 'left 0', 'back 35']);
  });

  test('a pause shorter than that is neither away nor back', () => {
    const { presence, told, pass, settings } = harness();
    settings.set('presence.morning', notchDayOf(NINE));
    presence.hands(false);
    presence.hands(true);
    pass(5 * MIN);
    presence.hands(false);
    pass(30 * MIN);
    expect(told).toEqual(['calm']);
  });

  test('the first time they are there today is the morning, once, and it is not also a return', () => {
    const { presence, told, pass } = harness();
    // The brain has just started and knows nothing of before.
    presence.hands(false);
    expect(told).toEqual(['morning 0']);
    presence.hands(true);
    pass(NOTCH_MORNING_AWAY_MS + MIN);
    presence.hands(false);
    // Later the same day: a return, not a second morning.
    expect(told).toEqual(['morning 0', 'calm', 'left 0', 'back 61']);
  });

  // The brain is often started before the person sits down: the first word it hears is "still".
  test('a brain that started while they were out says the morning when they first sit down, however soon', () => {
    const { presence, told, pass } = harness();
    presence.hands(true);
    pass(10 * MIN);
    presence.hands(false);
    expect(told).toEqual(['calm', 'morning 10']);
  });

  test('the morning is remembered across a restart of the brain, and comes again the next day after a night away', () => {
    const settings = new NotchSettings(new Database(':memory:'));
    const first = harness(NINE, settings);
    first.presence.hands(false);
    // The line was on the notch: that is what is remembered.
    first.presence.morningSaid();
    const restarted = harness(NINE + 2 * 60 * MIN, settings);
    restarted.presence.hands(false);
    expect(restarted.told).toEqual([]);
    restarted.presence.hands(true);
    restarted.pass(20 * 60 * MIN);
    restarted.presence.hands(false);
    expect(restarted.told).toEqual(['calm', 'left 0', 'morning 1200']);
  });

  // The hardening audit, 17 November 2026: the morning was written down when
  // its line was queued. A brain that restarted while the line still waited
  // for a still moment said no morning line that day.
  test('a morning whose line was never said is told again after a restart, and only once without one', () => {
    const settings = new NotchSettings(new Database(':memory:'));
    const first = harness(NINE, settings);
    first.presence.hands(false);
    expect(first.told).toEqual(['morning 0']);
    // Hands off and on again, the same morning, the line still waiting: not told twice.
    first.presence.hands(true);
    first.presence.hands(false);
    expect(first.told.filter((entry) => entry.startsWith('morning'))).toHaveLength(1);
    // The brain restarts before the line was said.
    const restarted = harness(NINE + 10 * MIN, settings);
    restarted.presence.hands(false);
    expect(restarted.told).toEqual(['morning 0']);
    // Said now: after the next restart there is none.
    restarted.presence.morningSaid();
    const again = harness(NINE + 30 * MIN, settings);
    again.presence.hands(false);
    expect(again.told).toEqual([]);
  });

  test('how long the hands have been still is known, and their coming back is told', () => {
    const seen: string[] = [];
    let now = NINE;
    const presence = new NotchPresence({ settings: new NotchSettings(new Database(':memory:')), now: () => now, hands: () => seen.push('hands'), log: () => {},
      clock: { setTimeout: () => ({}), clearTimeout: () => {} } });
    expect(presence.stillFor()).toBe(0);
    presence.hands(true);
    now += 3 * MIN;
    expect(presence.stillFor()).toBe(3 * MIN);
    presence.hands(false);
    expect(presence.stillFor()).toBe(0);
    expect(seen).toEqual(['hands']);
  });

  test('someone still at work after midnight is not wished a good morning at one', () => {
    const { presence, told, pass, settings } = harness(new Date(2026, 10, 16, 23, 0).getTime());
    settings.set('presence.morning', '2026-11-16');
    presence.hands(false);
    presence.hands(true);
    pass(90 * MIN);
    presence.hands(false);
    expect(told).toEqual(['calm', 'left 0', 'back 90']);
  });
});
