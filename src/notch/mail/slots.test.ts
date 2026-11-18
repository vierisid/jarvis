import { describe, expect, test } from 'bun:test';
import type { MailCalendarEvent } from './proposer.ts';
import { MAIL_SLOT_MINUTES, mailFreeSlots, mailRowSlots, mailSlotFree, mailSlotLine, mailSlotWords } from './slots.ts';

/** Saturday 14 November 2026, 09:00 UTC. */
const SAT = Date.UTC(2026, 10, 14, 9, 0);
const event = (start: string, end: string, extra: Partial<MailCalendarEvent> = {}): MailCalendarEvent => ({ summary: 'Busy', start, end, ...extra });
const said = (events: MailCalendarEvent[], now = SAT, zone = 'UTC'): string[] => mailFreeSlots(events, now, zone).map((slot) => mailSlotWords(slot.at, zone));

describe('free times, read off the calendar by rule', () => {
  test('an empty calendar gives three days, each at another part of the day, and never a weekend or today', () => {
    expect(said([])).toEqual(['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30']);
    const slots = mailFreeSlots([], SAT, 'UTC');
    expect(slots.map((slot) => new Date(slot.at).toISOString())).toEqual(['2026-11-16T15:00:00.000Z', '2026-11-17T10:00:00.000Z', '2026-11-18T09:30:00.000Z']);
    expect(slots.every((slot) => slot.minutes === MAIL_SLOT_MINUTES)).toBe(true);
    // On a Wednesday the next days are Thursday, Friday and Monday.
    expect(said([], Date.UTC(2026, 10, 18, 9, 0))).toEqual(['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30']);
    // Late in the evening it is still not today, and not the night.
    expect(said([], Date.UTC(2026, 10, 18, 23, 30))).toEqual(['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30']);
  });

  test('what is in the calendar is not offered: the next best time of that day is, or the next day', () => {
    // Monday afternoon is taken from 13:00 to 17:00: the morning it is.
    expect(said([event('2026-11-16T13:00:00Z', '2026-11-16T17:00:00Z')])[0]).toBe('Monday at 11:00');
    // An entry that ends when the half hour begins, or begins when it ends, is not in its way.
    expect(said([event('2026-11-16T14:00:00Z', '2026-11-16T15:00:00Z'), event('2026-11-16T15:30:00Z', '2026-11-16T16:00:00Z')])[0]).toBe('Monday at 15:00');
    // One minute into it is.
    expect(said([event('2026-11-16T14:00:00Z', '2026-11-16T15:01:00Z')])[0]).toBe('Monday at 16:00');
    // A whole Monday taken: the three are the days after it.
    expect(said([event('2026-11-16T08:00:00Z', '2026-11-16T19:00:00Z')])).toEqual(['Tuesday at 15:00', 'Wednesday at 10:00', 'Thursday at 9:30']);
    // When what a day likes is all taken, any free half hour of it will do, the earliest first.
    const likes = ['15:00', '14:00', '16:00', '11:00', '10:00'].map((at) => event(`2026-11-16T${at}:00Z`, `2026-11-16T${at.slice(0, 2)}:30:00Z`));
    expect(said(likes)[0]).toBe('Monday at 9:00');
  });

  test('a whole-day entry is not in the way, and an entry that cannot be read is not either', () => {
    expect(said([event('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z', { allDay: true })])[0]).toBe('Monday at 15:00');
    expect(said([event('not a date', 'neither')])[0]).toBe('Monday at 15:00');
  });

  test('a calendar with no room in the coming week gives fewer, or none', () => {
    const full = [16, 17, 18, 19, 20].map((day) => event(`2026-11-${day}T00:00:00Z`, `2026-11-${day}T23:59:00Z`));
    expect(said(full)).toEqual([]);
    expect(said(full.slice(0, 4))).toEqual(['Friday at 15:00']);
  });

  test('the hours are the owner\'s own, in their time zone, also across a change of the clocks', () => {
    // In Rome in winter 15:00 is 14:00 UTC.
    expect(mailFreeSlots([], SAT, 'Europe/Rome').map((slot) => new Date(slot.at).toISOString())).toEqual(['2026-11-16T14:00:00.000Z', '2026-11-17T09:00:00.000Z', '2026-11-18T08:30:00.000Z']);
    expect(said([], SAT, 'Europe/Rome')).toEqual(['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30']);
    // Friday 23 October 2026: the clocks go back on Sunday. Monday at 15:00 is on the new time.
    const before = Date.UTC(2026, 9, 23, 8, 0);
    expect(mailFreeSlots([], before, 'Europe/Rome').map((slot) => new Date(slot.at).toISOString())).toEqual(['2026-10-26T14:00:00.000Z', '2026-10-27T09:00:00.000Z', '2026-10-28T08:30:00.000Z']);
    // Friday 27 March 2026: they go forward on Sunday.
    expect(mailFreeSlots([], Date.UTC(2026, 2, 27, 8, 0), 'Europe/Rome')[0]!.at).toBe(Date.UTC(2026, 2, 30, 13, 0));
    // Late on Saturday in New York it is Sunday in UTC already: the days are New York's.
    expect(said([], Date.UTC(2026, 10, 15, 3, 0), 'America/New_York')).toEqual(['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30']);
  });

  test('a time is said to the model with its whole date, and to the owner as a day and an hour', () => {
    const [first] = mailFreeSlots([], SAT, 'UTC');
    expect(mailSlotLine(first!, 'UTC')).toBe('Monday 16 November 2026, 15:00 to 15:30');
    expect(mailSlotWords(first!.at, 'UTC')).toBe('Monday at 15:00');
    expect(mailSlotWords(first!.at, 'Europe/Rome')).toBe('Monday at 16:00');
  });

  test('whether a time is still free is asked the same way', () => {
    const slot = { at: Date.UTC(2026, 10, 16, 15, 0), minutes: 30 };
    expect(mailSlotFree(slot, [])).toBe(true);
    expect(mailSlotFree(slot, [event('2026-11-16T15:15:00Z', '2026-11-16T16:00:00Z')])).toBe(false);
    expect(mailSlotFree(slot, [event('2026-11-16T15:30:00Z', '2026-11-16T16:00:00Z')])).toBe(true);
  });

  test('what a stored row holds is checked before it is used', () => {
    const good = [{ at: 1, minutes: 30, words: 'Monday at 15:00' }, { at: 2, minutes: 30, words: 'Tuesday at 10:00' }];
    expect(mailRowSlots(good)).toEqual(good);
    expect(mailRowSlots([good[0]])).toBeNull();
    expect(mailRowSlots([...good, { at: 'x', minutes: 30, words: 'w' }])).toBeNull();
    expect(mailRowSlots([...good, { at: 3, minutes: 30, words: '' }])).toBeNull();
    expect(mailRowSlots('nothing')).toBeNull();
  });
});
