/**
 * Phase 6.7.A — lightweight relative-date parser used by the Calendar
 * Room's `schedule_event` voice action.
 *
 * The classifier extracts a `when` slot as a free-form string ("tuesday
 * at 3", "tomorrow", "in 3 days", "2026-04-30 15:00"). This parser
 * normalizes that string to a Unix timestamp in milliseconds, with a
 * confidence band so the caller can reject ambiguous inputs.
 *
 * Deliberately small — no chrono-node dep. Covers ~90% of likely
 * utterances; unknown formats return `null` and the caller falls back
 * to the chat agent (which can handle the request as a normal task).
 *
 * Times default to 09:00 local when only a date is given. Dates default
 * to today when only a time is given.
 */

export interface ParsedDate {
  /** Unix ms in local timezone. */
  ts: number;
  /** 0..1 — 1 = exact ISO match, 0.6 = fuzzy weekday match, 0.4 = bare time. */
  confidence: number;
}

/** Parse a relative or absolute date string to a timestamp. Returns null
 *  if the string can't be confidently interpreted. `now` is injectable
 *  for testing (defaults to Date.now()). */
export function parseRelativeDate(input: string, now: number = Date.now()): ParsedDate | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const today = startOfDay(new Date(now));

  // 1. ISO-like absolute: "2026-04-30" or "2026-04-30 15:00" or "2026-04-30T15:00"
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2})(?::(\d{2}))?(?::\d{2})?)?$/i);
  if (isoMatch) {
    const [, y, mo, d, h, mi] = isoMatch;
    const date = new Date(
      parseInt(y!, 10),
      parseInt(mo!, 10) - 1,
      parseInt(d!, 10),
      h ? parseInt(h, 10) : 9,
      mi ? parseInt(mi, 10) : 0,
      0, 0,
    );
    if (!isNaN(date.getTime())) {
      return { ts: date.getTime(), confidence: 1 };
    }
  }

  // 2. "today" / "tomorrow" / "yesterday" + optional time
  let baseDate: Date | null = null;
  let confidenceFloor = 0.9;
  let remainder = text;

  if (remainder.startsWith('today')) {
    baseDate = new Date(today);
    remainder = remainder.slice(5).trim().replace(/^(at|@)\s*/i, '');
  } else if (remainder.startsWith('tomorrow')) {
    baseDate = addDays(today, 1);
    remainder = remainder.slice(8).trim().replace(/^(at|@)\s*/i, '');
  } else if (remainder.startsWith('yesterday')) {
    baseDate = addDays(today, -1);
    remainder = remainder.slice(9).trim().replace(/^(at|@)\s*/i, '');
  }

  // 3. "in N days/hours/minutes/weeks"
  if (!baseDate) {
    const inMatch = text.match(/^in\s+(\d+)\s+(minute|min|hour|hr|day|week)s?$/);
    if (inMatch) {
      const n = parseInt(inMatch[1]!, 10);
      const unit = inMatch[2]!;
      const ms =
        unit.startsWith('min') ? n * 60_000 :
        unit.startsWith('hr') || unit === 'hour' ? n * 3_600_000 :
        unit === 'day' ? n * 86_400_000 :
        unit === 'week' ? n * 7 * 86_400_000 : 0;
      if (ms > 0) return { ts: now + ms, confidence: 0.85 };
    }
  }

  // 4. "next monday" / "next tuesday" — next instance after today
  if (!baseDate) {
    const nextMatch = text.match(/^next\s+(sun|mon|tue|tues|wed|thu|thur|fri|sat)(?:day|nesday|sday|urday)?(.*)$/);
    if (nextMatch) {
      const target = weekdayIndex(nextMatch[1]!);
      if (target !== null) {
        const today_dow = today.getDay();
        const diff = ((target - today_dow + 7) % 7) || 7;
        baseDate = addDays(today, diff);
        remainder = nextMatch[2]!.trim().replace(/^(at|@)\s*/i, '');
        confidenceFloor = 0.8;
      }
    }
  }

  // 5. Bare weekday: "tuesday" or "tuesday at 3" — next instance (today if same dow)
  if (!baseDate) {
    const dowMatch = text.match(/^(sun|mon|tue|tues|wed|thu|thur|fri|sat)(?:day|nesday|sday|urday)?(.*)$/);
    if (dowMatch) {
      const target = weekdayIndex(dowMatch[1]!);
      if (target !== null) {
        const today_dow = today.getDay();
        const diff = (target - today_dow + 7) % 7;
        baseDate = addDays(today, diff);
        remainder = dowMatch[2]!.trim().replace(/^(at|@)\s*/i, '');
        confidenceFloor = 0.7;
      }
    }
  }

  // 6. Bare time only: "3pm", "15:00", "3:30pm" — assume today (or
  //    tomorrow if the time is already past).
  let timeOfDay: { h: number; m: number } | null = null;
  if (!baseDate) {
    const t = parseTime(text);
    if (t) {
      let day = new Date(today);
      const candidate = new Date(day);
      candidate.setHours(t.h, t.m, 0, 0);
      if (candidate.getTime() < now) {
        day = addDays(today, 1);
      }
      const out = new Date(day);
      out.setHours(t.h, t.m, 0, 0);
      return { ts: out.getTime(), confidence: 0.6 };
    }
    return null;
  }

  // Apply remainder time if present, else default to 09:00.
  if (remainder) {
    const t = parseTime(remainder);
    if (t) timeOfDay = t;
  }
  const out = new Date(baseDate);
  out.setHours(timeOfDay?.h ?? 9, timeOfDay?.m ?? 0, 0, 0);
  // If we hit the today path and time is past, bump to tomorrow.
  if (out.getTime() < now && /^(today)/.test(text)) {
    out.setDate(out.getDate() + 1);
  }
  return { ts: out.getTime(), confidence: timeOfDay ? confidenceFloor : Math.max(0.5, confidenceFloor - 0.2) };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function weekdayIndex(prefix: string): number | null {
  const map: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, fri: 5, sat: 6,
  };
  return prefix in map ? map[prefix]! : null;
}

/**
 * Parse a time expression: "3pm", "3:30pm", "15:00", "9am". Returns
 * null if the input doesn't look like a time.
 */
function parseTime(input: string): { h: number; m: number } | null {
  const t = input.trim();
  if (!t) return null;
  // 24h: "15:00" / "15:30"
  const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1]!, 10);
    const m = parseInt(h24[2]!, 10);
    if (h <= 23 && m <= 59) return { h, m };
  }
  // 12h: "3pm", "3:30pm", "12am"
  const h12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (h12) {
    let h = parseInt(h12[1]!, 10);
    const m = h12[2] ? parseInt(h12[2], 10) : 0;
    const isPm = h12[3]!.toLowerCase() === 'pm';
    if (h < 1 || h > 12 || m > 59) return null;
    if (h === 12) h = 0;
    if (isPm) h += 12;
    return { h, m };
  }
  return null;
}
