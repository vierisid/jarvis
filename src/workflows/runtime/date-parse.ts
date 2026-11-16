/**
 * Jarvis: the one date parser behind every Date Helper action that reads a
 * date string (format_date, date_difference, add_subtract_date,
 * extract_date_parts). It returns an INSTANT (epoch milliseconds), never a
 * wall clock read in the daemon's own zone, so a workflow gives the same
 * answer on a Rome Mac, a Kiritimati VM and a UTC host.
 *
 * Rules:
 * - The input must match the declared format from the first character to the
 *   last. Month names are English.
 * - The input must be a real calendar date and time (no Feb 29 in 2027, no
 *   month 13, no hour 25). Years run 0001 to 9999.
 * - An explicit offset at the end of a time input ("Z", "+05:45", "+0100",
 *   "GMT+0100 (CET)") wins over the zone setting. Fractional seconds are kept.
 * - Without an offset, the wall time is read in `zone`. A wall time the zone
 *   skips (spring forward) moves forward by the gap; one it repeats (fall back)
 *   is the earlier of the two, as JavaScript dates and Temporal do.
 * - Format `X` is Unix seconds within the same years. A value above the year
 *   9999 is refused, which is what milliseconds look like.
 * - A refusal quotes at most a short, single-line cut of the text it refuses,
 *   so a long or multi-line value from run data is not copied into the outcome.
 *
 * This module imports nothing, so the vendored piece can load it from the engine.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_UNIX_SECONDS = 253402300799; // 9999-12-31T23:59:59Z
const MIN_UNIX_SECONDS = -62135596800; // 0001-01-01T00:00:00Z
const QUOTE_MAX = 40;
const DAY_MS = 86_400_000;

type Field = 'year' | 'year2' | 'monthNum' | 'monthName' | 'monthShort' | 'day' | 'weekday' | 'hour' | 'hour12' | 'minute' | 'second' | 'milli' | 'meridiem';

const TOKENS: Record<string, { pattern: string; field?: Field }> = {
  YYYY: { pattern: '(\\d{4})', field: 'year' },
  YY: { pattern: '(\\d{2})', field: 'year2' },
  MMMM: { pattern: `(${MONTHS.join('|')})`, field: 'monthName' },
  MMM: { pattern: `(${MONTHS.map((m) => m.slice(0, 3)).join('|')})`, field: 'monthShort' },
  MM: { pattern: '(\\d{1,2})', field: 'monthNum' },
  M: { pattern: '(\\d{1,2})', field: 'monthNum' },
  DD: { pattern: '(\\d{1,2})', field: 'day' },
  D: { pattern: '(\\d{1,2})', field: 'day' },
  dddd: { pattern: `(${DAYS.join('|')})`, field: 'weekday' },
  ddd: { pattern: `(${DAYS.map((d) => d.slice(0, 3)).join('|')})`, field: 'weekday' },
  HH: { pattern: '(\\d{1,2})', field: 'hour' },
  H: { pattern: '(\\d{1,2})', field: 'hour' },
  hh: { pattern: '(\\d{1,2})', field: 'hour12' },
  h: { pattern: '(\\d{1,2})', field: 'hour12' },
  mm: { pattern: '(\\d{1,2})', field: 'minute' },
  m: { pattern: '(\\d{1,2})', field: 'minute' },
  ss: { pattern: '(\\d{1,2})', field: 'second' },
  s: { pattern: '(\\d{1,2})', field: 'second' },
  SSS: { pattern: '(\\d{3})', field: 'milli' },
  A: { pattern: '(am|pm)', field: 'meridiem' },
  a: { pattern: '(am|pm)', field: 'meridiem' },
};
const TOKEN_RE = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|A|a|\[[^\]]*\]|[A-Za-z]|\s+|[^A-Za-z\s]/g;
// Optional tail of a time input: ".123", then "Z" / "+05:45" / "+0100" / "GMT+0100", then " (CET)".
const OFFSET_TAIL = '(?:\\s*(?:GMT|UTC)?\\s*(Z|[+-]\\d{2}(?::?\\d{2})?))?(?:\\s*\\([^)]*\\))?';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A short, single-line cut of `value` for a refusal message. Date Helper's Add/Subtract Time quotes its expression with it too. */
export function quote(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  const chars = Array.from(flat);
  return `"${chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX).join('')}...` : flat}"`;
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `zone` from UTC in ms at the instant `ms`. */
function zoneOffsetMs(zone: string, ms: number): number {
  let fmt = offsetFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    offsetFormatters.set(zone, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(p['year'] as number, (p['month'] as number) - 1, p['day'] as number);
  asUtc.setUTCHours(p['hour'] as number, p['minute'] as number, p['second'] as number, 0);
  return asUtc.getTime() - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which `zone` shows the wall time `wallMs` (read as UTC).
 * The offsets a day before and a day after bracket any transition: a wall
 * time both of them map back to is repeated (take the earlier instant), one
 * neither maps back to is skipped (read it with the offset before the gap,
 * which lands after the gap). Same result on every daemon and in every zone.
 */
function wallToInstant(zone: string, wallMs: number): number {
  const before = zoneOffsetMs(zone, wallMs - DAY_MS);
  const after = zoneOffsetMs(zone, wallMs + DAY_MS);
  const valid = [wallMs - before, wallMs - after].filter((t) => zoneOffsetMs(zone, t) === wallMs - t);
  return valid.length > 0 ? Math.min(...valid) : wallMs - before;
}

export function assertKnownZone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`${quote(String(zone))} is not a time zone this step knows. Pick a zone from the list.`);
  }
}

/** Parse `input` per `format` (dayjs-style tokens) and return epoch milliseconds. Throws a plain-English Error. */
export function parseDateInstant(input: string, format: string, zone = 'UTC'): number {
  const text = String(input ?? '').trim();
  const fmt = format.trim();
  assertKnownZone(zone);
  const shown = quote(text);
  const mismatch = () => new Error(`The date ${shown} does not match the format ${quote(format)}. Check the date and its format setting.`);

  if (fmt === 'X') {
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw mismatch();
    const seconds = Number(text);
    if (seconds < MIN_UNIX_SECONDS) throw new Error(`${shown} is before the year 0001 as a Unix time in seconds.`);
    if (seconds > MAX_UNIX_SECONDS) {
      throw new Error(`${shown} is too large to be a Unix time in seconds. If it is in milliseconds, divide it by 1000.`);
    }
    return Math.round(seconds * 1000);
  }

  const fields: Field[] = [];
  let pattern = '';
  let hasTime = false;
  let hasSeconds = false;
  let hasMilli = false;
  for (const tok of fmt.match(TOKEN_RE) ?? []) {
    const def = TOKENS[tok];
    if (def) {
      pattern += def.pattern;
      fields.push(def.field as Field);
      if (['hour', 'hour12', 'minute', 'second', 'milli'].includes(def.field as string)) hasTime = true;
      if (def.field === 'second') hasSeconds = true;
      if (def.field === 'milli') hasMilli = true;
    } else if (tok.startsWith('[')) {
      pattern += escapeRe(tok.slice(1, -1));
    } else if (/^\s+$/.test(tok)) {
      pattern += '\\s+';
    } else if (tok === 'T' || !/[A-Za-z]/.test(tok)) {
      pattern += escapeRe(tok);
    } else {
      throw new Error(`The date format ${quote(format)} is not supported. Pick a format from the list.`);
    }
  }
  if (hasSeconds && !hasMilli) pattern += '(?:\\.(\\d{1,9}))?';
  if (hasTime) pattern += OFFSET_TAIL;
  const match = new RegExp(`^${pattern}$`, 'i').exec(text);
  if (!match) throw mismatch();

  let year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0, milli = 0;
  let hour12: number | undefined;
  let pm: boolean | undefined;
  fields.forEach((field, i) => {
    const v = match[i + 1] as string;
    switch (field) {
      case 'year': year = Number(v); break;
      case 'year2': year = Number(v) + (Number(v) > 68 ? 1900 : 2000); break;
      case 'monthNum': month = Number(v); break;
      case 'monthName': month = MONTHS.indexOf(v.toLowerCase()) + 1; break;
      case 'monthShort': month = MONTHS.findIndex((m) => m.startsWith(v.toLowerCase())) + 1; break;
      case 'day': day = Number(v); break;
      case 'hour': hour = Number(v); break;
      case 'hour12': hour12 = Number(v); break;
      case 'minute': minute = Number(v); break;
      case 'second': second = Number(v); break;
      case 'milli': milli = Number(v); break;
      case 'meridiem': pm = v.toLowerCase() === 'pm'; break;
      default: break;
    }
  });
  // A part the format lacks defaults to 1970-01-01 00:00. Every format the
  // dropdown offers has a year, month and day, and the step's input check
  // refuses any other format value, so the 1970 default is never reached there.
  const tail = match.slice(fields.length + 1);
  const fraction = hasSeconds && !hasMilli ? tail[0] : undefined;
  const offsetText = hasTime ? tail[hasSeconds && !hasMilli ? 1 : 0] : undefined;
  if (fraction) milli = Math.floor(Number(`0.${fraction}`) * 1000);
  if (hour12 !== undefined) {
    if (hour12 < 1 || hour12 > 12) throw new Error(`${shown} is not a real time: the hour must be 1 to 12.`);
    hour = (hour12 % 12) + (pm ? 12 : 0);
  }

  const real = year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour <= 23 && minute <= 59 && second <= 59;
  if (!real) throw new Error(`${shown} is not a real date or time.`);

  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, milli);
  const wallMs = wall.getTime();

  if (offsetText) {
    if (offsetText.toUpperCase() === 'Z') return wallMs;
    const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(offsetText) as RegExpExecArray;
    const hh = Number(m[2]);
    const mm = Number(m[3] ?? 0);
    if (hh > 23 || mm > 59) throw new Error(`${shown} has an offset that is not real.`);
    return wallMs - (m[1] === '-' ? -1 : 1) * (hh * 60 + mm) * 60000;
  }
  return wallToInstant(zone, wallMs);
}
