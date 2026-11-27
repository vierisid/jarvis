/**
 * A time that is free for two people: "find a time with Leo".
 *
 * The prototype's scene: "Comparing calendars with Leo's Jarvis. Neither of
 * you sees the other's." Then "Thursday at 15:00 is free for both of you",
 * the other is asked ("Sam wants 30 min. Thursday at 15:00 is free for both.
 * Book it?"), and both hear how it ended.
 *
 * How it goes:
 *
 *   1. The asker's Pillow reads its owner's calendar and works out, by rule
 *      (./mail/slots.ts), every half hour that is free in the next seven
 *      days. Those starts go to the other Pillow. Nothing else does.
 *   2. The other Pillow reads ITS owner's calendar, works out the same, and
 *      answers with up to three starts that are free on both sides.
 *   3. The asker picks one, or it is the only one. The other person is
 *      asked for it, and says "Book it" or "Not then".
 *   4. On a yes each side is offered the time in its own calendar, already
 *      filled in. Pillow reads calendars and cannot write to one, so the
 *      saving is the person's own press.
 *
 * What holds:
 *
 *   - Only free times cross, never an event: no title, no place, no guest,
 *     and nothing about a time that is not free. Which times are free is
 *     read off the calendar by rule on each side. No model is asked.
 *   - The other Pillow answers the comparing by itself, so its owner is
 *     told that it did, and how little it said: a few times, nothing else.
 *     It answers one person only a few times an hour, so that a calendar
 *     cannot be mapped by asking again and again.
 *   - A time is asked of a person, and only that person says yes to it.
 *     When it is asked, their calendar is read again: a time that is no
 *     longer free is said to be so.
 *   - Each side says a time in its own clock.
 */
import { notchAskedHow, notchSentOutcome, type NotchActions } from './actions.ts';
import { playSend } from './decide.ts';
import type { NotchInbox } from './inbox.ts';
import { NOTCH_NAME } from './name.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import type { MailCalendarEvent } from './mail/proposer.ts';
import { MAIL_SLOT_DAYS, MAIL_SLOT_LEAST_AHEAD_MS, mailFreeStarts, mailPickStarts, mailSlotFree, mailSlotWords } from './mail/slots.ts';
import type { PeerItem, PeerLink, PeerPerson } from '../peers/link.ts';
import { PEER_TIME_FITS_MAX, PEER_TIME_FREE_MAX, PEER_TIME_MINUTES, peerNoteText } from '../peers/notes.ts';
import type { PeerNote } from '../peers/notes.ts';
import type { PeerStore } from '../peers/store.ts';

const em = (text: string): NotchPart => ({ em: text });
const MINUTE = 60_000;
const DAY_MS = 24 * 3_600_000;

/** How long the comparing can be taken back, and the asking for one time. */
export const NOTCH_TIME_FUSE_MS = 3000;
/** How long the asker's line waits for the other Pillow's answer before it lets the notch go. The answer still comes, as news. */
export const NOTCH_TIME_WAIT_MS = 20_000;
/** How many comparings one person is answered in an hour. */
export const NOTCH_TIME_ASKS_AN_HOUR = 6;

export type PeerTimeNote = Extract<PeerNote, { kind: 'time-ask' | 'time-fit' | 'time-want' | 'time-yes' | 'time-no' }>;
export const isTimeNote = (note: PeerNote | null): note is PeerTimeNote => !!note && note.kind.startsWith('time-');

/**
 * How long a time is wanted for, from what was said: "an hour with Leo",
 * "30 minutes", "a quick call". Half an hour when nothing says otherwise,
 * and one of the lengths that can be looked for.
 */
export function peerTimeMinutes(text: string): number {
  const said = text.toLowerCase();
  const told = /\b(\d{1,3})\s*(?:min(?:ute)?s?|m)\b/.exec(said);
  const minutes = told ? Number(told[1]) : /\b(?:an|one|1|a full)\s+hour\b|\b60\b/.test(said) ? 60 : 30;
  return minutes > 30 && PEER_TIME_MINUTES.includes(60) ? 60 : 30;
}

/** The time filled in on Google Calendar's own page for a new entry, to be saved there by the person. */
export function peerTimeCalendarUrl(title: string, at: number, minutes: number): string {
  const stamp = (when: number): string => new Date(when).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${stamp(at)}/${stamp(at + minutes * MINUTE)}`;
}

export interface NotchPeopleTimeDeps {
  inbox: NotchInbox;
  link: PeerLink;
  store: PeerStore;
  /** What is in the owner's calendar between two instants. Null when no calendar can be read. */
  calendar(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  /** Opens a page in the owner's own browser. False when it could not. */
  open?: (url: string) => Promise<boolean>;
  person(id: string): PeerPerson | null;
  /** News that is said once. */
  news(id: string, say: NotchPart[], more?: { who?: string }): void;
  /** The owner's time zone. The machine's own when none is given. */
  zone?: string;
  /** Where what is sent to somebody is written down, with what came of it (./actions.ts). */
  actions?: NotchActions | null;
  log?: (line: string) => void;
  now?: () => number;
  /** For tests: how long the asker's line waits for the answer. */
  waitMs?: number;
}

export interface NotchPeopleTime {
  /** "Find a time with Leo." */
  find(to: PeerPerson, minutes: number): void;
  /** Takes in a note about a time that arrived. */
  note(item: PeerItem, from: PeerPerson, note: PeerTimeNote, words: string): Promise<void>;
}

/** What is remembered of an asking for one time, until it is answered. */
interface Wanted { peer: string; at: number; minutes: number; rest: number[] }

export function attachNotchPeopleTime(deps: NotchPeopleTimeDeps): NotchPeopleTime {
  const { inbox, link, store } = deps;
  const log = deps.log ?? (() => { /* quiet */ });
  const now = deps.now ?? Date.now;
  const zone = deps.zone;
  const says = (at: number): string => mailSlotWords(at, zone);
  const length = (minutes: number): string => (minutes === 60 ? 'an hour' : `${minutes} minutes`);
  const short = (minutes: number): string => (minutes === 60 ? '1 hour' : `${minutes} min`);
  const theirs = (one: PeerPerson): string => `${one.name}'s ${NOTCH_NAME}`;
  const sorry = (why: string): NotchPart[] => (why === 'signed_out' ? ['You are signed out. It was not sent.'] : why === 'offline' || why === 'down' ? ['I have no line to the others now. It was not sent.'] : ['That could not be sent.']);

  /** The owner's free starts in the days that are looked at. Null when the calendar cannot be read. */
  async function free(minutes: number): Promise<number[] | null> {
    const at = now();
    const events = await deps.calendar(at, at + (MAIL_SLOT_DAYS + 2) * DAY_MS).catch(() => null);
    return events ? mailFreeStarts(events, at, zone, minutes) : null;
  }

  // --- the asker ---

  /** The comparings whose line is still on the notch, waiting for the answer. */
  const waiting = new Map<string, (fits: { fits: number[]; blind: boolean }) => void>();
  /** The comparings that were sent: who was asked and for how long. Gone when the answer was used. */
  const compared = new Map<string, { peer: string; minutes: number; free: number[] }>();

  const remember = (id: string, wanted: Wanted | null): void => store.setMeta(`time-want:${id}`, wanted ? JSON.stringify(wanted) : null);
  function recalled(id: string): Wanted | null {
    try {
      const read: unknown = JSON.parse(store.meta(`time-want:${id}`) ?? 'null');
      const one = read && typeof read === 'object' ? read as Record<string, unknown> : null;
      if (!one || typeof one.peer !== 'string' || typeof one.at !== 'number' || typeof one.minutes !== 'number' || !Array.isArray(one.rest)) return null;
      return { peer: one.peer, at: one.at, minutes: one.minutes, rest: one.rest.filter((start): start is number => typeof start === 'number') };
    } catch { return null; }
  }

  function find(to: PeerPerson, minutes: number): void {
    inbox.present('people-time', async (stage) => {
      const line = stage.id();
      stage.put({ id: line, kind: 'work', say: ['Looking at your calendar…'], steps: 0, done: 0, mood: 'work', who: to.name });
      const mine = await free(minutes);
      if (!mine) { await stage.say(['I cannot read your calendar right now. Say a time, and I ask ', em(to.name), ' for it.'], 4200, { mood: 'sorry' }); return; }
      if (mine.length === 0) { await stage.say([`You have no free ${minutes === 60 ? 'hour' : 'half hour'} in the next seven days.`], 3600); return; }
      // Their own asking is the yes. What leaves is when they are free, and nothing else: said, with a moment to take it back.
      const id = crypto.randomUUID();
      const sent = mine.slice(0, PEER_TIME_FREE_MAX);
      /** The answer, waited for from the moment the times go. */
      let answer: Promise<{ fits: number[]; blind: boolean } | null> = Promise.resolve(null);
      // The road after a yes (./decide.ts): the fuse, the send, and the one entry of what came of it.
      // What left: when the owner is free, and nothing else of the calendar.
      const told = await playSend(stage, {
        say: ['Comparing calendars with ', em(theirs(to)), ". Neither of you sees the other's."], ms: NOTCH_TIME_FUSE_MS, extras: { mood: 'think', who: to.name },
        back: ['Taken back. Nothing was sent.'], kind: 'people_time', what: `Sent ${theirs(to)} your free times, to find one for both`, target: to.name,
        go: () => {
          compared.set(id, { peer: to.id, minutes, free: sent });
          answer = new Promise((resolve) => {
            waiting.set(id, resolve);
            const timer = setTimeout(() => resolve(null), deps.waitMs ?? NOTCH_TIME_WAIT_MS);
            (timer as { unref?: () => void }).unref?.();
          });
          // The sentence is for a contact who is not on a Pillow: they read it, and answer in their own words.
          return link.tell(to.id, peerNoteText(`When are we both free for ${length(minutes)} in the next days? I asked from my ${NOTCH_NAME}.`, { kind: 'time-ask', id, minutes, free: sent.map((at) => Math.round(at / MINUTE)) }));
        },
      }, deps);
      if (!told) return;
      if (!told.ok) { waiting.delete(id); compared.delete(id); await stage.say(sorry(told.why), 3400, { mood: 'sorry' }); return; }
      const wait = stage.id();
      stage.put({ id: wait, kind: 'work', say: ['Waiting for ', em(theirs(to)), '…'], steps: 0, done: 0, mood: 'work', who: to.name });
      // Esc leaves the line. The answer still comes, as news.
      const left = stage.answer(wait, ['stop', 'no']).then(() => 'left' as const, () => 'left' as const);
      const got = await Promise.race([answer, left]);
      waiting.delete(id);
      if (got === 'left') return;
      if (!got) { await stage.say(told.delivered ? [em(theirs(to)), ' has not answered yet. I will tell you when it does.'] : ['It waits until ', em(theirs(to)), ' is on.'], 3200, { who: to.name }); return; }
      compared.delete(id);
      await choose(stage, to, minutes, got.fits, got.blind);
    });
  }

  /** The times that are free for both, for the asker to pick the one that is asked for. */
  async function choose(stage: NotchStage, to: PeerPerson, minutes: number, fits: number[], blind: boolean): Promise<void> {
    if (blind) { await stage.say([em(theirs(to)), ' cannot read ', em(`${to.name}'s`), ' calendar. Say a time, and I ask ', em(to.name), ' for it.'], 4600, { who: to.name }); return; }
    // A time that has gone by since, or is too near to be answered, is not asked for.
    const open = fits.filter((at) => at - now() >= MAIL_SLOT_LEAST_AHEAD_MS);
    if (open.length === 0) { await stage.say(['Nothing is free for both of you in the next seven days.'], 3600, { who: to.name }); return; }
    let at = open[0]!;
    if (open.length > 1) {
      const picked = await stage.choose(['Free for both of you. Which one do I ask ', em(to.name), ' for?'], open.map(says), { who: to.name, mood: 'look' });
      if (picked.act !== 'pick' || typeof picked.index !== 'number' || open[picked.index] === undefined) return;
      at = open[picked.index]!;
    }
    await want(stage, to, minutes, at, open.filter((one) => one !== at), open.length === 1);
  }

  /** Asks the other person for one time. */
  async function want(stage: NotchStage, to: PeerPerson, minutes: number, at: number, rest: number[], only: boolean): Promise<void> {
    const id = crypto.randomUUID();
    const told = await playSend(stage, {
      say: ['Asking ', em(to.name), ` for ${length(minutes)}, `, em(says(at)), only ? ', the one time free for both…' : '…'], ms: NOTCH_TIME_FUSE_MS, extras: { mood: 'work', who: to.name },
      back: ['Taken back. Nothing was asked.'], kind: 'people_time', what: `Asked ${to.name} for ${length(minutes)} on ${says(at)}`, target: to.name, how: 'pick',
      go: () => link.tell(to.id, peerNoteText(`Can we take ${length(minutes)} on ${says(at)} (my time)? I asked from my ${NOTCH_NAME}.`, { kind: 'time-want', id, at: Math.round(at / MINUTE), minutes })),
    }, deps);
    if (!told) return;
    if (!told.ok) { await stage.say(sorry(told.why), 3400, { mood: 'sorry' }); return; }
    remember(id, { peer: to.id, at, minutes, rest });
    await stage.say(told.delivered ? ['Asked ', em(to.name), '. I will tell you what ', em(to.name), ' says.'] : ['Asked. It waits until ', em(theirs(to)), ' is on.'], 2800, { mark: 'check', who: to.name });
  }

  /** The answer to a comparing came after its line had left: it is on the notch as something that waits. */
  function fitted(id: string, to: PeerPerson, minutes: number, fits: number[], blind: boolean): void {
    inbox.add({
      id: `people:time-fit:${id}`, subject: `people:time-fit:${id}`, class: 'person', speaks: true, once: true,
      title: () => ['A time with ', em(to.name), '.'],
      play: async (stage) => { await choose(stage, to, minutes, fits, blind); return 'settled'; },
    });
  }

  /** How an asking for one time ended. */
  function answered(id: string, yes: boolean, from: PeerPerson): void {
    const wanted = recalled(id);
    if (!wanted || wanted.peer !== from.id) return;
    remember(id, null);
    const when = says(wanted.at);
    inbox.add({
      id: `people:time-end:${id}`, subject: `people:time-end:${id}`, class: 'person', speaks: true, once: true,
      title: () => (yes ? [em(from.name), ' said yes: ', when, '.'] : [em(from.name), ' cannot on ', when, '.']),
      play: async (stage) => {
        if (yes) {
          await book(stage, from, wanted.at, wanted.minutes, [em(from.name), ' said yes: ', em(when), '.']);
          return 'settled';
        }
        const rest = wanted.rest.filter((at) => at - now() >= MAIL_SLOT_LEAST_AHEAD_MS);
        if (rest.length === 0) { await stage.say([em(from.name), ' cannot on ', em(when), '.'], 3200, { who: from.name }); return 'settled'; }
        // The other times that were free for both: asking again is theirs to say.
        const picked = await stage.choose([em(from.name), ' cannot on ', em(when), '. Ask for another time?'], [...rest.map(says), 'Leave it'], { who: from.name, mood: 'look' });
        if (picked.act !== 'pick' || typeof picked.index !== 'number' || rest[picked.index] === undefined) return 'settled';
        await want(stage, from, wanted.minutes, rest[picked.index]!, rest.filter((_, index) => index !== picked.index), false);
        return 'settled';
      },
    });
  }

  /**
   * Both said yes. Pillow reads a calendar and cannot write to one, so the
   * time is opened in the owner's own calendar, filled in, for them to save.
   * `first` is the sentence that says how it came to this.
   */
  async function book(stage: NotchStage, other: PeerPerson, at: number, minutes: number, first: NotchPart[]): Promise<void> {
    if (!deps.open) { await stage.say([...first, ' Put it in your calendar: ', em(says(at)), `, ${length(minutes)}.`], 4600, { mark: 'check', who: other.name }); return; }
    const said = await stage.offer([...first, ' Open it in your calendar, to save it there?'], 'open', { who: other.name, mood: 'look' });
    if (said.act !== 'yes') return;
    const opened = await deps.open(peerTimeCalendarUrl(other.name, at, minutes)).catch(() => false);
    await stage.say(opened ? ['It is open in your calendar, filled in. Press Save there.'] : ['I could not open your calendar. It is ', em(says(at)), `, ${length(minutes)}, with `, em(other.name), '.'], 4200, opened ? { mark: 'check', who: other.name } : { mood: 'sorry', who: other.name });
  }

  // --- the one who is asked ---

  /** When each person was last answered a comparing: no more than a few an hour. */
  const answeredAt = new Map<string, number[]>();

  /** Another Pillow asks when both are free. Answered by this Pillow itself, and its owner is told. */
  async function compare(item: PeerItem, from: PeerPerson, note: Extract<PeerTimeNote, { kind: 'time-ask' }>): Promise<void> {
    const settle = (): void => { store.done(item.id); void link.seen(item.id); };
    const lately = (answeredAt.get(from.id) ?? []).filter((at) => now() - at < 3_600_000);
    if (lately.length >= NOTCH_TIME_ASKS_AN_HOUR) {
      // Not answered: asked again and again, the answers would add up to the calendar.
      log(`[notch] a comparing of calendars was not answered: ${lately.length} in the last hour from one person`);
      settle();
      return;
    }
    answeredAt.set(from.id, [...lately, now()]);
    const mine = await free(note.minutes);
    const both = mine ? note.free.map((minute) => minute * MINUTE).filter((at) => mine.includes(at)) : [];
    const fits = mailPickStarts(both, zone).slice(0, PEER_TIME_FITS_MAX);
    const sentence = !mine ? `My ${NOTCH_NAME} cannot read my calendar.` : fits.length ? `Free for both of us (my time): ${fits.map(says).join(', ')}.` : 'Nothing is free for both of us in the next days.';
    const told = await link.tell(from.id, peerNoteText(sentence, { kind: 'time-fit', of: note.id, fits: fits.map((at) => Math.round(at / MINUTE)), ...(mine ? {} : { blind: true }) }), { replyTo: item.id });
    // Answered by itself, in the owner's name, with nobody asked: written down, how many and never which.
    deps.actions?.record({
      kind: 'people_time', target: from.name, asked: { seen: 'nothing', how: 'system' }, outcome: notchSentOutcome(told),
      what: !mine ? `Told ${theirs(from)} your calendar could not be read` : `Told ${theirs(from)} ${fits.length} time${fits.length === 1 ? '' : 's'} free for both`,
    });
    settle();
    // How many, never which.
    log(`[notch] a comparing of calendars was answered: ${note.free.length} asked about, ${fits.length} named${mine ? '' : ' (no calendar here)'}${told.ok ? '' : ', not sent'}`);
    // It answered by itself, so its owner hears that it did, and how little it said.
    if (told.ok && mine) {
      deps.news(`people:time-told:${note.id}`, fits.length
        ? [em(theirs(from)), ' asked when you are both free. I named ', `${fits.length} time${fits.length === 1 ? '' : 's'}`, ', and nothing else of your calendar.']
        : [em(theirs(from)), ' asked when you are both free. I said no time fits, and nothing else.'], { who: from.name });
    }
  }

  /** "Sam wants 30 min. Thursday at 15:00 is free for both. Book it?" */
  function asked(item: PeerItem, from: PeerPerson, note: Extract<PeerTimeNote, { kind: 'time-want' }>): void {
    const at = note.at * MINUTE;
    const settle = (): void => { store.done(item.id); void link.seen(item.id); };
    // A time that has gone by, or is further off than is looked at, is not a time to be asked for.
    if (at <= now() || at - now() > (MAIL_SLOT_DAYS + 3) * DAY_MS) { settle(); return; }
    inbox.add({
      id: `people:time-want:${note.id}`, subject: `people:time-want:${note.id}`, class: 'person', speaks: true,
      title: () => [em(from.name), ' wants ', short(note.minutes), ': ', says(at), '.'],
      check: () => store.got(item.id)?.done !== true && at > now(),
      play: async (stage) => {
        // Read again now: the calendar may have changed since the comparing.
        const events = await deps.calendar(at - DAY_MS, at + DAY_MS).catch(() => null);
        const clear = events ? mailSlotFree({ at, minutes: note.minutes }, events) : null;
        const line: NotchPart[] = clear === true ? [em(from.name), ' wants ', short(note.minutes), '. ', em(says(at)), ' is free for both. Book it?']
          : clear === false ? [em(from.name), ' wants ', short(note.minutes), ' on ', em(says(at)), '. Something is in your calendar then. Book it?']
            : [em(from.name), ' wants ', short(note.minutes), ' on ', em(says(at)), '. I cannot read your calendar now. Book it?'];
        const picked = await stage.choose(line, ['Book it', 'Not then'], { who: from.name, mood: 'look' });
        if (picked.act !== 'pick' || typeof picked.index !== 'number') return 'waits';
        const yes = picked.index === 0;
        const told = await link.tell(from.id, peerNoteText(yes ? `Yes: ${says(at)} (my time).` : 'Not then.', { kind: yes ? 'time-yes' : 'time-no', of: note.id }), { replyTo: item.id });
        // The yes went in the owner's name: written down. "Not then" commits them to nothing, and is not.
        if (yes) deps.actions?.record({ kind: 'people_time', ref: `time-yes:${note.id}`, what: `Told ${from.name} yes to ${short(note.minutes)} on ${says(at)}`, target: from.name, asked: { seen: 'line', how: notchAskedHow(stage, 'pick') }, outcome: notchSentOutcome(told) });
        if (!told.ok) { await stage.say(['I could not tell ', em(from.name), ' now. It waits for you.'], 3200, { mood: 'sorry' }); return 'waits'; }
        settle();
        if (!yes) { await stage.say(['Told ', em(from.name), ' not then.'], 2600, { who: from.name }); return 'settled'; }
        await book(stage, from, at, note.minutes, ['Told ', em(from.name), ' yes.']);
        return 'settled';
      },
    });
  }

  /** The comparings that are being answered: reading a calendar can take a while, and the same asking is not answered twice. */
  const comparing = new Set<string>();

  async function note(item: PeerItem, from: PeerPerson, got: PeerTimeNote, _words: string): Promise<void> {
    if (got.kind === 'time-ask') {
      // Not waited for: a calendar that is slow to read must not hold up everything else that arrives.
      if (comparing.has(got.id)) return;
      comparing.add(got.id);
      void compare(item, from, got).catch(() => { /* it stays unanswered */ }).finally(() => comparing.delete(got.id));
      return;
    }
    if (got.kind === 'time-want') { asked(item, from, got); return; }
    store.done(item.id);
    void link.seen(item.id);
    if (got.kind === 'time-fit') {
      const mine = compared.get(got.of);
      // An answer to a comparing that was not sent to this person, or was answered already, is nothing.
      if (!mine || mine.peer !== from.id) return;
      // Only starts that were asked about count: the answer names times of the asker's own list.
      const fits = got.fits.map((minute) => minute * MINUTE).filter((at) => mine.free.includes(at));
      const wake = waiting.get(got.of);
      if (wake) { wake({ fits, blind: got.blind === true }); return; }
      compared.delete(got.of);
      fitted(got.of, from, mine.minutes, fits, got.blind === true);
      return;
    }
    answered(got.of, got.kind === 'time-yes', from);
  }

  return { find, note };
}
