import { describe, expect, test } from 'bun:test';
import { browserCalendar, calendarEvent, calendarWeekPath, CALENDAR_WEEKS_MAX } from './calendar.ts';
import type { GmailPage } from './gmail.ts';

const at = (text: string): number => Date.parse(text);
const event = (id: string, start: string, end: string, summary = 'Call with Leo', allDay = false) => ({ id, summary, start, end, allDay });

/** A calendar that shows Monday-to-Sunday weeks, with what each week holds. */
function calendar(weeks: Record<string, Record<string, unknown>>, extra: { answers?: (day: string, asked: number) => unknown } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const asked = new Map<string, number>();
  const monday = (day: string): string => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  };
  const days = (first: string): string[] => Array.from({ length: 7 }, (_, n) => new Date(Date.parse(`${first}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10));
  const page: GmailPage = {
    run: async <T>(name: string, args?: unknown) => {
      calls.push({ name, args });
      if (name === 'site') return { there: false } as T;
      const day = (args as { day: string }).day;
      const times = (asked.get(day) ?? 0) + 1;
      asked.set(day, times);
      const forced = extra.answers?.(day, times);
      if (forced !== undefined) { if (forced instanceof Error) throw forced; return forced as T; }
      const first = monday(day);
      return { state: 'read', days: days(first), zoneAgrees: true, events: [], unread: 0, declined: 0, ...weeks[first] } as T;
    },
  };
  return { page, calls, sites: () => calls.filter((call) => call.name === 'site').map((call) => (call.args as { path: string }).path) };
}
const sleep = async () => {};

describe('where a week is', () => {
  test('the week view of the day, in English', () => {
    expect(calendarWeekPath('2026-11-16')).toBe('/calendar/u/0/r/week/2026/11/16?hl=en');
    expect(calendarWeekPath('2026-01-05')).toBe('/calendar/u/0/r/week/2026/1/5?hl=en');
    expect(() => calendarWeekPath('16/11/2026')).toThrow();
  });
});

describe('an event the page answered', () => {
  test('is kept when it has an id, a title and an end after its start', () => {
    expect(calendarEvent(event('e1', '2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00.000Z', '  Call   with Leo '))).toEqual(
      { id: 'e1', summary: 'Call with Leo', start: '2026-11-16T09:00:00.000Z', end: '2026-11-16T10:00:00.000Z', allDay: false },
    );
  });

  test('is refused when it is not one: no dates, an end before the start, months long', () => {
    expect(calendarEvent(null)).toBeNull();
    expect(calendarEvent({ id: 'e1', summary: 'x', start: 'soon', end: 'later' })).toBeNull();
    expect(calendarEvent(event('e1', '2026-11-16T10:00:00Z', '2026-11-16T09:00:00Z'))).toBeNull();
    expect(calendarEvent(event('e1', '2026-01-01T00:00:00Z', '2026-11-16T09:00:00Z'))).toBeNull();
    expect(calendarEvent({ ...event('', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z') })).toBeNull();
  });
});

describe('the calendar read in the browser', () => {
  test('opens each week between the two moments, going on from the last day the page showed', async () => {
    const { page, sites } = calendar({
      '2026-11-09': { events: [event('a', '2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z')] },
      '2026-11-16': { events: [event('b', '2026-11-18T14:00:00Z', '2026-11-18T15:00:00Z', 'Board')], unread: 1, declined: 2 },
    });
    const read = await browserCalendar(page, at('2026-11-11T08:00:00Z'), at('2026-11-20T08:00:00Z'), { sleep });
    // A day to spare at the start: Tuesday the 10th is asked for, and its week runs to Sunday the 15th.
    expect(sites()).toEqual(['/calendar/u/0/r/week/2026/11/10?hl=en', '/calendar/u/0/r/week/2026/11/16?hl=en']);
    expect(read).toEqual({
      events: [
        { summary: 'Call with Leo', start: '2026-11-12T09:00:00.000Z', end: '2026-11-12T10:00:00.000Z' },
        { summary: 'Board', start: '2026-11-18T14:00:00.000Z', end: '2026-11-18T15:00:00.000Z' },
      ],
      weeks: 2,
      unread: 1,
      declined: 2,
    });
  });

  test('keeps only what falls between the two moments', async () => {
    const { page } = calendar({ '2026-11-09': { events: [
      event('early', '2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z'),
      event('in', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z'),
      event('late', '2026-11-14T09:00:00Z', '2026-11-14T10:00:00Z'),
    ] } });
    const read = await browserCalendar(page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep });
    expect(read!.events.map((entry) => entry.start)).toEqual(['2026-11-11T09:00:00.000Z']);
  });

  test('a whole-day event that runs over the end of a week is one event', async () => {
    const { page } = calendar({
      '2026-11-09': { events: [event('fair', '2026-11-14T00:00:00Z', '2026-11-16T00:00:00Z', 'Fair', true)] },
      '2026-11-16': { events: [event('fair', '2026-11-16T00:00:00Z', '2026-11-18T00:00:00Z', 'Fair', true)] },
    });
    const read = await browserCalendar(page, at('2026-11-12T00:00:00Z'), at('2026-11-20T00:00:00Z'), { sleep });
    expect(read!.events).toEqual([{ summary: 'Fair', start: '2026-11-14T00:00:00.000Z', end: '2026-11-18T00:00:00.000Z', allDay: true }]);
  });

  test('an event the page gave badly is counted as not read, never kept', async () => {
    const { page } = calendar({ '2026-11-09': { events: [{ id: 'x', summary: 'x', start: 'never', end: 'never' }, event('ok', '2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z')] } });
    const read = await browserCalendar(page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep });
    expect(read!.events.length).toBe(1);
    expect(read!.unread).toBe(1);
  });

  // No browser signed in to Google is "this way is not here", not a failure: the caller goes on to say so.
  test('a browser that is not signed in gives null', async () => {
    const { page } = calendar({}, { answers: () => ({ state: 'signed-out' }) });
    expect(await browserCalendar(page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep })).toBeNull();
  });

  test('asks again while the page is on its way, and gives up when the week never shows', async () => {
    const coming = calendar({}, { answers: (_day, asked) => (asked === 1 ? new Error('the page changed') : asked === 2 ? { state: 'another-week' } : undefined) });
    const read = await browserCalendar(coming.page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep });
    expect(read!.weeks).toBe(1);
    const never = calendar({}, { answers: () => ({ state: 'not-up' }) });
    await expect(browserCalendar(never.page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep })).rejects.toThrow('did not show the week (not-up)');
  });

  // Hours are turned into moments with the browser's time zone: a calendar set to another would be an hour or more off.
  test('refuses a calendar set to another time zone than the browser', async () => {
    const { page } = calendar({ '2026-11-09': { zoneAgrees: false } });
    await expect(browserCalendar(page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep })).rejects.toThrow('another time zone');
  });

  test('refuses a week that is not the one asked for, and more weeks than it reads', async () => {
    const wrong = calendar({}, { answers: () => ({ state: 'read', days: ['2026-01-05'], zoneAgrees: true, events: [] }) });
    await expect(browserCalendar(wrong.page, at('2026-11-11T00:00:00Z'), at('2026-11-12T00:00:00Z'), { sleep })).rejects.toThrow('another week');
    const { page } = calendar({});
    await expect(browserCalendar(page, at('2026-01-01T00:00:00Z'), at('2026-12-01T00:00:00Z'), { sleep })).rejects.toThrow(`more than ${CALENDAR_WEEKS_MAX} weeks`);
  });
});
