/**
 * One reader of a time, for every part of the notch that turns words into a
 * time or a schedule: the schedule in a sentence that asks for an agent
 * (./agents.ts), the lit word of a shown job's schedule (./teach.ts), the
 * evening's "move it to" (./day.ts) and a day and a time said over a line
 * (./said.ts).
 *
 * There used to be four, and each rewrote what it could not read: "every
 * weekday at 9" became every day, "every morning at 6" became 18:00, "every
 * night at 11" 11:00, "every 2 weeks" every day, and of "every monday at 9am
 * and friday at 4pm" only the first was kept (the review of 26 November
 * 2026, docs/notch/fixes/03-intent-routing.md).
 *
 * The rules, the same for all of them:
 *
 *   - Every word of a schedule is read, or it is no schedule. What cannot be
 *     read is refused, never turned into something near it: "every 2 weeks",
 *     "every other day", "every month", a second time ("and friday at 4pm"),
 *     an hour that is none ("at 25").
 *   - A weekday is Monday to Friday.
 *   - "Morning", "afternoon", "evening" and "night" say which half of the day
 *     an hour is in, and so do "am" and "pm". An hour that contradicts them
 *     ("morning at 6pm") is refused.
 *   - A bare hour from one to six, with none of those beside it, is the
 *     afternoon: nobody means five in the morning by "at 5.10". It is marked
 *     as a guess (`guessed`). Not for what the notch wrote itself (`exact`):
 *     "day at 6:00" on a line of its own is six in the morning, as written.
 *   - No time said: nine, six in the evening for "every evening", nine at
 *     night for "every night". Those are defaults, said back on the line.
 *
 * Nothing here has a state or a clock, and nothing is imported: the moment
 * things are counted from is handed in.
 */

/** A part of the day that was said. */
export type WhenPart = 'morning' | 'afternoon' | 'evening' | 'night';

/**
 * A time as the notch keeps one. By the week: `days` are the days it is on,
 * 0 for Sunday to 6 for Saturday, in order, and all seven is every day. One
 * moment: one day of `days`, or none and `rel`.
 */
export interface NotchWhen {
  days: number[];
  /** A day that is counted from now, when no day of the week was said. */
  rel?: 'today' | 'tomorrow' | 'next week';
  hour: number;
  minute: number;
  /** The hour was said bare ("at 6") and taken for the afternoon. */
  guessed?: true;
}

export interface WhenOptions {
  /** The words are the notch's own writing ("day at 6:00"): an hour is what it says, and nothing is guessed. */
  exact?: boolean;
  /** The last bare hour that is taken for the afternoon. Six, but for what is said over a line (seven: "nobody meets at seven in the night"). */
  guessTo?: number;
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const DAY_AT: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  sundays: 0, mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4, fridays: 5, saturdays: 6,
};
export const WHEN_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const PARTS = new Set(['morning', 'afternoon', 'evening', 'night']);
/** What may stand after "every" and is a schedule the notch cannot say: "every 2 weeks", "every other day", "every month". */
const UNSAID = /^(?:\d+|other|first|second|third|fourth|fifth|last|half|couple|few|hours?|minutes?|mins?|seconds?|secs?|months?|years?|weekends?|fortnights?|quarters?|weeks|days|mornings|evenings|nights|afternoons?)$/;

/** What was said, as plain small-letter words. Numbers said as words are digits, "p.m." is "pm", "9.30" and "9h30" are "9:30". */
export function whenWords(said: string): string[] {
  return said.toLowerCase()
    .replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/o'clock/g, ' ')
    .replace(/[’']/g, '')
    .replace(/(\d)[.:h](\d{2})(?!\d)/g, '$1:$2')
    .replace(/[^\p{L}\p{N}: ]+/gu, ' ')
    .split(/\s+/).filter(Boolean)
    .map((word) => (word in NUMBERS ? String(NUMBERS[word]) : word));
}

const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((day, at) => day === b[at]);
const sorted = (days: Iterable<number>): number[] => [...new Set(days)].sort((a, b) => a - b);

/** The days from one to another, as a week goes: Monday to Friday, Friday to Monday. */
function span(from: number, to: number): number[] {
  const days: number[] = [];
  for (let day = from; ; day = (day + 1) % 7) { days.push(day); if (day === to || days.length === 7) break; }
  return sorted(days);
}

/**
 * Days named from `at` on: "monday", "monday and friday", "monday wednesday
 * and friday", "monday to friday", "weekday", "weekdays", "working day".
 * How many words they took. Null when no day stands there.
 */
function daysAt(words: readonly string[], at: number): { days: number[]; len: number } | null {
  const word = words[at];
  if (word === undefined) return null;
  if (word === 'weekday' || word === 'weekdays' || word === 'workday' || word === 'workdays') return { days: WEEKDAYS, len: 1 };
  if ((word === 'working' || word === 'work') && (words[at + 1] === 'day' || words[at + 1] === 'days')) return { days: WEEKDAYS, len: 2 };
  if (!(word in DAY_AT)) return null;
  const first = DAY_AT[word]!;
  const next = words[at + 1];
  const after = words[at + 2];
  if ((next === 'to' || next === 'through' || next === 'thru' || next === 'till' || next === 'until') && after !== undefined && after in DAY_AT) {
    return { days: span(first, DAY_AT[after]!), len: 3 };
  }
  const days = [first];
  let len = 1;
  for (;;) {
    const one = words[at + len];
    const two = words[at + len + 1];
    if (one !== undefined && one in DAY_AT) { days.push(DAY_AT[one]!); len += 1; continue; }
    if (one === 'and' && two !== undefined && two in DAY_AT) { days.push(DAY_AT[two]!); len += 2; continue; }
    break;
  }
  return { days: sorted(days), len };
}

/**
 * What stands after "every" or "each", from `at` on: "day", "weekday",
 * "week" (Monday), "week on friday", "morning", "evening", "night", a day or
 * several. 'unsaid': a schedule the notch cannot say ("2 weeks", "other
 * day", "month"). Null: not a schedule at all ("every invoice").
 */
function unitAt(words: readonly string[], at: number): { days: number[]; part: WhenPart | null; len: number } | 'unsaid' | null {
  const word = words[at];
  if (word === undefined) return null;
  if (word === 'day') return { days: EVERY_DAY, part: null, len: 1 };
  if (word === 'single' && words[at + 1] === 'day') return { days: EVERY_DAY, part: null, len: 2 };
  if (word === 'week') {
    // "Every week on Friday": the day of it is said.
    const on = words[at + 1] === 'on' ? daysAt(words, at + 2) : null;
    return on ? { days: on.days, part: null, len: 2 + on.len } : { days: [1], part: null, len: 1 };
  }
  if (word === 'morning' || word === 'evening' || word === 'night') return { days: EVERY_DAY, part: word, len: 1 };
  const days = daysAt(words, at);
  if (days) {
    const part = words[at + days.len];
    return part !== undefined && PARTS.has(part) ? { days: days.days, part: part as WhenPart, len: days.len + 1 } : { days: days.days, part: null, len: days.len };
  }
  return UNSAID.test(word) ? 'unsaid' : null;
}

interface TimeSaid { hour: number; minute: number; half: 'am' | 'pm' | null; /** Written as a clock writes it ("06:00", "14:30"): nothing to guess. */ written: boolean; len: number }
const isHalf = (word: string | undefined): word is 'am' | 'pm' => word === 'am' || word === 'pm';

/**
 * A time from `at` on: "9", "9:30", "9am", "9 pm", "half past 9", "quarter
 * to 10", "9 thirty", "noon", "midnight". 'bad': a number stands there that
 * is no time ("25", "9:75"). Null: no time stands there.
 */
function timeAt(words: readonly string[], at: number): TimeSaid | 'bad' | null {
  const word = words[at];
  if (word === undefined) return null;
  const next = words[at + 1];
  const after = words[at + 2];
  if (word === 'noon' || word === 'midday') return { hour: 12, minute: 0, half: null, written: true, len: 1 };
  if (word === 'midnight') return { hour: 0, minute: 0, half: null, written: true, len: 1 };
  if ((word === 'half' || word === 'quarter') && (next === 'past' || next === 'to') && after !== undefined && /^\d{1,2}$/.test(after)) {
    let hour = Number(after);
    let minute = word === 'half' ? 30 : 15;
    if (next === 'to') { hour -= 1; minute = 60 - minute; }
    const half = isHalf(words[at + 3]) ? words[at + 3] as 'am' | 'pm' : null;
    if (hour < 0 || hour > 23 || (half && (hour < 1 || hour > 12))) return 'bad';
    return { hour, minute, half, written: false, len: half ? 4 : 3 };
  }
  const whole = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word);
  if (!whole) return null;
  const hour = Number(whole[1]);
  let minute = whole[2] ? Number(whole[2]) : 0;
  let len = 1;
  // "9 30", "10 thirty", "9 fifteen", "9 forty five".
  if (!whole[2] && !whole[3]) {
    const spoken = next === 'thirty' ? 30 : next === 'fifteen' ? 15 : next === 'forty' && after === '5' ? 45 : next && /^(00|15|30|45)$/.test(next) ? Number(next) : null;
    if (spoken !== null) { minute = spoken; len += next === 'forty' ? 2 : 1; }
  }
  let half: 'am' | 'pm' | null = (whole[3] as 'am' | 'pm' | undefined) ?? null;
  if (!half && isHalf(words[at + len])) { half = words[at + len] as 'am' | 'pm'; len += 1; }
  if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) return 'bad';
  // A leading nought, or an hour past twelve, is a clock's writing: "06:00" is six in the morning.
  const written = (whole[1]!.length === 2 && whole[1]!.startsWith('0')) || hour > 12 || hour === 0;
  return { hour, minute, half, written, len };
}

/** The hour of the day a time is, with the part of the day that was said beside it. Null: they contradict each other. */
function hourOf(time: TimeSaid, part: WhenPart | null, options: WhenOptions): { hour: number; guessed: boolean } | null {
  let hour = time.hour;
  if (time.half === 'pm' && hour < 12) hour += 12;
  else if (time.half === 'am' && hour === 12) hour = 0;
  else if (!time.half && !time.written && part) {
    if (part === 'morning') { if (hour === 12) return null; }
    else if (part === 'night') { if (hour === 12) hour = 0; else if (hour >= 6) hour += 12; }
    else if (hour < 12) hour += 12;
  } else if (!time.half && !time.written && !part && !options.exact && hour >= 1 && hour <= (options.guessTo ?? 6)) {
    return { hour: hour + 12, guessed: true };
  }
  if (part === 'morning' && hour >= 12) return null;
  if (part === 'afternoon' && (hour < 12 || hour > 18)) return null;
  if (part === 'evening' && hour < 16) return null;
  if (part === 'night' && hour > 5 && hour < 18) return null;
  return { hour, guessed: false };
}

/** "In the morning", "in the evening", "at night", from `at` on: the part, and how many words. */
function partAt(words: readonly string[], at: number): { part: WhenPart; len: number } | null {
  if (words[at] === 'in' && words[at + 1] === 'the' && PARTS.has(words[at + 2] ?? '')) return { part: words[at + 2] as WhenPart, len: 3 };
  if (words[at] === 'at' && words[at + 1] === 'night') return { part: 'night', len: 2 };
  return null;
}

// --- what was said over a line: a day, a time, a part of the day, wherever they stand ---

export interface WhenSaid {
  /** The days that were said, or null. */
  days: number[] | null;
  rel: 'today' | 'tomorrow' | null;
  /** "Every" or "each" was said, or "daily", "weekly". */
  every: boolean;
  hour: number | null;
  minute: number;
  /** A part of the day that was said with no hour: "Friday afternoon". */
  part: 'morning' | 'afternoon' | null;
  guessed: boolean;
  /** Which of the words the day used, and which all of it used. */
  dayAt: Set<number>;
  used: Set<number>;
}

/**
 * The day and the time in a few words that were said, with which of the
 * words they used: "friday at 10", "half past 9", "3 pm", "every weekday at
 * 9", "at 6 in the morning". The words it did not use are the caller's to
 * account for. A schedule that cannot be said ("every 2 weeks at 9"), or an
 * hour that contradicts its part of the day, uses none: nothing is read.
 */
export function whenSaid(words: readonly string[], options: WhenOptions = {}): WhenSaid {
  const none = (): WhenSaid => ({ days: null, rel: null, every: false, hour: null, minute: 0, part: null, guessed: false, dayAt: new Set(), used: new Set() });
  const found = none();
  let time: (TimeSaid & { at: number }) | null = null;
  let part: { part: WhenPart; at: number } | null = null;
  const take = (set: Set<number>, from: number, len: number): void => { for (let more = 0; more < len; more++) set.add(from + more); };
  for (let at = 0; at < words.length; at++) {
    if (found.used.has(at)) continue;
    const word = words[at]!;
    const noDay = found.days === null && found.rel === null;
    if (word === 'every' || word === 'each') {
      const unit = unitAt(words, at + 1);
      if (unit === 'unsaid') return none();
      if (unit && noDay) {
        found.every = true;
        found.days = unit.days;
        take(found.used, at, 1 + unit.len);
        take(found.dayAt, at, 1 + unit.len);
        if (unit.part) { part ??= { part: unit.part, at: at + unit.len }; found.dayAt.delete(at + unit.len); }
      }
      continue;
    }
    if ((word === 'daily' || word === 'weekly') && noDay) {
      found.every = true;
      found.days = word === 'daily' ? EVERY_DAY : [1];
      found.used.add(at); found.dayAt.add(at);
      continue;
    }
    if (noDay && (word === 'today' || word === 'tomorrow')) { found.rel = word; found.used.add(at); found.dayAt.add(at); continue; }
    if (noDay) {
      const days = daysAt(words, at);
      if (days) { found.days = days.days; take(found.used, at, days.len); take(found.dayAt, at, days.len); continue; }
    }
    if (!part && PARTS.has(word)) { part = { part: word as WhenPart, at }; found.used.add(at); continue; }
    if (time) continue;
    const read = timeAt(words, at);
    if (!read || read === 'bad') continue;
    time = { ...read, at };
    take(found.used, at, read.len);
  }
  if (time) {
    const hour = hourOf(time, part?.part ?? null, options);
    if (!hour) return none();
    found.hour = hour.hour;
    found.minute = time.minute;
    found.guessed = hour.guessed;
  } else if (part) {
    // A part of the day with no hour: only the two halves a meeting is put in. "Night" alone is not read.
    if (part.part === 'morning' || part.part === 'afternoon') found.part = part.part;
    else found.used.delete(part.at);
  }
  return found;
}

// --- a value that is a time and nothing else: a lit word, a stored schedule ---

/**
 * A whole value read as a time: "Monday at 9:00", "day at 9:00", "weekday at
 * 9", "Monday to Friday at 9:00", "every Monday at 9", "morning at 6",
 * "tomorrow at 9:00", "next week" (Monday at nine). Every word of it has to
 * be read, and it has to say a day and an hour. Null otherwise.
 */
export function readWhen(text: string, options: WhenOptions = {}): NotchWhen | null {
  const words = whenWords(text);
  if (words.length === 0 || words.length > 12) return null;
  if (words.join(' ') === 'next week') return { days: [], rel: 'next week', hour: 9, minute: 0 };
  let at = 0;
  let days: number[] | null = null;
  let rel: NotchWhen['rel'];
  let part: WhenPart | null = null;
  const every = words[0] === 'every' || words[0] === 'each';
  if (every) at = 1;
  if (words[at] === 'today' || words[at] === 'tomorrow') {
    if (every) return null;
    rel = words[at] as 'today' | 'tomorrow';
    days = [];
    at += 1;
  } else if (words[at] === 'daily' && !every) { days = EVERY_DAY; at += 1; } else {
    const unit = unitAt(words, at);
    if (!unit || unit === 'unsaid') return null;
    days = unit.days;
    part = unit.part;
    at += unit.len;
  }
  const more = partAt(words, at);
  if (more) { if (part && part !== more.part) return null; part = more.part; at += more.len; }
  if (words[at] === 'at') at += 1;
  const time = timeAt(words, at);
  if (!time || time === 'bad') return null;
  at += time.len;
  const late = partAt(words, at);
  if (late) { if (part && part !== late.part) return null; part = late.part; at += late.len; }
  if (at !== words.length) return null;
  const hour = hourOf(time, part, options);
  if (!hour) return null;
  return { days, ...(rel ? { rel } : {}), hour: hour.hour, minute: time.minute, ...(hour.guessed ? { guessed: true as const } : {}) };
}

// --- the schedule in a sentence: "every Monday send Sam the numbers" ---

/**
 * The schedule a sentence names, and the sentence without it: "sends me the
 * news every day at 5.10" is every day at 17:10 and "sends me the news".
 *
 *   'unsaid'  it names a schedule, and not one the notch can say: "every 2
 *             weeks", a second time, an hour that is none. Nothing is made
 *             of it: whoever asked hands the sentence on as it was said.
 *   null      it names no schedule.
 */
export function readSchedule(text: string, options: WhenOptions = {}): { when: NotchWhen; rest: string } | 'unsaid' | null {
  const raw = text.split(/\s+/).filter(Boolean);
  // Each word as it is read, with the word of the sentence it came from: what is left of the sentence is said back as it was written.
  const words: string[] = [];
  const from: number[] = [];
  raw.forEach((one, index) => { for (const word of whenWords(one)) { words.push(word); from.push(index); } });
  const used = new Set<number>();
  const take = (start: number, len: number): void => { for (let more = 0; more < len; more++) used.add(start + more); };

  let days: number[] | null = null;
  let part: WhenPart | null = null;
  let time: TimeSaid | null = null;
  let end = -1;
  for (let at = 0; at < words.length && days === null; at++) {
    const word = words[at]!;
    if (word === 'every' || word === 'each') {
      const unit = unitAt(words, at + 1);
      if (unit === 'unsaid') return 'unsaid';
      if (!unit) continue;
      days = unit.days;
      part = unit.part;
      take(at, 1 + unit.len);
      end = at + 1 + unit.len;
    } else if (word === 'daily' || word === 'weekly') {
      days = word === 'daily' ? EVERY_DAY : [1];
      take(at, 1);
      end = at + 1;
    }
  }
  /** A time that stands at `at`: after "at", or written so that it can be nothing else ("16:30", "9am", "9 pm"). */
  const timeHere = (at: number): { time: TimeSaid; len: number } | 'bad' | null => {
    if (words[at] === 'at') {
      const read = timeAt(words, at + 1);
      return read === 'bad' ? 'bad' : read ? { time: read, len: 1 + read.len } : null;
    }
    const read = timeAt(words, at);
    if (!read || read === 'bad') return null;
    return /[:]|am$|pm$/.test(words[at]!) || read.half ? { time: read, len: read.len } : null;
  };
  if (days !== null) {
    // What follows the days is theirs: the part of the day, the time, in either order.
    for (let round = 0; round < 3; round++) {
      const said = partAt(words, end);
      if (said) {
        if (part && part !== said.part) return 'unsaid';
        part = said.part; take(end, said.len); end += said.len;
        continue;
      }
      if (time) break;
      const here = timeHere(end);
      if (here === 'bad') return 'unsaid';
      if (!here) break;
      time = here.time; take(end, here.len); end += here.len;
    }
    // And it ends there. "And friday at 4pm", "and every sunday", "or at 10": a second time is no schedule the notch can say.
    const join = words[end];
    const then = words[end + 1];
    if (time && join !== undefined && join in DAY_AT) return 'unsaid';
    if ((join === 'and' || join === 'or' || join === 'plus') && then !== undefined
      && (then in DAY_AT || then === 'every' || then === 'each' || then === 'weekdays' || then === 'weekday' || then === 'daily' || then === 'weekly' || timeHere(end + 1) !== null)) return 'unsaid';
  }
  if (!time) {
    // The time may stand elsewhere in the sentence: "send me the news every day at 5.10" has it beside the day,
    // "every day send me the news at 5.10" at the end. One such time is the schedule's. Two are not read.
    const elsewhere: { at: number; time: TimeSaid; len: number }[] = [];
    for (let at = 0; at < words.length; at++) {
      if (used.has(at) || words[at] !== 'at') continue;
      const here = timeHere(at);
      if (here && here !== 'bad') { elsewhere.push({ at, ...here }); at += here.len - 1; }
    }
    if (elsewhere.length > 1) return 'unsaid';
    const [one] = elsewhere;
    if (one) {
      time = one.time;
      take(one.at, one.len);
      const said = partAt(words, one.at + one.len);
      if (said) { if (part && part !== said.part) return 'unsaid'; part = said.part; take(one.at + one.len, said.len); }
      days ??= EVERY_DAY;
    }
  }
  if (days === null) return null;
  let hour = part === 'evening' ? 18 : part === 'night' ? 21 : 9;
  let minute = 0;
  let guessed = false;
  if (time) {
    const read = hourOf(time, part, options);
    if (!read) return 'unsaid';
    hour = read.hour; minute = time.minute; guessed = read.guessed;
  }
  // A word of the sentence that was read only in part ("9-5") was not read.
  const gone = new Set<number>();
  for (const at of used) gone.add(from[at]!);
  for (let at = 0; at < words.length; at++) if (!used.has(at) && gone.has(from[at]!)) return 'unsaid';
  // "O'clock" reads as no word: it goes with the hour before it.
  const kept = raw.filter((one, index) => !gone.has(index) && !(gone.has(index - 1) && whenWords(one).length === 0));
  const rest = kept.join(' ').replace(/\s+,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ');
  return { when: { days, hour, minute, ...(guessed ? { guessed: true as const } : {}) }, rest };
}

// --- saying it, and counting it ---

/** The days as the notch says them: "day", "Monday", "Monday to Friday", "Monday and Friday", "Monday, Wednesday and Friday". */
export function sayDays(days: readonly number[]): string {
  if (days.length === 7) return 'day';
  if (same(days, WEEKDAYS)) return 'Monday to Friday';
  // A week is said from Monday.
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => WHEN_DAY_NAMES[day]!);
  return names.length <= 1 ? (names[0] ?? 'day') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A time as the notch says it, and reads it back (`readWhen`, `exact`): "Monday at 9:00", "day at 17:10", "tomorrow at 9:00", "next week". */
export function sayWhen(when: NotchWhen): string {
  if (when.rel === 'next week') return 'next week';
  return `${when.rel ?? sayDays(when.days)} at ${when.hour}:${String(when.minute).padStart(2, '0')}`;
}

/**
 * The same, in words that are read the same way by a reader that guesses:
 * "day at 6:00am". For a sentence that is built to be read again.
 */
export function sayWhenPlain(when: NotchWhen): string {
  const half = when.hour < 12 ? 'am' : 'pm';
  const hour = when.hour % 12 === 0 ? 12 : when.hour % 12;
  return `${when.rel ?? sayDays(when.days)} at ${hour}:${String(when.minute).padStart(2, '0')}${half}`;
}

/** The next time after `after` that a time by the week comes round, on this machine's clock. */
export function nextWhen(when: NotchWhen, after: number): number {
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setHours(when.hour, when.minute);
  for (let tries = 0; tries < 9; tries++) {
    if (at.getTime() > after && (when.days.length === 0 || when.days.includes(at.getDay()))) return at.getTime();
    at.setDate(at.getDate() + 1);
    at.setHours(when.hour, when.minute, 0, 0);
  }
  return at.getTime();
}

/**
 * The one moment a time names, counted from `now` on this machine's clock:
 * today or tomorrow at that hour, the next such day of the week (a day named
 * on that day itself is a week on), Monday for "next week". Null when it
 * names several days, or the moment is not ahead.
 */
export function whenMoment(when: NotchWhen, now: number): number | null {
  const at = new Date(now);
  let days: number;
  if (when.rel === 'today') days = 0;
  else if (when.rel === 'tomorrow') days = 1;
  else if (when.rel === 'next week') days = ((8 - at.getDay()) % 7) || 7;
  else if (when.days.length === 1) days = ((when.days[0]! - at.getDay() + 7) % 7) || 7;
  else return null;
  const moment = new Date(now);
  moment.setDate(moment.getDate() + days);
  moment.setHours(when.hour, when.minute, 0, 0);
  return moment.getTime() > now ? moment.getTime() : null;
}
