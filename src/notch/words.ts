/**
 * What a value typed into a lit word means, read by the brain. The page
 * sends what was typed as it was typed (trimmed, and no longer than the
 * field takes); this says what Jarvis understood, or that it understood
 * nothing, and then the word keeps its value and the page says it was not
 * read.
 *
 * It used to be read on the page, in English, by readers of its own: "month"
 * became Monday, "sunset" Sunday, `Tell R&D "x < 5"` was sent as `Tell RD x
 * 5` (the review of 26 November 2026, docs/notch/fixes/07-page-renderer.md
 * and 03-intent-routing.md). A day and a time are now read by the one reader
 * of a time (./when.ts), which refuses what it cannot read whole, and a
 * sentence typed into a word that takes one is kept as it was typed.
 *
 * Nothing here has a state or a clock.
 */
import type { NotchBlock, NotchEdit, NotchLine, NotchPart, NotchWord } from './protocol.ts';
import { NOTCH_WORD_LONG_MAX } from './protocol.ts';
import { WHEN_DAY_NAMES, sayWhen, whenTyped, type WhenTyped } from './when.ts';

/** The most a word that holds a word or two may hold. */
export const NOTCH_WORD_MAX = 28;

/** The most of a typed value that is read: what the page's field takes. */
export const notchWordMax = (word: Pick<NotchWord, 'long'>): number => (word.long ? NOTCH_WORD_LONG_MAX : NOTCH_WORD_MAX);

/** A day as the page always said it: the day of the week, today or tomorrow, or null. */
const dayOf = (when: WhenTyped): string | null =>
  (when.days?.length === 1 ? WHEN_DAY_NAMES[when.days[0]!]! : when.days ? null : when.rel);
const clock = (hour: number, minute: number): string => `${hour}:${String(minute).padStart(2, '0')}`;

type Reader = (text: string, word: NotchWord) => string | null;

/**
 * One reader per kind of value a lit word can hold. Each returns the value as
 * Jarvis says it, or null. A day and a time are read by the typed-word mode of
 * the one reader of a time (./when.ts, `whenTyped`), with the page's old rules.
 */
export const NOTCH_WORD_READ: Record<NonNullable<NotchWord['read']>, Reader> = {
  // A day: one day of the week, today or tomorrow. A time beside it is dropped, as it always was.
  day: (text) => {
    const when = whenTyped(text);
    return when ? dayOf(when) : null;
  },
  // One moment: a day and a time. What was not said of it stays as the word had it ("fri" keeps the hour).
  dayTime: (text, word) => {
    const when = whenTyped(text);
    if (!when || (when.days && when.days.length !== 1)) return null;
    const day = dayOf(when);
    if (!day && when.hour === null) return null;
    const [was = '', at] = word.value.split(' at ');
    return `${day ?? was} at ${when.hour !== null ? clock(when.hour, when.minute) : at ?? '9:00'}`;
  },
  // A schedule: the days of the week it is on, and a time. A day alone is at nine; an hour alone is every day.
  sched: (text) => {
    const when = whenTyped(text);
    if (!when || (!when.days && !when.rel && when.hour === null)) return null;
    // Today and tomorrow are not days of the week: no schedule is on them (the page made them every day).
    if (!when.days && when.rel) return null;
    return sayWhen({ days: when.days ?? [0, 1, 2, 3, 4, 5, 6], hour: when.hour ?? 9, minute: when.hour === null ? 0 : when.minute });
  },
  days: (text) => {
    const m = text.match(/\d{1,3}/);
    if (!m || !Number(m[0])) return null;
    const k = /week/i.test(text) ? Number(m[0]) * 7 : Number(m[0]);
    return k === 1 ? '1 day' : `${k} days`;
  },
  lead: (text) => {
    const m = text.match(/\d{1,3}/), low = text.toLowerCase();
    if (/evening|night/.test(low)) return 'the evening';
    if (!m || !Number(m[0])) return null;
    const n = Number(m[0]);
    return /h/.test(low.replace(/\d/g, '')) && !/min/.test(low) ? (n === 1 ? '1 hour' : `${n} hours`) : `${n} min`;
  },
  // A place: a channel, or an email: whichever option of the word is an email, so no name lives in the reader.
  where: (text, word) => (/^#[\w-]{2,}$/.test(text) ? text.toLowerCase()
    : /mail/i.test(text) ? word.options.find((o) => /mail/i.test(o)) ?? 'an email'
    : /^[\w-]{2,}$/.test(text) ? '#' + text.toLowerCase() : null),
};

/**
 * What a typed text means for this word, or null when it means nothing.
 * In order: one of the options (whole, or its beginning), another way of
 * saying an option, a value its reader understands, and last the text as it
 * is, if the word takes anything. Nothing is taken out of what was typed:
 * only the spaces are made single, and it is cut to what the word holds.
 */
export function notchReadWord(word: NotchWord, typed: string): string | null {
  const text = typed.replace(/\s+/g, ' ').trim().slice(0, notchWordMax(word));
  const low = text.toLowerCase();
  if (!text) return null;
  const hit = word.options.find((o) => o.toLowerCase() === low) ?? (low.length > 1 ? word.options.find((o) => o.toLowerCase().startsWith(low)) : undefined);
  if (hit) return hit;
  if (word.syn) for (const o of Object.keys(word.syn)) if ((word.syn[o] ?? []).some((w) => low.includes(w))) return o;
  if (word.read) return NOTCH_WORD_READ[word.read]?.(text, word) ?? null;
  return word.free ? text : null;
}

/** Every part of a line a lit word can stand in: its sentence, and the rows, notes and paper of its blocks. */
function partsOf(line: NotchLine): NotchPart[][] {
  const all: NotchPart[][] = [line.say ?? []];
  const blocks: readonly NotchBlock[] = 'blocks' in line && Array.isArray(line.blocks) ? line.blocks : [];
  for (const block of blocks) {
    if (block.kind === 'row' || block.kind === 'note') all.push(block.say);
    if (block.kind === 'paper') all.push(block.to ?? [], ...block.lines);
  }
  return all;
}

/** The lit word named `name` in a line, wherever it stands. */
export function notchWordIn(line: NotchLine, name: string): NotchWord | null {
  for (const parts of partsOf(line)) {
    for (const part of parts) if (typeof part === 'object' && 'word' in part && part.word.name === name) return part.word;
  }
  return null;
}

/**
 * Sets a lit word's value wherever it stands in the line, in place, with the
 * value among its options (so that it can be stepped back to).
 */
export function notchSetWord(line: NotchLine, name: string, value: string): void {
  for (const parts of partsOf(line)) {
    for (const part of parts) {
      if (typeof part !== 'object' || !('word' in part) || part.word.name !== name) continue;
      part.word.value = value;
      if (!part.word.options.includes(value)) part.word.options = [...part.word.options, value];
    }
  }
}

/** What a value typed into the word `name` of a line means, or null: also when the line has no such word. */
export function notchReadTyped(line: NotchLine, name: string, typed: string): string | null {
  const word = notchWordIn(line, name);
  return word ? notchReadWord(word, typed) : null;
}

/** The change that draws the word `name` as it now stands: the sentence if it is in the sentence, the blocks if it is in them. */
export function notchWordEdit(line: NotchLine, name: string): NotchEdit {
  const edit: NotchEdit = { id: line.id };
  const has = (parts: readonly NotchPart[] | undefined): boolean => (parts ?? []).some((part) => typeof part === 'object' && 'word' in part && part.word.name === name);
  if (has(line.say)) edit.say = line.say;
  if ((line.kind === 'sheet' || line.kind === 'ask') && partsOf({ ...line, say: [] }).some(has)) edit.blocks = line.blocks;
  return edit;
}
