import { afterEach, test, expect, describe } from 'bun:test';
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

describe('every word of a time is read, or none of it is (#1035)', () => {
  test('a date followed by words that are not a time is null, not that date at 09:00', () => {
    for (const t of ['tuesday at 3', 'tomorrow at 3', 'at 3', 'next monday at half past', 'today-ish', 'monkey', 'later today', 'friday at sunset']) {
      expect([t, parseRelativeDate(t, NOW)]).toEqual([t, null]);
    }
  });

  test('a date or time no calendar has is null, not rolled over', () => {
    for (const t of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-04-30 24:00', '2026-04-30 15:60', '0026-04-30']) {
      expect([t, parseRelativeDate(t, NOW)]).toEqual([t, null]);
    }
    expect(ymdhm(parseRelativeDate('2028-02-29', NOW)!.ts)).toBe('2028-02-29 09:00');
  });

  test('every weekday is read whole, and the time after it', () => {
    const want: Record<string, string> = {
      sunday: '2026-05-03', monday: '2026-05-04', tuesday: '2026-04-28', wednesday: '2026-04-29',
      thursday: '2026-04-30', friday: '2026-05-01', saturday: '2026-05-02', tues: '2026-04-28', thur: '2026-04-30',
    };
    for (const [day, date] of Object.entries(want)) {
      expect([day, ymdhm(parseRelativeDate(`${day} at 3pm`, NOW)!.ts)]).toEqual([day, `${date} 15:00`]);
    }
  });

  test('the short forms, trailing punctuation and dotted am/pm read as before (#1035 review)', () => {
    const want: Record<string, string> = {
      thurs: '2026-04-30 09:00', weds: '2026-04-29 09:00', 'monday.': '2026-05-04 09:00', 'tuesday!': '2026-04-28 09:00',
      'tue,': '2026-04-28 09:00', 'friday at 5 p.m.': '2026-05-01 17:00', 'friday at 5pm.': '2026-05-01 17:00',
      friday3pm: '2026-05-01 15:00', 'thurs at 2pm': '2026-04-30 14:00', 'in 3 days.': '2026-05-01 12:00',
    };
    for (const [t, at] of Object.entries(want)) expect([t, ymdhm(parseRelativeDate(t, NOW)!.ts)]).toEqual([t, at]);
  });

  test('morning and noon are the times of day read', () => {
    expect(ymdhm(parseRelativeDate('tomorrow morning', NOW)!.ts)).toBe('2026-04-29 09:00');
    expect(ymdhm(parseRelativeDate('tomorrow at noon', NOW)!.ts)).toBe('2026-04-29 12:00');
    expect(ymdhm(parseRelativeDate('friday at midday', NOW)!.ts)).toBe('2026-05-01 12:00');
  });
});

describe('everyday phrases read with fixed defaults, and what is not read is refused (#1035)', () => {
  // NOW is Tuesday 2026-04-28 12:00.
  test('each accepted phrase lands where its default says', () => {
    const want: Record<string, string> = {
      'at 5pm': '2026-04-28 17:00', 'at 17:30': '2026-04-28 17:30', 'at noon': '2026-04-28 12:00', 'at midnight': '2026-04-29 00:00',
      '@ 5pm': '2026-04-28 17:00', 'this friday': '2026-05-01 09:00', 'on friday': '2026-05-01 09:00',
      'in an hour': '2026-04-28 13:00', 'in a minute': '2026-04-28 12:01', 'in half an hour': '2026-04-28 12:30', 'in a day': '2026-04-29 12:00',
      '3pm tomorrow': '2026-04-29 15:00', '9am tomorrow': '2026-04-29 09:00', '9am friday': '2026-05-01 09:00', '9am on friday': '2026-05-01 09:00',
      'friday, 9am': '2026-05-01 09:00',
      '7 in the morning': '2026-04-29 07:00', '3 in the afternoon': '2026-04-28 15:00', '7 in the evening': '2026-04-28 19:00', '9 at night': '2026-04-28 21:00',
      morning: '2026-04-29 09:00', afternoon: '2026-04-28 15:00', 'tomorrow afternoon': '2026-04-29 15:00', 'tomorrow evening': '2026-04-29 18:00',
      'tomorrow night': '2026-04-29 21:00', 'friday afternoon': '2026-05-01 15:00', tonight: '2026-04-28 21:00', 'tonight at 8pm': '2026-04-28 20:00',
      // Today at its default even once it has passed: it says which day.
      'this morning': '2026-04-28 09:00', 'this afternoon': '2026-04-28 15:00', 'this evening': '2026-04-28 18:00',
      'end of day': '2026-04-28 17:00', eod: '2026-04-28 17:00',
      'oct 30': '2026-10-30 09:00', 'october 30th': '2026-10-30 09:00', '30 october': '2026-10-30 09:00', 'the 30th of october': '2026-10-30 09:00',
      'oct 30 at 3pm': '2026-10-30 15:00', 'oct 30 2027': '2027-10-30 09:00', 'oct 30 1730': '2026-10-30 17:30',
      // The next occurrence: today counts, yesterday's is next year's, February 29 waits for a leap year.
      'apr 28': '2026-04-28 09:00', 'apr 27': '2027-04-27 09:00', 'feb 29': '2028-02-29 09:00',
      'the day after tomorrow': '2026-04-30 09:00', 'day after tomorrow': '2026-04-30 09:00',
      'next week': '2026-05-04 09:00', 'next week at 3pm': '2026-05-04 15:00', 'next month': '2026-05-01 09:00',
      'tomorrow at 12 noon': '2026-04-29 12:00', '9.30am': '2026-04-29 09:30', '0900': '2026-04-29 09:00', 'tomorrow at 0900': '2026-04-29 09:00',
      'friday at midnight': '2026-05-02 00:00', midnight: '2026-04-29 00:00', '1730': '2026-04-28 17:30',
      // A part of day settles an hour said with no am/pm, and an explicit time within it wins.
      'tomorrow morning at 8am': '2026-04-29 08:00', 'tomorrow morning at 8': '2026-04-29 08:00', '8am tomorrow morning': '2026-04-29 08:00',
      'tonight at 9': '2026-04-28 21:00', 'tonight at 9.30': '2026-04-28 21:30', 'this evening at 7': '2026-04-28 19:00',
      'tonight at 12': '2026-04-29 00:00', 'tomorrow night at 11': '2026-04-29 23:00', 'friday in the afternoon': '2026-05-01 15:00',
      'tomorrow at night': '2026-04-29 21:00',
      // "3:30" is an hour with no am/pm too; a leading zero, 12 or 13-23 is a 24-hour clock.
      'tonight at 9:30': '2026-04-28 21:30', 'tomorrow afternoon at 3:30': '2026-04-29 15:30', 'at 09:30': '2026-04-29 09:30',
      'tomorrow at 12:30': '2026-04-29 12:30', 'tomorrow at 15:30': '2026-04-29 15:30', '9:30 at night': '2026-04-28 21:30',
      // A four-digit number after a date is a year only if it is not gone by; 1930 is a time.
      'oct 30 1930': '2026-10-30 19:30',
    };
    for (const [t, at] of Object.entries(want)) {
      const r = parseRelativeDate(t, NOW);
      expect([t, r && ymdhm(r.ts)]).toEqual([t, at]);
    }
    // "today morning" is today's like "this morning", once passed too (#1035 review).
    expect(ymdhm(parseRelativeDate('today morning', new Date(2026, 3, 28, 14, 0).getTime())!.ts)).toBe('2026-04-28 09:00');
    expect(ymdhm(parseRelativeDate('today in the evening', new Date(2026, 3, 28, 19, 0).getTime())!.ts)).toBe('2026-04-28 18:00');
    // End of day once it has passed is tomorrow's.
    expect(ymdhm(parseRelativeDate('eod', new Date(2026, 3, 28, 18, 0).getTime())!.ts)).toBe('2026-04-29 17:00');
    // Next month from December is January.
    expect(ymdhm(parseRelativeDate('next month', new Date(2026, 11, 15, 12, 0).getTime())!.ts)).toBe('2027-01-01 09:00');
  });

  test('spoken clock forms and number words, which need am/pm or a part of day like any hour (#1022 review)', () => {
    const want: Record<string, string> = {
      'in two hours': '2026-04-28 14:00', 'in five minutes': '2026-04-28 12:05', 'in twelve days': '2026-05-10 12:00',
      "at 5 o'clock pm": '2026-04-28 17:00', '5 oclock in the afternoon': '2026-04-28 17:00',
      'half past three in the afternoon': '2026-04-28 15:30', 'half past three pm': '2026-04-28 15:30',
      'quarter past four pm': '2026-04-28 16:15', 'quarter to five pm': '2026-04-28 16:45', 'quarter to one am': '2026-04-29 00:45',
      'tomorrow at quarter to five in the afternoon': '2026-04-29 16:45', 'three in the afternoon': '2026-04-28 15:00',
      'tonight at half past nine': '2026-04-28 21:30', 'friday at 5 o\u2019clock pm': '2026-05-01 17:00',
    };
    for (const [t, at] of Object.entries(want)) {
      const r = parseRelativeDate(t, NOW);
      expect([t, r && ymdhm(r.ts)]).toEqual([t, at]);
    }
    for (const t of ["at 5 o'clock", 'half past three', 'quarter to five', 'at three', 'in thirteen days', 'in twenty minutes', 'half past thirteen pm', 'later today']) {
      expect([t, parseRelativeDate(t, NOW)]).toEqual([t, null]);
    }
  });

  test('"today" alone is 17:00, or tomorrow 09:00 once that has passed; a time today is not moved once passed (#1022 review)', () => {
    expect(ymdhm(parseRelativeDate('today', NOW)!.ts)).toBe('2026-04-28 17:00');
    expect(ymdhm(parseRelativeDate('today', new Date(2026, 3, 28, 18, 0).getTime())!.ts)).toBe('2026-04-29 09:00');
    // In the past, for the daemon to refuse; it was moved to tomorrow before.
    expect(ymdhm(parseRelativeDate('today at 9am', NOW)!.ts)).toBe('2026-04-28 09:00');
    expect(ymdhm(parseRelativeDate('9am today', NOW)!.ts)).toBe('2026-04-28 09:00');
  });

  test('a time said in the minute it names is still now, not tomorrow (#1022 review)', () => {
    const half = new Date(2026, 3, 28, 12, 0, 30).getTime();
    expect(ymdhm(parseRelativeDate('noon', half)!.ts)).toBe('2026-04-28 12:00');
    expect(ymdhm(parseRelativeDate('noon', half + 60_000)!.ts)).toBe('2026-04-29 12:00');
    expect(ymdhm(parseRelativeDate('today', new Date(2026, 3, 28, 17, 0, 30).getTime())!.ts)).toBe('2026-04-28 17:00');
  });

  test('midnight ends the day it is said with; 12am starts it', () => {
    expect(ymdhm(parseRelativeDate('tomorrow at midnight', NOW)!.ts)).toBe('2026-04-30 00:00');
    expect(ymdhm(parseRelativeDate('tomorrow at 12am', NOW)!.ts)).toBe('2026-04-29 00:00');
  });

  test('a text longer than any time is refused before any split of it is tried', () => {
    // 120 characters still read; 121 do not.
    const at = (n: number) => `tomorrow${' '.repeat(n - 'tomorrow'.length - ' at 3pm'.length)} at 3pm`;
    expect(at(120)).toHaveLength(120);
    expect(ymdhm(parseRelativeDate(at(120), NOW)!.ts)).toBe('2026-04-29 15:00');
    expect(parseRelativeDate(at(121), NOW)).toBeNull();
    // Sixteen words is the most read, and these sixteen read.
    const long16 = 'on the 30th of october 2027 in the afternoon at quarter to five in the afternoon';
    expect(long16.split(' ')).toHaveLength(16);
    expect(ymdhm(parseRelativeDate(long16, NOW)!.ts)).toBe('2027-10-30 16:45');
    expect(parseRelativeDate(`${long16} x`, NOW)).toBeNull();
    // The worst case of sixteen is quick.
    const sixteen = Array.from({ length: 16 }, () => 'on').join(' ');
    const t0 = performance.now();
    expect(parseRelativeDate(sixteen, NOW)).toBeNull();
    expect(parseRelativeDate(`${sixteen} x`, NOW)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
  });

  test('what does not read, or reads two ways, is refused', () => {
    for (const t of ['later today', '10/30', '30/10', 'tomorrow at 3', 'at 3', '9.30', 'march', 'the 30th', '2 at night', '12 in the morning',
      'oct 32', 'feb 30 2027', 'in a while', 'in half a day', 'next weekend', 'whenever-ish',
      // A year is not a time (#1035 review): only 0000-1959 read as a 24-hour clock.
      '2026', 'friday 2026', 'tomorrow 2030', 'at 2030', 'oct 30 2015', 'oct 30 2000',
      // A time that contradicts the part of day it is said with.
      'tonight at 8am', 'this morning at 8pm', 'tomorrow evening at 3pm', 'tomorrow morning at 12',
      // "3:30" with nothing to say am or pm.
      'tomorrow at 3:30', '3:30', 'friday at 11:15',
      // No time is this long; every split of the words would be tried.
      `tomorrow ${'morning '.repeat(400)}`, `tomorrow at ${'x'.repeat(120)}`]) {
      expect([t, parseRelativeDate(t, NOW)]).toEqual([t, null]);
    }
  });
});

describe('a time is read in the zone given, not the runtime\'s (#1022)', () => {
  // Put back by name: in Bun, once TZ is deleted, setting it again no longer
  // moves the runtime's zone, so the zone it started in is set instead.
  const runtimeZone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  afterEach(() => {
    process.env.TZ = runtimeZone;
  });
  const at = (text: string, now: string, zone: string) => {
    const r = parseRelativeDate(text, Date.parse(now), zone);
    return r && new Date(r.ts).toISOString();
  };

  test('the same words at the same instant are different times in different zones', () => {
    // The runtime is somewhere else again, and does not decide.
    process.env.TZ = 'Europe/Rome';
    expect(at('tomorrow at 9am', '2026-10-20T15:00:00Z', 'America/New_York')).toBe('2026-10-21T13:00:00.000Z');
    // 23:30 on the 20th in New York is 12:30 on the 21st in Tokyo: "tomorrow" is a different day.
    expect(at('tomorrow at 9am', '2026-10-21T03:30:00Z', 'America/New_York')).toBe('2026-10-21T13:00:00.000Z');
    expect(at('tomorrow at 9am', '2026-10-21T03:30:00Z', 'Asia/Tokyo')).toBe('2026-10-22T00:00:00.000Z');
    expect(at('tomorrow at 9am', '2026-10-20T20:00:00Z', 'Asia/Kolkata')).toBe('2026-10-22T03:30:00.000Z');
    expect(at('2026-10-21 09:00', '2026-10-20T15:00:00Z', 'UTC')).toBe('2026-10-21T09:00:00.000Z');
  });

  test('around a clock change: the offset of the day named, a skipped time moves on, a repeated one is the first', () => {
    process.env.TZ = 'UTC';
    // Said in EDT, for a day in EST.
    expect(at('tomorrow at 9am', '2026-10-31T16:00:00Z', 'America/New_York')).toBe('2026-11-01T14:00:00.000Z');
    // 02:30 does not happen on 2027-03-14 in New York: it is 03:30 EDT.
    expect(at('2027-03-14 02:30', '2027-03-01T00:00:00Z', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z');
    // 01:30 happens twice on 2026-11-01: the first, in EDT.
    expect(at('2026-11-01 01:30', '2026-10-01T00:00:00Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    // Santiago skips midnight: 00:30 is 01:30, and "tomorrow" is that day at 09:00 -03.
    expect(at('2026-09-06 00:30', '2026-09-01T00:00:00Z', 'America/Santiago')).toBe('2026-09-06T04:30:00.000Z');
    expect(at('tomorrow', '2026-09-05T16:00:00Z', 'America/Santiago')).toBe('2026-09-06T12:00:00.000Z');
    // Lord Howe moves by half an hour.
    expect(at('2026-10-04 02:15', '2026-10-01T00:00:00Z', 'Australia/Lord_Howe')).toBe('2026-10-03T15:45:00.000Z');
  });

  test('everyday phrases around a clock change', () => {
    process.env.TZ = 'UTC';
    // Midnight starts the next day; Santiago has no 00:00 that day, so it is 01:00 -03.
    expect(at('at midnight', '2026-09-05T23:00:00Z', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
    // Tonight on the fall-back day is 21:00 EST.
    expect(at('tonight', '2026-11-01T15:00:00Z', 'America/New_York')).toBe('2026-11-02T02:00:00.000Z');
    // Said in EST, for the first day of EDT.
    expect(at('tomorrow afternoon', '2027-03-13T15:00:00Z', 'America/New_York')).toBe('2027-03-14T19:00:00.000Z');
    expect(at('3pm tomorrow', '2027-03-13T15:00:00Z', 'America/New_York')).toBe('2027-03-14T19:00:00.000Z');
    expect(at('next week', '2027-03-13T15:00:00Z', 'America/New_York')).toBe('2027-03-15T13:00:00.000Z');
    // A month-day in the repeated hour is the first; in the skipped one, moved on.
    expect(at('nov 1 at 1:30am', '2026-10-20T15:00:00Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(at('mar 14 at 2:30am', '2027-03-01T15:00:00Z', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z');
    // End of day once 17:00 has passed on the fall-back day.
    expect(at('eod', '2026-11-01T23:00:00Z', 'America/New_York')).toBe('2026-11-02T22:00:00.000Z');
  });

  test('read in a zone, every phrase is what the runtime reads when it is in that zone', () => {
    const phrases = ['today at 3pm', 'today at 9am', 'tomorrow', 'tomorrow at 2:30am', 'tomorrow at 1:30am', 'yesterday at noon',
      'friday', 'next sunday at 2:30am', 'sunday at 1:30am', '3pm', '2:30am', '00:30', 'in 3 hours', '2026-11-01 01:30',
      '2027-03-14 02:30', '2026-09-06 00:30', '2026-10-04 02:15', 'monkey',
      'at midnight', 'tonight', 'this morning', 'tomorrow afternoon', '3pm tomorrow', 'eod', 'next week', 'next month', 'oct 30 at 1:30am',
      'mar 14 at 2:30am', 'nov 1 at 1:30am', 'the day after tomorrow', 'in half an hour', '7 in the evening'];
    // Hours either side of a change in each zone, and an ordinary day.
    const zones: Array<[string, string[]]> = [
      ['America/New_York', ['2026-10-30T12:00:00Z', '2027-03-12T12:00:00Z']],
      ['Europe/London', ['2026-10-23T12:00:00Z']],
      ['America/Santiago', ['2026-09-03T12:00:00Z', '2026-04-02T12:00:00Z']],
      ['Australia/Lord_Howe', ['2026-10-01T12:00:00Z']],
      ['Asia/Kolkata', ['2026-10-20T12:00:00Z']],
      ['Pacific/Chatham', ['2026-09-25T12:00:00Z']],
    ];
    let compared = 0;
    let roundTrips = 0;
    // Wall times these zones skip, which no instant reads back as.
    const skipped = new Set(['America/New_York 2027-03-14 02:30', 'America/Santiago 2026-09-06 00:30', 'Australia/Lord_Howe 2026-10-04 02:15']);
    const wallIn = (ts: number, zone: string) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    };
    for (const [zone, starts] of zones) {
      process.env.TZ = zone;
      for (const start of starts) {
        for (let hour = 0; hour < 96; hour += 1) {
          const now = Date.parse(start) + hour * 3_600_000 + 17 * 60_000;
          for (const p of phrases) {
            const local = parseRelativeDate(p, now)?.ts ?? null;
            const zoned = parseRelativeDate(p, now, zone)?.ts ?? null;
            if (local !== zoned) throw new Error(`${zone} ${new Date(now).toISOString()} "${p}": local ${local}, zoned ${zoned}`);
            compared += 1;
            // And not only against this runtime's Date: an ISO wall time that
            // happens in the zone is read back by Intl as that wall time.
            const iso = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(p);
            if (iso && zoned !== null && !skipped.has(`${zone} ${p}`)) {
              const back = wallIn(zoned, zone);
              if (back !== p) throw new Error(`${zone} "${p}" reads back as ${back}`);
              roundTrips += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(8 * 96 * phrases.length);
    expect(roundTrips).toBeGreaterThan(8 * 96);
  });

  test('a zone the runtime does not know is an error, not another zone', () => {
    expect(() => parseRelativeDate('tomorrow', 0, 'Mars/Phobos')).toThrow(RangeError);
  });
});

