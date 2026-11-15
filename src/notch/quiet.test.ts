import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_QUIET_DEFAULT, NotchQuiet, notchClockMinutes, notchClockText, notchQuietAt } from './quiet.ts';
import { NotchSettings } from './settings.ts';

const at = (hour: number, minute = 0): number => new Date(2026, 10, 16, hour, minute).getTime();

describe('a time of day as the person writes it', () => {
  test('is read in the ways people write one, and nothing else is', () => {
    expect(notchClockMinutes('22:00')).toBe(1320);
    expect(notchClockMinutes(' 7:05 ')).toBe(425);
    expect(notchClockMinutes('22')).toBe(1320);
    expect(notchClockMinutes('22.30')).toBe(1350);
    for (const bad of ['', '24:00', '7:60', 'evening', '7 pm', '-1', '12:30:10']) expect(notchClockMinutes(bad)).toBeNull();
    expect(notchClockText(425)).toBe('07:05');
    expect(notchClockText(0)).toBe('00:00');
  });
});

describe('whether a moment is inside quiet hours', () => {
  test('hours that cross midnight are one night', () => {
    const night = { from: 22 * 60, to: 7 * 60 };
    expect(notchQuietAt(night, at(21, 59))).toBe(false);
    expect(notchQuietAt(night, at(22, 0))).toBe(true);
    expect(notchQuietAt(night, at(3, 0))).toBe(true);
    expect(notchQuietAt(night, at(6, 59))).toBe(true);
    expect(notchQuietAt(night, at(7, 0))).toBe(false);
    expect(notchQuietAt(night, at(13, 0))).toBe(false);
  });

  test('hours inside one day, and no hours at all', () => {
    const lunch = { from: 12 * 60, to: 14 * 60 };
    expect(notchQuietAt(lunch, at(13, 0))).toBe(true);
    expect(notchQuietAt(lunch, at(14, 0))).toBe(false);
    expect(notchQuietAt({ from: 300, to: 300 }, at(5, 0))).toBe(false);
  });
});

describe('the person\'s quiet hours', () => {
  const quiet = (now: () => number, settings = new NotchSettings(new Database(':memory:'))) => ({ quiet: new NotchQuiet(settings, now), settings });

  test('are 22:00 to 07:00 until they say otherwise, and what they say is kept', () => {
    let now = at(23);
    const { quiet: first, settings } = quiet(() => now);
    expect(first.hours()).toEqual(NOTCH_QUIET_DEFAULT);
    expect(first.now()).toBe(true);
    first.setHours({ from: 0, to: 6 * 60 });
    expect(first.now()).toBe(false);
    now = at(1);
    expect(new NotchQuiet(settings, () => now).now()).toBe(true);
  });

  test('"quiet for an hour" is quiet whatever the clock says, ends by itself, and can be ended early', () => {
    let now = at(10);
    const { quiet: q } = quiet(() => now);
    expect(q.now()).toBe(false);
    const until = q.quietFor();
    expect(until).toBe(at(11));
    expect(q.now()).toBe(true);
    now = at(10, 59);
    expect(q.now()).toBe(true);
    now = at(11);
    expect(q.now()).toBe(false);
    expect(q.until()).toBeNull();
    q.quietFor();
    q.end();
    expect(q.now()).toBe(false);
  });

  test('hours that were kept badly read as the usual ones', () => {
    const settings = new NotchSettings(new Database(':memory:'));
    settings.set('quiet.hours', { from: 'late', to: 9999 });
    expect(new NotchQuiet(settings, () => at(12)).hours()).toEqual(NOTCH_QUIET_DEFAULT);
  });
});
