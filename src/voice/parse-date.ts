/**
 * Phase 6.7.A -- lightweight relative-date parser used by the Calendar
 * Room's `schedule_event` voice action.
 *
 * The classifier extracts a `when` slot as a free-form string ("tuesday
 * at 3pm", "tomorrow", "in 3 days", "2026-04-30 15:00"). This parser
 * normalizes that string to a Unix timestamp in milliseconds, with a
 * confidence band so the caller can reject ambiguous inputs.
 *
 * Deliberately small -- no chrono-node dep. Covers ~90% of likely
 * utterances; unknown formats return `null` and the caller falls back
 * to the chat agent (which can handle the request as a normal task).
 *
 * Times default to 09:00 when only a date is given. Dates default to today
 * when only a time is given.
 *
 * Every word must be read (#1035): anything left over that is not a time
 * ("tuesday at 3", "later today") is null, not that date at 09:00, and so is
 * a date or time no calendar has ("2026-02-30", "25:00") and a numeric date
 * that reads both ways ("10/30"). What is read is shown on the card as an
 * instant before anything runs, so everyday phrases take fixed defaults
 * rather than being refused:
 *  - a date alone is 09:00; a part of day is morning 09:00, afternoon 15:00,
 *    evening 18:00, night 21:00; "tonight" is today 21:00; "this morning"
 *    (afternoon, evening) is today at that time; "end of day" / "eod" is
 *    17:00 today, or tomorrow once that has passed; "today" alone is the
 *    same, 17:00 or else tomorrow 09:00; "noon" / "midday" is 12:00;
 *  - midnight ends the day it is said with: "tomorrow at midnight" is 00:00
 *    of the day after tomorrow, the end of tomorrow, while "tomorrow at
 *    12am" is 00:00 at the start of tomorrow;
 *  - a time alone is today, or tomorrow once it has passed; a time with a
 *    day is that day, even once it has passed ("today at 9am" said at noon
 *    is in the past, and the daemon refuses it rather than moving it);
 *  - "next week" is next Monday, "next month" the 1st of next month, "the
 *    day after tomorrow" that day; a month and day with no year is its next
 *    occurrence;
 *  - an hour needs am/pm ("3pm", "9.30am", "half past three pm"), a 24-hour
 *    clock ("15:00", "0900"), or a part of day ("7 in the evening", "quarter
 *    to five in the afternoon"): "at 3", "at 5 o'clock" and "half past
 *    three" are refused;
 *  - a duration counts in digits or in words one to twelve ("in two hours").
 *
 * Wall-clock times are read in `timeZone` when one is given (an IANA name),
 * else in this runtime's own zone (#1022): the daemon settles a voice
 * action's time in the zone of the dashboard that asked, before its card,
 * while the rooms' own create dialogs parse in the browser's. A wall time a
 * zone skips (02:30 on a spring-forward night) and one it repeats (01:30 on
 * a fall-back night) resolve as `new Date(y, m, d, h, mi)` resolves them in
 * that zone: the skipped one by the offset before the change (so 03:30),
 * the repeated one to its first occurrence.
 *
 * NO IMPORTS: the UI bundles this file.
 */

/**
 * How long a time stays "now" (#1022 review): "noon" said at 12:00:30 is
 * today's, not tomorrow's, and the daemon takes a settled time as passed only
 * once it is this far behind.
 */
export const PASSED_GRACE_MS = 60_000;

export interface ParsedDate {
  /** Unix ms. */
  ts: number;
  /** 0..1: 1 for an ISO date, less for a relative phrase, less again with no time. Callers only check for null. */
  confidence: number;
}

/** A calendar date: year, month 1-12, day of month. */
type Ymd = { y: number; m: number; d: number };

/** How wall-clock dates and times map to instants, in one zone. */
type Clock = {
  /** The calendar date at `now`. */
  dateAt(now: number): Ymd;
  /** The instant `day` at `h`:`mi` names. */
  at(day: Ymd, h: number, mi: number): number;
};

const LOCAL_CLOCK: Clock = {
  dateAt(now) {
    const x = new Date(now);
    return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
  },
  at(day, h, mi) {
    return new Date(day.y, day.m - 1, day.d, h, mi, 0, 0).getTime();
  },
};

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    // Bounded whatever zones are asked for: a few are in use at a time.
    if (zoneFormatters.size >= 64) zoneFormatters.clear();
    // Throws a RangeError for a zone this runtime does not know.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at instant `t`, read as if it were UTC. */
function wallAsUtc(t: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return utc(p.year!, p.month!, p.day!, p.hour! % 24, p.minute!, p.second!);
}

/** Date.UTC without its mapping of years 0-99 to 1900-1999. */
function utc(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const x = new Date(0);
  x.setUTCFullYear(y, m - 1, d);
  x.setUTCHours(h, mi, s, 0);
  return x.getTime();
}

function zonedClock(timeZone: string): Clock {
  zoneFormatter(timeZone);
  const offsetAt = (t: number) => wallAsUtc(t, timeZone) - t;
  return {
    dateAt(now) {
      const w = new Date(wallAsUtc(now, timeZone));
      return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
    },
    at(day, h, mi) {
      const wall = utc(day.y, day.m, day.d, h, mi);
      // The offsets a day either side: at most one change lies between them.
      const before = offsetAt(wall - 86_400_000);
      const after = offsetAt(wall + 86_400_000);
      const fits = [wall - before, wall - after].filter((t) => wallAsUtc(t, timeZone) === wall);
      // Repeated: the first. Skipped: by the offset before the change.
      return fits.length > 0 ? Math.min(...fits) : wall - before;
    },
  };
}

function addDays(day: Ymd, n: number): Ymd {
  const x = new Date(utc(day.y, day.m, day.d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

function weekday(day: Ymd): number {
  return new Date(utc(day.y, day.m, day.d)).getUTCDay();
}

/** Parse a relative or absolute date string to a timestamp. Returns null
 *  if the string can't be confidently interpreted. `now` is injectable
 *  for testing (defaults to Date.now()). `timeZone` is the IANA zone its
 *  wall-clock times are in; left out, this runtime's own. An unknown zone
 *  throws a RangeError. */
export function parseRelativeDate(input: string, now: number = Date.now(), timeZone?: string): ParsedDate | null {
  // Speech-to-text ends a phrase with a full stop or a comma ("monday."),
  // and writes "p.m." for pm.
  const plain = input.trim().toLowerCase()
    .replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/[.,!?;]+$/, '').trim();
  if (!plain) return null;

  const clock = timeZone === undefined ? LOCAL_CLOCK : zonedClock(timeZone);
  const today = clock.dateAt(now);

  // 1. ISO-like absolute: "2026-04-30" or "2026-04-30 15:00" or "2026-04-30T15:00"
  const isoMatch = plain.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2})(?::(\d{2}))?(?::\d{2})?)?$/i);
  if (isoMatch) {
    const [, y, mo, d, h, mi] = isoMatch;
    const day = calendarDate(parseInt(y!, 10), parseInt(mo!, 10), parseInt(d!, 10));
    const hour = h ? parseInt(h, 10) : 9, minute = mi ? parseInt(mi, 10) : 0;
    // Date rolls an impossible date over ("2026-02-30" is March 2), and maps
    // years 0-99 to 1900-1999: none of that is what was said.
    if (!day || hour > 23 || minute > 59) return null;
    return { ts: clock.at(day, hour, minute), confidence: 1 };
  }

  // Commas and "@" are spaces and "at"; a word run into a number is two
  // ("friday3pm").
  // Every split of the words is tried, so a long text costs; no time is long.
  if (plain.length > 120) return null;
  const text = plain.replace(/@/g, ' at ').replace(/,/g, ' ').replace(/([a-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();

  // 2. "in N minutes/hours/days/weeks", "in an hour", "in half an hour"
  const ahead = inDuration(text);
  if (ahead !== null) return { ts: now + ahead, confidence: 0.85 };

  // 3. End of day: 17:00 today, or tomorrow once that has passed.
  if (/^(?:end of (?:the )?day|eod)$/.test(text)) {
    const at = clock.at(today, 17, 0);
    return { ts: at < now - PASSED_GRACE_MS ? clock.at(addDays(today, 1), 17, 0) : at, confidence: 0.8 };
  }

  const words = text.split(' ');
  if (words.length > 16) return null;
  const join = (from: number, to: number) => words.slice(from, to).join(' ');
  const combine = (day: DayRead, time: TimeRead | null): ParsedDate | null => {
    // "today" alone is the end of the working day, or tomorrow morning once
    // that has passed. "today at 9am" said at noon is not moved: it has passed.
    if (time === null && day.todayAlone) {
      const at = clock.at(day.date, 17, 0);
      return { ts: at < now - PASSED_GRACE_MS ? clock.at(addDays(day.date, 1), 9, 0) : at, confidence: 0.7 };
    }
    const t = time === null ? (day.part ? PARTS_OF_DAY[day.part]! : { h: 9, m: 0 }) : withinPart(time, day.part);
    if (!t) return null;
    const date = t.nextDay ? addDays(day.date, 1) : day.date;
    const ts = clock.at(date, t.h, t.m);
    return { ts, confidence: time || day.part ? day.confidence : Math.round(Math.max(0.5, day.confidence - 0.2) * 100) / 100 };
  };

  // 4. A day, then a time ("tomorrow at 3pm", "oct 30 1730"): the longest
  //    day that leaves a time, or nothing, behind.
  for (let i = words.length; i >= 1; i--) {
    const day = readDay(join(0, i), today);
    if (!day) continue;
    const rest = join(i, words.length).replace(/^at /, '');
    const time = rest ? readTime(rest) : null;
    const read = !rest || time ? combine(day, time) : null;
    if (read) return read;
  }

  // 5. A time, then a day ("3pm tomorrow", "9am on friday"), or a time alone:
  //    today, or tomorrow once it has passed.
  for (let i = words.length; i >= 1; i--) {
    const time = readTime(join(0, i).replace(/^at /, ''));
    if (!time) continue;
    const rest = join(i, words.length);
    if (!rest) {
      // An hour with no am/pm says neither, and no day says it for it.
      if (time.bare) return null;
      if (time.nextDay) return { ts: clock.at(addDays(today, 1), time.h, time.m), confidence: 0.6 };
      const at = clock.at(today, time.h, time.m);
      return { ts: at < now - PASSED_GRACE_MS ? clock.at(addDays(today, 1), time.h, time.m) : at, confidence: 0.6 };
    }
    const day = readDay(rest, today);
    const read = day && combine(day, time);
    if (read) return read;
  }
  return null;
}

/**
 * `time` as the part of day `part` has it (#1035): an hour said with no am or
 * pm takes the part's ("tonight at 9" is 21:00, "tomorrow morning at 8" is
 * 08:00), and one that contradicts it ("tonight at 8am") is null. With no
 * part, an hour with no am or pm is null.
 */
function withinPart(time: TimeRead, part: Part | undefined): TimeRead | null {
  if (time.bare) return part ? hourInPart(time.h, time.m, part) : null;
  if (!part) return time;
  const fits = time.nextDay ? part === 'night' && time.h === 0 && time.m === 0 : PART_HOURS[part].includes(time.h);
  return fits ? time : null;
}

/** A 1-12 hour said in `part`: morning 1-11 am, afternoon 12 or 1-7 pm, evening 4-11 pm, night 6-11 pm or 12 (midnight). */
function hourInPart(h: number, m: number, part: Part): TimeRead | null {
  switch (part) {
    case 'morning': return h >= 1 && h <= 11 ? { h, m } : null;
    case 'afternoon': return h === 12 ? { h, m } : h >= 1 && h <= 7 ? { h: h + 12, m } : null;
    case 'evening': return h >= 4 && h <= 11 ? { h: h + 12, m } : null;
    default: return h === 12 && m === 0 ? { h: 0, m: 0, nextDay: true } : h >= 6 && h <= 11 ? { h: h + 12, m } : null;
  }
}

type Part = 'morning' | 'afternoon' | 'evening' | 'night';

/** The 24-hour hours each part of day covers. */
const PART_HOURS: Record<Part, readonly number[]> = {
  morning: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  afternoon: [12, 13, 14, 15, 16, 17, 18, 19],
  evening: [16, 17, 18, 19, 20, 21, 22, 23],
  night: [18, 19, 20, 21, 22, 23],
};

/** A day as read: the date, the part of it named ("tonight"), and its confidence. */
type DayRead = { date: Ymd; part?: Part; todayAlone?: boolean; confidence: number };

/**
 * A time of day; `nextDay` for midnight, which starts the day after; `bare`
 * for an hour said with no am or pm ("3"), whose `h` is 1-12 as said.
 */
type TimeRead = { h: number; m: number; nextDay?: boolean; bare?: boolean };

const PARTS_OF_DAY: Record<Part, TimeRead> = {
  morning: { h: 9, m: 0 }, afternoon: { h: 15, m: 0 }, evening: { h: 18, m: 0 }, night: { h: 21, m: 0 },
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The day `s` names, read on `today`, or null. */
function readDay(s: string, today: Ymd): DayRead | null {
  const text = s.replace(/^on /, '');
  if (text === 'today') return { date: today, todayAlone: true, confidence: 0.9 };
  if (text === 'tonight') return { date: today, part: 'night', confidence: 0.9 };
  if (text === 'tomorrow') return { date: addDays(today, 1), confidence: 0.9 };
  if (text === 'yesterday') return { date: addDays(today, -1), confidence: 0.9 };
  if (text === 'the day after tomorrow' || text === 'day after tomorrow') return { date: addDays(today, 2), confidence: 0.9 };
  if (text === 'next week') return { date: addDays(today, ((1 - weekday(today) + 7) % 7) || 7), confidence: 0.8 };
  if (text === 'next month') {
    const date = today.m === 12 ? { y: today.y + 1, m: 1, d: 1 } : { y: today.y, m: today.m + 1, d: 1 };
    return { date, confidence: 0.8 };
  }
  const part = /^this (morning|afternoon|evening)$/.exec(text);
  if (part) return { date: today, part: part[1] as Part, confidence: 0.9 };
  // A day and a part of it: "tomorrow morning", "friday in the afternoon",
  // "tomorrow at night".
  const dayPart = /^(.+?) (?:in the (morning|afternoon|evening)|at (night)|(morning|afternoon|evening|night))$/.exec(text);
  if (dayPart) {
    const day = readDay(dayPart[1]!, today);
    // "today morning" is today's, like "this morning", even once it has passed.
    if (day && !day.part) return { date: day.date, confidence: day.confidence, part: (dayPart[2] ?? dayPart[3] ?? dayPart[4]) as Part };
  }
  // "next friday" is the one after today; "friday" / "this friday" is the
  // next one, today included.
  const next = /^next (\w+)$/.exec(text);
  if (next && own(WEEKDAYS, next[1]!)) {
    return { date: addDays(today, ((WEEKDAYS[next[1]!]! - weekday(today) + 7) % 7) || 7), confidence: 0.8 };
  }
  const name = text.replace(/^this /, '');
  if (own(WEEKDAYS, name)) return { date: addDays(today, (WEEKDAYS[name]! - weekday(today) + 7) % 7), confidence: 0.7 };
  return readMonthDay(text, today);
}

/** "oct 30", "october 30th 2027", "30 october", "the 30th of october", or null. */
function readMonthDay(text: string, today: Ymd): DayRead | null {
  const ord = '(\\d{1,2})(?:st|nd|rd|th)?';
  const monthFirst = new RegExp(`^([a-z]+)\\.? ${ord}(?: (\\d{4}))?$`).exec(text);
  const dayFirst = new RegExp(`^(?:the )?${ord}(?: of)? ([a-z]+)\\.?(?: (\\d{4}))?$`).exec(text);
  const [monthName, dayText, yearText] = monthFirst
    ? [monthFirst[1]!, monthFirst[2]!, monthFirst[3]]
    : dayFirst ? [dayFirst[2]!, dayFirst[1]!, dayFirst[3]] : [null, null, null];
  if (!monthName || !own(MONTHS, monthName)) return null;
  const month = MONTHS[monthName]!, day = parseInt(dayText!, 10);
  if (yearText) {
    // A year gone by is not a time to set; "oct 30 1930" may be 19:30.
    if (parseInt(yearText, 10) < today.y) return null;
    const date = calendarDate(parseInt(yearText, 10), month, day);
    return date && { date, confidence: 0.95 };
  }
  // Its next occurrence, today included; February 29 waits for a leap year.
  for (let y = today.y; y <= today.y + 8; y++) {
    const date = calendarDate(y, month, day);
    if (date && (y > today.y || month > today.m || (month === today.m && day >= today.d))) return { date, confidence: 0.95 };
  }
  return null;
}

/** The date if the calendar has it, from 1970 on, else null. */
function calendarDate(y: number, m: number, d: number): Ymd | null {
  if (y < 1970 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** Milliseconds "in N units" / "in an hour" / "in half an hour" means, or null. */
function inDuration(text: string): number | null {
  if (/^in half an? hour$/.test(text)) return 30 * 60_000;
  const m = /^in (\d+|an?|[a-z]+) (minute|min|hour|hr|day|week)s?$/.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? parseInt(m[1]!, 10) : m[1] === 'a' || m[1] === 'an' ? 1 : numberWord(m[1]!);
  if (n === null) return null;
  const unit = m[2]!;
  const ms =
    unit.startsWith('min') ? n * 60_000 :
    unit === 'hour' || unit === 'hr' ? n * 3_600_000 :
    unit === 'day' ? n * 86_400_000 : n * 7 * 86_400_000;
  return ms > 0 ? ms : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The time of day `input` names: "3pm", "9.30am", "15:00", "0900", "noon",
 * "12 noon", "midnight", a part of day ("afternoon", "in the evening", "at
 * night"), or an hour with one ("7 in the evening"). An hour with none of
 * these ("3") is null: am or pm is not guessed.
 */
function readTime(input: string): TimeRead | null {
  const t = input.trim().replace(/’/g, "'");
  if (!t) return null;
  if (t === 'noon' || t === 'midday' || t === '12 noon') return { h: 12, m: 0 };
  if (t === 'midnight' || t === '12 midnight') return { h: 0, m: 0, nextDay: true };
  const part = /^(?:in the (morning|afternoon|evening)|at (night)|(morning|afternoon|evening|night))$/.exec(t);
  if (part) return PARTS_OF_DAY[(part[1] ?? part[2] ?? part[3]) as Part];
  // A clock with am or pm, or a part of day: "3pm", "9.30am", "half past
  // three pm", "7 in the evening", "quarter to five in the afternoon".
  const tagged = /^(.+?) ?(am|pm|in the morning|in the afternoon|in the evening|at night)$/.exec(t);
  if (tagged) {
    const c = spokenClock(tagged[1]!);
    if (!c) return null;
    if (tagged[2] === 'am' || tagged[2] === 'pm') return { h: (c.h % 12) + (tagged[2] === 'pm' ? 12 : 0), m: c.m };
    return hourInPart(c.h, c.m, tagged[2]!.replace(/^(?:in the|at) /, '') as Part);
  }
  // A 24-hour clock: "15:30", "03:30", "12:30", or four digits from 0000 to
  // 1959 ("2026" is a year as often as 20:26). "3:30" is not one: it is an
  // hour with no am or pm, as "3.30" is.
  const colon = /^(\d{1,2}):(\d{2})$/.exec(t);
  const h24 = colon && !/^([1-9]|1[01])$/.test(colon[1]!) ? colon : /^([01]\d)(\d{2})$/.exec(t);
  if (h24) {
    const h = parseInt(h24[1]!, 10);
    const m = parseInt(h24[2]!, 10);
    return h <= 23 && m <= 59 ? { h, m } : null;
  }
  // An hour with no am or pm ("3", "3:30", "5 o'clock", "half past three"):
  // only a part of day can say which.
  const c = spokenClock(t);
  return c ? { ...c, bare: true } : null;
}

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "one" to "twelve" as 1 to 12, or null. */
function numberWord(word: string): number | null {
  const i = NUMBER_WORDS.indexOf(word);
  return i < 0 ? null : i + 1;
}

/** An hour 1-12 as said: digits or a word. */
function spokenHour(s: string): number | null {
  const h = /^\d{1,2}$/.test(s) ? parseInt(s, 10) : numberWord(s);
  return h !== null && h >= 1 && h <= 12 ? h : null;
}

/**
 * A clock time said with no am or pm, its hour 1-12: "3", "3:30", "9.30",
 * "three", "5 o'clock", "half past three", "quarter past four", "quarter to
 * five" (4:45). Null for anything else.
 */
function spokenClock(s: string): { h: number; m: number } | null {
  const digits = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
  if (digits) {
    const h = spokenHour(digits[1]!), m = digits[2] ? parseInt(digits[2], 10) : 0;
    return h !== null && m <= 59 ? { h, m } : null;
  }
  const word = /^(?:(\w+)(?: o'?clock| o clock)?|(half|quarter) past (\w+)|quarter to (\w+))$/.exec(s);
  if (!word) return null;
  if (word[1] !== undefined) {
    const h = spokenHour(word[1]);
    return h === null ? null : { h, m: 0 };
  }
  if (word[3] !== undefined) {
    const h = spokenHour(word[3]);
    return h === null ? null : { h, m: word[2] === 'half' ? 30 : 15 };
  }
  const next = spokenHour(word[4]!);
  return next === null ? null : { h: next === 1 ? 12 : next - 1, m: 45 };
}
