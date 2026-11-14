/**
 * The owner's calendar, read in Jarvis's own browser.
 *
 * A reply that proposes or accepts a time has to know when the owner is free.
 * A connection to Google gives that in one call, when there is one. When there
 * is none, the same calendar is one address away in the browser where the
 * owner is signed in to Gmail: Google Calendar's week view, read a week at a
 * time by ./page/cal-week.js. Which way is used is decided by the caller with
 * ../ways.ts: the connection first, this second, and "no calendar" only when
 * neither can answer.
 *
 * What is read is what the owner sees there: the events of every calendar
 * they have switched on, without the ones they declined.
 */
import type { GmailPage } from './gmail.ts';
import type { MailCalendarEvent } from './proposer.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most weeks one reading opens: a hundred days and a little. */
export const CALENDAR_WEEKS_MAX = 16;
/** How often a week is asked for again while the page is still on its way there. */
const CALENDAR_TRIES = 4;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
const dayAfter = (day: string): string => dayOf(Date.parse(`${day}T00:00:00Z`) + DAY_MS);

/** The address, inside Google Calendar, of the week that holds a day ("2026-11-16"). In English, whatever the owner's language: the hours are read from words. */
export function calendarWeekPath(day: string): string {
  if (!DAY.test(day)) throw new Error('a day is written 2026-11-16');
  const [year, month, date] = day.split('-').map(Number);
  return `/calendar/u/0/r/week/${year}/${month}/${date}?hl=en`;
}

export interface CalendarRead {
  events: MailCalendarEvent[];
  /** How many weeks were opened. */
  weeks: number;
  /** Events on screen that were written in a way the reader does not know, and were left out. */
  unread: number;
  /** Events the owner declined: not theirs to be at. */
  declined: number;
}

interface WeekEvent extends MailCalendarEvent { id: string; allDay: boolean }

/** One event as the page answered it, checked. Null when it is not one. */
export function calendarEvent(raw: unknown): WeekEvent | null {
  const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!event || typeof event.id !== 'string' || !event.id || typeof event.summary !== 'string') return null;
  if (typeof event.start !== 'string' || typeof event.end !== 'string') return null;
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  // Nothing in a calendar lasts longer than a few weeks; something that claims to was read wrongly.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 60 * DAY_MS) return null;
  return {
    id: event.id,
    summary: event.summary.replace(/\s+/g, ' ').trim().slice(0, 200),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay: event.allDay === true,
  };
}

interface WeekAnswer { state?: unknown; days?: unknown; zoneAgrees?: unknown; events?: unknown; unread?: unknown; declined?: unknown }

/**
 * The calendar between two moments, read week by week. Null when the browser
 * is not signed in to Google: that way is not there, and the caller says so
 * or tries another. A throw is a calendar that is there and could not be read.
 */
export async function browserCalendar(page: GmailPage, from: number, to: number, options: {
  each?: (weeks: number) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<CalendarRead | null> {
  if (!(to > from)) throw new Error('the calendar is read between two moments, the second after the first');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A day to spare at each end: the browser may be in another time zone than this code.
  const final = dayOf(to + DAY_MS);
  let wanted = dayOf(from - DAY_MS);
  const found = new Map<string, WeekEvent>();
  let weeks = 0;
  let unread = 0;
  let declined = 0;

  while (wanted <= final) {
    if (weeks >= CALENDAR_WEEKS_MAX) throw new Error(`more than ${CALENDAR_WEEKS_MAX} weeks of calendar were asked for`);
    await page.run('site', { site: 'calendar', path: calendarWeekPath(wanted) });
    let week: WeekAnswer | null = null;
    let state = 'not-up';
    for (let attempt = 0; attempt < CALENDAR_TRIES && !week; attempt++) {
      // The page is on its way: an answer given while the address changes is thrown away by the desktop app.
      await sleep(attempt === 0 ? 1200 : 1500);
      const answer = await page.run<WeekAnswer>('cal-week', { day: wanted }).catch(() => null);
      state = typeof answer?.state === 'string' ? answer.state : 'no-answer';
      if (state === 'signed-out') return null;
      if (state === 'read') week = answer;
    }
    if (!week) throw new Error(`Google Calendar did not show the week (${state})`);
    if (week.zoneAgrees === false) throw new Error('the calendar is set to another time zone than the browser it is read in');
    const days = Array.isArray(week.days) ? week.days.filter((day): day is string => typeof day === 'string' && DAY.test(day)).sort() : [];
    if (days.length === 0 || !days.includes(wanted)) throw new Error('Google Calendar showed another week than the one asked for');

    weeks++;
    unread += typeof week.unread === 'number' ? week.unread : 0;
    declined += typeof week.declined === 'number' ? week.declined : 0;
    for (const raw of Array.isArray(week.events) ? week.events : []) {
      const event = calendarEvent(raw);
      if (!event) { unread++; continue; }
      // A whole-day event that runs over the end of a week is one event, met twice.
      const earlier = event.allDay ? [...found.values()].find((other) => other.allDay && other.id === event.id && other.end === event.start) : undefined;
      if (earlier) earlier.end = event.end;
      else found.set(`${event.id} ${event.start}`, event);
    }
    options.each?.(weeks);
    wanted = dayAfter(days[days.length - 1]!);
  }

  const events = [...found.values()]
    .filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((event) => ({ summary: event.summary, start: event.start, end: event.end, ...(event.allDay ? { allDay: true } : {}) }));
  return { events, weeks, unread, declined };
}
