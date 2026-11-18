/**
 * Before a call: "Call with Anna in 10 min. Notes are ready."
 *
 * The prototype's line before a meeting goes on "Notes are ready", and yes
 * opens a short sheet: the last call, what was asked, what is open. The
 * product said only "Board call in 10 min.", because nothing prepared notes.
 * Now there is something to prepare them from: the notes of calls that were
 * listened to (./call.ts), the mail that is waited on (./mail/store.ts), and
 * what is remembered.
 *
 * Nothing is asked of a model here and nothing is fetched. The sheet is put
 * together from what Jarvis already holds, at the moment the line is said:
 *
 *   who     the one other person the meeting is with. From the calendar's
 *           guests when the calendar gives them: exactly one of them is
 *           somebody the owner writes with. Otherwise from the title:
 *           exactly one known person is named in it. A meeting with several
 *           known people, or with nobody known, has no notes.
 *   what    the last call with them and what each side owed after it, the
 *           mail of theirs that waits for a reply or the last that was
 *           answered, and what is remembered about them.
 *
 * With nothing to say there are no notes, and the line stays "Board call in
 * 10 min.": "Notes are ready" is never said over an empty sheet.
 *
 * Everything on the sheet is text that came from a call or a mail. It is
 * shown to the owner and goes nowhere else from here.
 */
import type { NotchBlock } from './protocol.ts';

export interface NotchBeforePerson { name: string; address: string }

export interface NotchBeforeSources {
  /** The people the owner writes with, the ones who wrote last first. */
  people(): NotchBeforePerson[];
  /** Calls that were written down, the newest first: who each was with, as said in it. */
  calls(): { at: number; with: string; summary: string; actions: { what: string; owner: string; by: string }[] }[];
  /** The mail of one address that was waited on, the newest first: what it was about, and what came of it. */
  mail(address: string): { at: number; about: string; subject: string; state: string }[];
  /** What is remembered about a name. */
  facts?(about: string): { text: string }[];
}

/** The most rows of each kind the sheet carries. */
export const NOTCH_BEFORE_ACTIONS = 4;
export const NOTCH_BEFORE_FACTS = 2;
/** The most a row says. */
const ROW_CHARS = 160;

const flat = (text: string): string => { const points = [...text.replace(/\s+/g, ' ').trim()]; return points.length <= ROW_CHARS ? points.join('') : `${points.slice(0, ROW_CHARS - 1).join('').trimEnd()}…`; };
const first = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
const day = (at: number): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(at);
/** Whether a name stands in a text as a word of its own. */
const named = (text: string, name: string): boolean => name.length >= 3 && new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(text);

/**
 * The one other person a meeting is with, or null when that is not one
 * person Jarvis knows.
 */
export function notchBeforeWho(meeting: { title: string; who?: readonly string[] }, sources: Pick<NotchBeforeSources, 'people' | 'calls'>): NotchBeforePerson | null {
  const people = sources.people().filter((person) => person.name.trim() && !person.name.includes('@'));
  // The calendar's own guests: an address is an address, nothing is guessed.
  if (meeting.who?.length) {
    const guests = new Set(meeting.who.map((address) => address.trim().toLowerCase()));
    const known = people.filter((person) => guests.has(person.address.toLowerCase()));
    if (known.length === 1) return known[0]!;
    // Several known people, or guests of whom none is known: whose notes would it be?
    if (known.length > 1 || guests.size > 2) return null;
  }
  // The title: a whole name, or a first name that only one known person has.
  const full = people.filter((person) => person.name.includes(' ') && named(meeting.title, person.name));
  if (full.length === 1) return full[0]!;
  if (full.length > 1) return null;
  const firsts = new Map<string, NotchBeforePerson[]>();
  for (const person of people) {
    const given = first(person.name).toLowerCase();
    firsts.set(given, [...(firsts.get(given) ?? []), person]);
  }
  const hits = [...firsts.entries()].filter(([given]) => named(meeting.title, given));
  if (hits.length === 1 && hits[0]![1].length === 1) return hits[0]![1][0]!;
  if (hits.length > 0) return null;
  // Somebody a call was with, whom no mail knows: their name as it was said then.
  const spoken = [...new Set(sources.calls().map((call) => call.with.trim()).filter((name) => name && named(meeting.title, first(name))))];
  return spoken.length === 1 ? { name: spoken[0]!, address: '' } : null;
}

/**
 * What is known before a meeting, as the rows of a sheet, with who it is
 * with. Null when the meeting is with nobody Jarvis knows, or nothing is
 * known that is worth a sheet.
 */
export function notchBeforeNotes(meeting: { title: string; who?: readonly string[] }, sources: NotchBeforeSources): { who: string; blocks: NotchBlock[] } | null {
  const person = notchBeforeWho(meeting, sources);
  if (!person) return null;
  const given = first(person.name);
  const blocks: NotchBlock[] = [];

  // The last call with them: what it was about, and what each side owed after it.
  const same = (said: string): boolean => {
    const heard = said.trim().toLowerCase();
    return heard !== '' && (heard === person.name.toLowerCase() || first(heard) === given.toLowerCase());
  };
  const call = sources.calls().find((one) => same(one.with));
  if (call) {
    if (call.summary.trim()) blocks.push({ kind: 'row', lead: day(call.at), say: ['Last call. ', flat(call.summary)] });
    for (const action of call.actions.filter((one) => one.what.trim()).slice(0, NOTCH_BEFORE_ACTIONS)) {
      const by = action.by.trim() ? `, by ${flat(action.by)}` : '';
      blocks.push({ kind: 'row', lead: action.owner === 'mine' ? 'You owed' : action.owner === 'theirs' ? `${given} owed` : 'Open', say: [`${flat(action.what)}${by}`] });
    }
  }

  // Their mail: what waits for a reply comes first, then the last that was answered.
  if (person.address) {
    const mail = sources.mail(person.address).filter((one) => (one.about || one.subject).trim());
    const waits = mail.find((one) => one.state === 'ready');
    if (waits) blocks.push({ kind: 'row', lead: 'Waits', say: [flat(waits.about || waits.subject)] });
    const answered = mail.find((one) => one !== waits && (one.state === 'sent' || one.state === 'answered'));
    if (answered) blocks.push({ kind: 'row', lead: day(answered.at), say: [flat(answered.about || answered.subject)] });
  }

  // What is remembered about them.
  for (const fact of (sources.facts?.(person.name) ?? []).filter((one) => one.text.trim()).slice(0, NOTCH_BEFORE_FACTS)) {
    blocks.push({ kind: 'row', lead: 'Known', say: [flat(fact.text)] });
  }

  return blocks.length > 0 ? { who: given, blocks } : null;
}
