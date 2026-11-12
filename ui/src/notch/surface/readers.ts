/**
 * Typing your own value into a lit word. Jarvis writes back what it
 * understood, or refuses and keeps the old one. Nothing here touches the page,
 * so it can be tested as plain functions.
 */
import type { NotchWord } from '../../../../src/notch/protocol.ts';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The day named in a lowercase text: a weekday by its first three letters, today or tomorrow. */
export const dayIn = (low: string): string | null =>
  DAYS.find(d => new RegExp('\\b' + d.slice(0, 3).toLowerCase()).test(low)) ?? (/\btoday\b/.test(low) ? 'today' : /\b(tomorrow|tmrw)\b/.test(low) ? 'tomorrow' : null);

/** The time named in a lowercase text, as H:MM on a 24 hour clock. A bare 1 to 7 is taken as the afternoon. */
export const timeIn = (low: string): string | null => {
  const m = low.match(/\b(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (!m[3] && !m[2] && h >= 1 && h <= 7) h += 12;
  return h < 24 && mi < 60 ? `${h}:${String(mi).padStart(2, '0')}` : null;
};

/** True when the text is a day or a time and nothing else: it does not guess from stray digits. */
export const onlyWhen = (low: string): boolean =>
  !low.replace(/\d+/g, ' ').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*|\b(today|tomorrow|tmrw|at|on|am|pm|every|day|next|this|h)\b|[\s:.,]/g, '');

type Reader = (v: string, L: NotchWord) => string | null;

/** One reader per kind of value a lit word can hold. Each returns the value as Jarvis says it, or null. */
export const READ: Record<NonNullable<NotchWord['read']>, Reader> = {
  day: v => (onlyWhen(v.toLowerCase()) ? dayIn(v.toLowerCase()) : null),
  dayTime: (v, L) => {
    const low = v.toLowerCase(), cur = L.value.split(' at '), d = dayIn(low), t = timeIn(low);
    return onlyWhen(low) && (d || t) ? `${d ?? cur[0] ?? ''} at ${t ?? cur[1] ?? '9:00'}` : null;
  },
  sched: v => {
    const low = v.toLowerCase(), d = dayIn(low), t = timeIn(low);
    if (!onlyWhen(low) || (!d && !t)) return null;
    return d && d !== 'today' && d !== 'tomorrow' ? `${d} at ${t ?? '9:00'}` : `day at ${t ?? '9:00'}`;
  },
  days: v => {
    const m = v.match(/\d{1,3}/);
    if (!m || !Number(m[0])) return null;
    const k = /week/i.test(v) ? Number(m[0]) * 7 : Number(m[0]);
    return k === 1 ? '1 day' : `${k} days`;
  },
  lead: v => {
    const m = v.match(/\d{1,3}/), low = v.toLowerCase();
    if (/evening|night/.test(low)) return 'the evening';
    if (!m || !Number(m[0])) return null;
    const n = Number(m[0]);
    return /h/.test(low.replace(/\d/g, '')) && !/min/.test(low) ? (n === 1 ? '1 hour' : `${n} hours`) : `${n} min`;
  },
  // A place: a channel, or an email. The prototype answered "mail" with the one
  // email option its sample had, by name. Here it is whichever option of the
  // word is an email, so no name lives in the reader.
  where: (v, L) => (/^#[\w-]{2,}$/.test(v) ? v.toLowerCase()
    : /mail/i.test(v) ? L.options.find(o => /mail/i.test(o)) ?? 'an email'
    : /^[\w-]{2,}$/.test(v) ? '#' + v.toLowerCase() : null),
};

/**
 * What a typed text means for this word, or null when it means nothing.
 * In order: one of the options (whole, or its beginning), another way of
 * saying an option, a value its reader understands, and last the text as it
 * is, if the word takes anything.
 */
export function readLive(L: NotchWord, raw: string): string | null {
  const v = raw.replace(/[<>"&`]/g, '').trim().slice(0, 28), low = v.toLowerCase();
  if (!v) return null;
  const hit = L.options.find(o => o.toLowerCase() === low) ?? (low.length > 1 ? L.options.find(o => o.toLowerCase().startsWith(low)) : undefined);
  if (hit) return hit;
  if (L.syn) for (const o of Object.keys(L.syn)) if ((L.syn[o] ?? []).some(w => low.includes(w))) return o;
  if (L.read) return READ[L.read]?.(v, L) ?? null;
  return L.free ? v : null;
}
