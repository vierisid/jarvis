/**
 * Free times to offer: "Anna asked to move Thursday. Offer a slot?"
 *
 * The prototype answers a mail that asks for a time with three of them, and
 * one press sends the pick. Which times are free is not a model's to say:
 * it is read off the owner's calendar here, by rule. The model only words
 * them, in the language of the reply it writes (./proposer.ts).
 *
 * The rule:
 *
 *   - Monday to Friday, between 9:00 and 18:00 in the owner's time zone.
 *   - Not today: from tomorrow, for the seven days after today. So the name
 *     of a weekday says which day is meant, without a date.
 *   - Half an hour, beginning on the hour or the half hour, with nothing
 *     else in the calendar in that half hour. A whole-day entry (a
 *     birthday, a note) is not something that is in the way.
 *   - At most one a day, on up to three days: the earliest days that have
 *     room. Each prefers another part of the day, so that the three are a
 *     choice: an afternoon, a morning, an early morning.
 */
import type { MailCalendarEvent } from './proposer.ts';

export interface MailSlot {
  /** When it begins. */
  at: number;
  minutes: number;
}

/** A free time with the words that name it in the reply, in the reply's language. */
export interface MailRowSlot extends MailSlot { words: string }

export const MAIL_SLOT_MINUTES = 30;
/** How many are offered. */
export const MAIL_SLOTS = 3;
/** How many days after today are looked at. */
export const MAIL_SLOT_DAYS = 7;
/** The working day, in hours of the owner's clock. */
export const MAIL_SLOT_FROM = 9;
export const MAIL_SLOT_TO = 18;
/** A time this close is not offered any more: an answer could not come in time. */
export const MAIL_SLOT_LEAST_AHEAD_MS = 2 * 3_600_000;

const MINUTE = 60_000;
const DAY_MS = 24 * 3_600_000;

interface Local { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/** An instant as the owner's clock and calendar show it. `weekday`: 0 is Sunday. */
function local(at: number, zone?: string): Local {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(at);
  const of = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(of('year')), month: Number(of('month')), day: Number(of('day')), hour: Number(of('hour')) % 24, minute: Number(of('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(of('weekday')),
  };
}

/** The instant at which the owner's clock shows that day and time. */
function instant(year: number, month: number, day: number, hour: number, minute: number, zone?: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let at = wanted;
  // Twice: the first guess can land on the other side of a change of the clocks.
  for (let pass = 0; pass < 2; pass++) {
    const shown = local(at, zone);
    at += wanted - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  }
  return at;
}

/** Whether nothing in the calendar is in that time. Whole-day entries are not in the way. */
export function mailSlotFree(slot: MailSlot, events: readonly MailCalendarEvent[]): boolean {
  const from = slot.at;
  const to = slot.at + slot.minutes * MINUTE;
  return !events.some((event) => {
    if (event.allDay) return false;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    return Number.isFinite(start) && Number.isFinite(end) && start < to && end > from;
  });
}

/** The starts each pick likes best, in minutes of the day: an afternoon, a morning, an early morning. */
const LIKES: readonly (readonly number[])[] = [
  [15 * 60, 14 * 60, 16 * 60, 11 * 60, 10 * 60],
  [10 * 60, 11 * 60, 9 * 60 + 30, 14 * 60, 15 * 60],
  [9 * 60 + 30, 10 * 60, 11 * 60 + 30, 15 * 60, 16 * 60],
];

/**
 * Up to three free times in the days after `now`, the earliest day first.
 * Empty when the calendar leaves no room.
 */
export function mailFreeSlots(events: readonly MailCalendarEvent[], now: number, zone?: string): MailSlot[] {
  const today = local(now, zone);
  const found: MailSlot[] = [];
  for (let ahead = 1; ahead <= MAIL_SLOT_DAYS && found.length < MAIL_SLOTS; ahead++) {
    // Noon of the day, so that a change of the clocks cannot push it into its neighbour.
    const noon = local(instant(today.year, today.month, today.day, 12, 0, zone) + ahead * DAY_MS, zone);
    if (noon.weekday === 0 || noon.weekday === 6) continue;
    const every: number[] = [];
    for (let minute = MAIL_SLOT_FROM * 60; minute + MAIL_SLOT_MINUTES <= MAIL_SLOT_TO * 60; minute += 30) every.push(minute);
    const likes = LIKES[found.length % LIKES.length]!;
    for (const minute of [...likes, ...every.filter((one) => !likes.includes(one))]) {
      const slot: MailSlot = { at: instant(noon.year, noon.month, noon.day, Math.floor(minute / 60), minute % 60, zone), minutes: MAIL_SLOT_MINUTES };
      if (slot.at - now < MAIL_SLOT_LEAST_AHEAD_MS || !mailSlotFree(slot, events)) continue;
      found.push(slot);
      break;
    }
  }
  return found;
}

/**
 * Every free start in the days after `now`, the earliest first, by the same
 * rule: Monday to Friday, on the hour and the half hour, the whole of it
 * inside the working day, not today, and with nothing else in the calendar.
 * For finding a time that is free for two people (../people-time.ts): each
 * side works its own out, and only the starts cross.
 */
export function mailFreeStarts(events: readonly MailCalendarEvent[], now: number, zone?: string, minutes = MAIL_SLOT_MINUTES): number[] {
  const today = local(now, zone);
  const found: number[] = [];
  for (let ahead = 1; ahead <= MAIL_SLOT_DAYS; ahead++) {
    const noon = local(instant(today.year, today.month, today.day, 12, 0, zone) + ahead * DAY_MS, zone);
    if (noon.weekday === 0 || noon.weekday === 6) continue;
    for (let minute = MAIL_SLOT_FROM * 60; minute + minutes <= MAIL_SLOT_TO * 60; minute += 30) {
      const at = instant(noon.year, noon.month, noon.day, Math.floor(minute / 60), minute % 60, zone);
      if (at - now < MAIL_SLOT_LEAST_AHEAD_MS || !mailSlotFree({ at, minutes }, events)) continue;
      found.push(at);
    }
  }
  return found;
}

/**
 * Up to three of some starts, as a choice: at most one a day, on the
 * earliest days that have one, each preferring another part of the day (an
 * afternoon, a morning, an early morning), as mailFreeSlots picks.
 */
export function mailPickStarts(starts: readonly number[], zone?: string): number[] {
  const days = new Map<string, number[]>();
  for (const at of [...starts].sort((a, b) => a - b)) {
    const shown = local(at, zone);
    const key = `${shown.year}-${shown.month}-${shown.day}`;
    days.set(key, [...(days.get(key) ?? []), at]);
  }
  const picked: number[] = [];
  for (const day of days.values()) {
    if (picked.length >= MAIL_SLOTS) break;
    const minuteOf = (at: number): number => { const shown = local(at, zone); return shown.hour * 60 + shown.minute; };
    const liked = LIKES[picked.length % LIKES.length]!.map((minute) => day.find((at) => minuteOf(at) === minute)).find((at) => at !== undefined);
    picked.push(liked ?? day[0]!);
  }
  return picked;
}

/** A time as the notch says it: "Thursday at 15:00". */
export function mailSlotWords(at: number, zone?: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(at);
  const shown = local(at, zone);
  return `${day} at ${shown.hour}:${String(shown.minute).padStart(2, '0')}`;
}

/** A time as the model reads it: the whole date, so that nothing is left to guess. */
export function mailSlotLine(slot: MailSlot, zone?: string): string {
  // Put together here, part by part: how a whole date is punctuated is not the same on every machine.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(slot.at);
  const of = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${of('weekday')} ${of('day')} ${of('month')} ${of('year')}`;
  const clock = (at: number): string => { const shown = local(at, zone); return `${String(shown.hour).padStart(2, '0')}:${String(shown.minute).padStart(2, '0')}`; };
  return `${date}, ${clock(slot.at)} to ${clock(slot.at + slot.minutes * MINUTE)}`;
}

/** The slots a stored row holds, checked. Null when it holds none that can be used. */
export function mailRowSlots(raw: unknown): MailRowSlot[] | null {
  if (!Array.isArray(raw)) return null;
  const slots = raw.filter((one): one is MailRowSlot =>
    !!one && typeof one === 'object' && Number.isFinite((one as MailRowSlot).at) && Number.isFinite((one as MailRowSlot).minutes)
    && typeof (one as MailRowSlot).words === 'string' && (one as MailRowSlot).words.length > 0)
    .map((one) => ({ at: one.at, minutes: one.minutes, words: one.words }));
  return slots.length >= 2 && slots.length === raw.length ? slots : null;
}
