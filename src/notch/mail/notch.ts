/**
 * Mail on the notch: "You have not replied to Marco. I drafted a reply."
 *
 * The replies that ./watch.ts prepared are one thing on the notch: mail, with
 * one reply per thread in it. Where they wait is decided by one fact about
 * the notch: whatever is in the count comes before the text field when the
 * owner taps the resting notch. Mail that nobody has answered is there every
 * day, so if every reply stayed in the count the owner could never type.
 *
 * So a reply is in the count until the owner has seen it once: its line came
 * up, or it was a row of the list they opened. After that it waits in Home,
 * under the text field, as one row for all of them ("3 replies drafted"),
 * and it is not lost and not said again. The count is what is new.
 *
 * When mail speaks up by itself it is about one reply, the newest unseen.
 * When the owner comes to it and several are unseen, it is one line and a
 * list behind it, and each row opens its reply.
 *
 * Where it speaks up (pass 8): a reply to a mail that has just come speaks
 * from anywhere, with its source in front ("In Gmail: you have not replied
 * to Marco") unless Gmail is what the owner is looking at. The replies the
 * first look found for mail that had been lying there speak only in Gmail:
 * twenty old mails are not twenty interruptions.
 *
 * What the owner can do with a reply, and what each thing does:
 *
 *   a time on the line  when the reply offers a time and the calendar gave
 *                       free ones, the line is the prototype's: "Anna asked
 *                       to move Thursday. Offer a slot?" with the times as
 *                       keys. A pick puts that time into the reply, and the
 *                       letter is on the notch, with the time lit, while a
 *                       fuse of eight seconds burns on it. Then it goes: no
 *                       second key. Esc in the fuse takes the pick back and
 *                       the line with the times is up again. A letter too
 *                       long for the paper is opened as a draft instead
 *   yes on the line     shows the draft, on paper, with who it goes to
 *   a lit word          the tone: the reply is written again in that manner.
 *                       The time, when the reply names one: the owner's own
 *                       time takes its place in the text.
 *                       "tell me", beside what Jarvis did not know: the owner
 *                       types it, and the reply is written again with it
 *   yes on the draft    the reply is put into the thread as a draft in Gmail,
 *                       a fuse burns, and it is sent. Saying yes is the
 *                       approval: nothing more is asked
 *   after it went       when the owner had turned the tone on the draft, it
 *                       asks once: "Always use a short tone with Marco?" A
 *                       yes is kept, and the next replies to that person are
 *                       written so. A no is not asked again
 *   Esc while it burns  takes the yes back, and nothing else: the draft is
 *                       removed from Gmail, and the reply goes back to waiting
 *   Esc before that     on the line that offered the reply, and on its draft,
 *                       is a no: the reply is turned down and does not come
 *                       back. On a draft the owner opened from the list it
 *                       closes the draft and goes back to the list: the list
 *                       is a menu, and leaving a page of it throws nothing
 *                       away. "Not needed", under every draft, turns one down
 *   left alone          it folds and goes back to the count. Not now is not no
 *
 * A draft the owner asked to see comes up at once. Whether it is still an
 * answer to the last word in its thread is asked of the mailbox behind it, and
 * if the thread has moved on the draft is taken away with a line that says so.
 * Before anything is written into the thread it is asked again, and waited for.
 *
 * Before the line is shown, the mailbox is asked whether the reply is still
 * an answer to the last word in its thread. Before anything is written or
 * sent, the page itself checks that the reply goes to exactly the people
 * ./waiting.ts decided on (./page/reply.js): that is not a model's to decide,
 * and not this file's either.
 *
 * The reply speaks up by itself in one place for now: when the owner comes to
 * Gmail. Everywhere else it joins the count.
 */
import { NOTCH_NAME } from '../name.ts';
import type { NotchInbox, NotchItem, NotchItemEnd } from '../inbox.ts';
import type { NotchBlock, NotchPart } from '../protocol.ts';
import { saidOption } from '../said.ts';
import { NotchStageEnded, type NotchStage } from '../stage.ts';
import type { Mailbox, MailReplyPlan } from './mailbox.ts';
import type { MailCalendarEvent } from './proposer.ts';
import { sendMail } from './send.ts';
import { MAIL_SLOT_LEAST_AHEAD_MS, mailSlotFree, mailSlotWords, type MailRowSlot } from './slots.ts';
import type { MailProposalRow, MailStore, MailTone } from './store.ts';
import { mailFirstName, type MailPerson } from './thread.ts';
import type { MailLook, MailWatch } from './watch.ts';
import { routeByIntents, type NotchIntent } from '../intents.ts';

/** How long the owner has to take a yes back before the reply goes out. */
export const MAIL_FUSE_MS = 5000;
/**
 * How long the letter of a picked time is on the notch, under its fuse, before
 * it goes. Longer than a reply's five seconds: this is the first time the
 * owner sees the letter, and there is no second yes (the owner's decision of
 * 26 November 2026). The owner's to tune.
 */
export const MAIL_SLOT_FUSE_MS = 8000;
/**
 * The most rows of the paper a letter that goes on a pick may take, the line
 * that says who it goes to included. The paper on the notch must hold it
 * without scrolling, and it has to be read while the fuse burns. A longer
 * letter is opened as any draft is, and waits for its yes.
 */
export const MAIL_SLOT_PAPER_ROWS = 12;
/** How many columns a row of the paper is counted as. Fewer than it holds: a letter is rather opened than cut off. */
export const MAIL_SLOT_PAPER_COLUMNS = 48;
/** How often the thread is asked whether it shows a reply that was sent, and how long between two askings. */
export const MAIL_SENT_LOOKS = 2;
export const MAIL_SENT_LOOK_MS = 1500;
/** How long after saying that nothing waits it is not said again: coming back to Gmail is not a question. */
export const MAIL_NOTHING_AGAIN_MS = 30 * 60 * 1000;
/** A look this recent is taken as the state of the mailbox when the owner comes to Gmail. */
export const MAIL_LOOK_FRESH_MS = 10 * 60 * 1000;

/** How long the calendar is waited for, between a pick and its send, to say whether the time is still free. */
export const MAIL_SLOT_ASK_MS = 6000;

/** The link under a draft that turns the reply down for good. */
export const MAIL_NOT_NEEDED = 'not-needed';

/** The word on the draft that takes what the owner tells Jarvis, and what it says before and after they have. */
export const MAIL_TOLD_WORD = 'told';
export const MAIL_TELL = 'tell me';
export const MAIL_TELL_AGAIN = 'change';

/**
 * What a reply can be turned to with one click, beside the owner's own words.
 * The owner, 17 November 2026: a proposal came by mail, the draft accepted
 * it, and he did not want to: "I want a way for me to steer the draft, and
 * that's very important." A reply says yes or no for them, so which of the
 * two is always theirs to turn.
 */
export const MAIL_STEERS = ['say no', 'say yes', 'ask for more time'] as const;
/** How long after a draft left the notch for the talk keys what is said is still about that draft. */
export const MAIL_STEER_SAID_MS = 45_000;
/**
 * How long after a draft left the notch the talk keys may still have gone
 * down for what they carry to be about that draft. The keys are what takes
 * the draft off, so they go down before it leaves, or with it; this is room.
 */
export const MAIL_STEER_KEYS_MS = 3000;

/**
 * Whether what was said, with a draft in hand, is what the reply is to say:
 * "decline it, we are full until January". A question is not ("what did he
 * ask for?"), and neither is a bare yes or no, which is nobody's sentence
 * for a letter.
 */
export function mailSteer(text: string): boolean {
  const said = text.trim().replace(/[.!\s]+$/, '');
  if (!said || said.endsWith('?')) return false;
  if (/^(?:who|whom|what|where|when|why|how|which|whose|is|are|was|were|can|could|do|does|did|will|would|should|has|have)\b/i.test(said)) return false;
  return !/^(?:yes|yeah|yep|no|nope|ok(?:ay)?|send(?: it)?|stop|cancel|never ?mind|thanks?(?: you)?|wait)$/i.test(said);
}

/** The manners a reply can be written again in. The first is the owner's own. */
export const MAIL_TONES: Record<string, string> = { yours: '', shorter: 'shorter', warmer: 'more warmly', 'more formal': 'more formally' };

/** A manner as the notch names it when it asks whether it is to stand: "Always use a short tone with Marco?" */
export const MAIL_TONE_NAMES: Record<string, string> = { shorter: 'short', 'more warmly': 'warm', 'more formally': 'formal' };

/**
 * How people are always written to, as things that are remembered: each
 * stands in Memory beside what else is known, and is forgotten there. With
 * `about`, only those about that one.
 */
export function mailToneFacts(tones: readonly MailTone[], about?: string): { id: string; about: string; text: string; source: string }[] {
  const wanted = (about ?? '').trim().toLowerCase();
  return tones
    .filter((one) => MAIL_TONE_NAMES[one.tone] && (!wanted || `${one.name} ${one.address}`.toLowerCase().includes(wanted)))
    .map((one) => ({ id: `tone:${one.address}`, about: one.name || one.address, text: `gets ${MAIL_TONE_NAMES[one.tone]} replies`, source: 'you said so on the notch' }));
}

export interface NotchMailDeps {
  store: MailStore;
  watch: Pick<MailWatch, 'hold' | 'release' | 'redraft' | 'stillWaits' | 'look' | 'lastLook' | 'busy'>;
  /** The mailbox to write through, or null when no desktop app with the notch's tab is there. */
  mailbox(): Mailbox | null;
  /** Whether Gmail is the site in front. When it is not, a line that speaks up names its source. Taken as yes when not given. */
  inGmail?(): boolean;
  /**
   * Whether the whole month has been gone through since the brain started. Until it has, "nobody is
   * waiting" is not known and is not said. Taken as yes when not given.
   */
  monthRead?(): boolean;
  /** The owner's calendar between two moments, or null when it cannot be reached: asked before a time is offered. */
  calendar?(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  /** The owner's time zone, for the words of a time. */
  zone?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchMail {
  /** Brings the inbox in line with the replies that wait. */
  sync(): void;
  /**
   * The owner has come to Gmail: the newest reply they have not seen speaks up, or it is said that
   * nothing waits. While the mailbox is still being read and nothing is ready, that is what is said,
   * and the answer is `reading`: whoever asked comes again when the reading is over.
   */
  arrived(): Promise<'spoke' | 'said' | 'reading' | 'nothing'>;
  /** A reply to a mail that has just come is ready: it speaks up wherever the owner is, when the notch lets it. */
  speak(): void;
  /** How many replies prepared since a moment the owner has not seen. */
  newSince(at: number): number;
  /** Another line has told the owner of the replies that wait (the morning line, "while you were away"): they do not each speak up after it. */
  told(): void;
  /** Home's row about the replies that wait, or null when none does. */
  homeRow(): NotchBlock | null;
  /** What that row opens: the reply when one waits, the list when several do. Comes back when it is closed. */
  open(stage: NotchStage): Promise<void>;
  /**
   * What the notch does itself with words said while a draft is open: they
   * are what the reply is to say, and it is written again. Null when no
   * draft is in hand, or the words are a question.
   */
  route(text: string, how?: { source: 'spoken' | 'typed' | 'offered'; at: number }): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
}

/** The one thing mail is in the inbox. */
export const NOTCH_MAIL_ITEM = 'mail';

const em = (text: string): NotchPart => ({ em: text });
const names = (people: MailPerson[]): string => people.map((who) => who.name || who.address).join(', ');
const short = (text: string, most: number): string => { const points = [...text.trim()]; return points.length <= most ? points.join('') : `${points.slice(0, most - 1).join('').trimEnd()}…`; };

/** The draft as a sheet: the paper, what Jarvis did not know, what it found, and the tone. */
export function mailDraftBlocks(row: MailProposalRow, note?: string): NotchBlock[] {
  let lit = false;
  // Each line of the reply is a paragraph on the paper. An empty line is the gap between two: the paper makes that itself.
  const lines = row.draft.split('\n').filter((line) => line.trim()).map((line): NotchPart[] => {
    const at = row.time && !lit ? line.indexOf(row.time) : -1;
    if (at < 0) return [line];
    lit = true;
    // The time is a word the owner can change: clicked, or typed over with their own.
    // With free times from the calendar, they are its choices, worded as the letter words them.
    const free = (row.slots ?? []).map((slot) => slot.words);
    return [line.slice(0, at), { word: { name: 'when', value: row.time!, options: free.includes(row.time!) ? free : [row.time!], label: 'Time', read: 'dayTime' } }, line.slice(at + row.time!.length)];
  });
  const to: NotchPart[] = ['To ', em(names(row.to))];
  if (row.cc.length) to.push('  ·  Copy to ', em(names(row.cc)));
  to.push(`  ·  Re: ${short(row.subject, 80)}`);
  const tone = Object.keys(MAIL_TONES).find((name) => MAIL_TONES[name] === row.tone) ?? 'yours';
  // What the thread is, before the reply to it: the owner knows what they are answering without opening the mail.
  const blocks: NotchBlock[] = [...(row.about ? [{ kind: 'note' as const, say: [short(row.about, 180)] }] : []), { kind: 'paper', to, lines }];
  // What it did not know is not the end of it: the owner can say it, in their own words, and the reply is
  // written again with it. One word on the sheet takes that: beside what is missing, or beside what was told.
  // And what it says is the owner's to turn, always: the same word stands under every draft, with the
  // commonest turns one click away. Typed, clicked, or said with the talk keys while the draft is open.
  const tell = (value: string): NotchPart => ({ word: { name: MAIL_TOLD_WORD, value, options: [...MAIL_STEERS], label: `Tell ${NOTCH_NAME}`, free: true, long: true } });
  if (row.missing) blocks.push({ kind: 'note', say: ['I did not know: ', short(row.missing, 200), ...(row.told ? [] : [' ', tell(MAIL_TELL)])] });
  if (row.told) blocks.push({ kind: 'note', say: ['You told me: ', em(short(row.told, 200)), ' ', tell(MAIL_TELL_AGAIN)] });
  if (!row.missing && !row.told) blocks.push({ kind: 'note', say: ['Not what you would say? ', tell(MAIL_TELL)] });
  if (row.found?.length) blocks.push({ kind: 'note', say: ['Found in your Drive: ', em(row.found.map((file) => short(file.name, 60)).join(', '))] });
  blocks.push({ kind: 'note', say: [note ?? 'Not sent yet.', ' Tone ', { word: { name: 'tone', value: tone, options: Object.keys(MAIL_TONES), label: 'Tone' } }] });
  // Turning a reply down for good is said in words, on the draft: it is not what closing a draft means.
  blocks.push({ kind: 'buttons', buttons: [{ id: MAIL_NOT_NEEDED, label: 'Not needed', quiet: true }] });
  return blocks;
}

/**
 * The letter of a picked time as it is shown under its fuse: who it goes to,
 * and every line of it, with the time lit. Nothing on it can be changed: the
 * time is not a word here, and there are no links. What is on this paper is
 * what is sent.
 */
export function mailSlotBlocks(row: MailProposalRow): NotchBlock[] {
  let lit = false;
  const lines = row.draft.split('\n').filter((line) => line.trim()).map((line): NotchPart[] => {
    const at = row.time && !lit ? line.indexOf(row.time) : -1;
    if (at < 0) return [line];
    lit = true;
    return [line.slice(0, at), em(row.time!), line.slice(at + row.time!.length)].filter((part) => part !== '');
  });
  const to: NotchPart[] = ['To ', em(names(row.to))];
  if (row.cc.length) to.push('  ·  Copy to ', em(names(row.cc)));
  to.push(`  ·  Re: ${short(row.subject, 80)}`);
  return [{ kind: 'paper', to, lines }];
}

/** How many rows of the paper a text takes, counted on the safe side: a wide sign (an ideograph, an emoji) is two columns. */
export function mailPaperRows(draft: string): number {
  const columns = (line: string): number => [...line.trim()].reduce((sum, sign) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(sign) ? 2 : 1), 0);
  return draft.split('\n').filter((line) => line.trim()).reduce((rows, line) => rows + Math.max(1, Math.ceil(columns(line) / MAIL_SLOT_PAPER_COLUMNS)), 0);
}

/**
 * How many rows the letter of a picked time takes as it is shown under its
 * fuse (`mailSlotBlocks`): its own, and the line above them that says who it
 * goes to, which with people in copy and a long subject is several.
 */
export function mailSlotRows(row: MailProposalRow): number {
  const paper = mailSlotBlocks(row)[0];
  const plain = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
  return mailPaperRows(row.draft) + (paper?.kind === 'paper' ? mailPaperRows(plain(paper.to)) : 0);
}

export function attachNotchMail(inbox: NotchInbox, deps: NotchMailDeps): NotchMail {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const { store, watch } = deps;
  /** Whether mail is in the inbox now. */
  let present = false;
  let saidNothingAt = -Infinity;
  /** "I am reading your mail" was said: once since the brain started is enough. */
  let saidReading = false;
  /** Replies the owner has seen once, as a line or as a row of the list they opened: these wait in Home, not in the count. */
  const seen = new Set<string>();
  const unseen = (): MailProposalRow[] => store.ready().filter((row) => !seen.has(row.id));
  /** The draft that is open on the notch, or was until a moment ago: what is said then is about it. */
  let inHand: { id: string; showing: boolean; leftAt: number } | null = null;
  /**
   * Replies on which Send was pressed and that nothing confirmed: since when, and the words that
   * were sent. Before such a reply is sent again the mailbox is asked whether it went. Kept for as
   * long as the brain runs: after a restart only the thread's own last word guards a second send.
   */
  const maybeSent = new Map<string, { since: number; text: string }>();
  /**
   * Replies whose picked time the owner took back, or whose letter could not be shown under its
   * fuse. From then on Esc on anything that offers that reply is "not now", never a no: whoever
   * pressed Esc to make sure nothing goes has not turned the reply down, whichever line is up when
   * the second Esc lands. Kept for as long as the reply waits and the brain runs.
   */
  const tookBack = new Set<string>();
  /** The line of free times that is on the notch, or was until the talk keys took it off: a time said then picks one. */
  let slotsUp: { id: string; says: string[]; showing: boolean; leftAt: number } | null = null;

  const decline = (id: string): NotchItemEnd => {
    store.move(id, 'ready', 'declined', now());
    return 'settled';
  };

  /**
   * The times a reply can still offer, with the words the notch has for each.
   * Null when it offers none: it never did, they have passed, or the time the
   * letter names is not in it once, so that another could not take its place.
   */
  function openSlots(row: MailProposalRow): (MailRowSlot & { say: string })[] | null {
    if (!row.slots?.length || !row.time || row.draft.split(row.time).length !== 2) return null;
    if (!row.slots.some((slot) => slot.words === row.time)) return null;
    const open = row.slots.filter((slot) => slot.at - now() >= MAIL_SLOT_LEAST_AHEAD_MS);
    return open.length >= 2 ? open.map((slot) => ({ ...slot, say: mailSlotWords(slot.at, deps.zone) })) : null;
  }

  /** Whether a time is still free, asked of the calendar now. Null when the calendar does not answer in time. */
  async function stillFree(slot: MailRowSlot): Promise<boolean | null> {
    if (!deps.calendar) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race([
        deps.calendar(slot.at - 3_600_000, slot.at + slot.minutes * 60_000 + 3_600_000).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MAIL_SLOT_ASK_MS); (timer as { unref?: () => void }).unref?.(); }),
      ]);
      return events ? mailSlotFree(slot, events) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One reply, from its line to its end. `line: false` opens the draft at
   * once: the owner picked it from the list. Comes back `settled` when the
   * reply no longer waits, `waits` when it does. `unseen`: its letter could
   * not be shown under the fuse of a pick, so it is opened as a draft and
   * says why.
   */
  async function play(stage: NotchStage, id: string, options: { line: boolean; keep?: 'back' | 'close'; asked?: boolean; steer?: string; pick?: string; unseen?: boolean }): Promise<NotchItemEnd> {
    let row = store.proposal(id);
    if (!row || row.state !== 'ready') return 'settled';
    const who = mailFirstName(row.who);
    // The owner asked to see it: it comes up now, and the mailbox is asked behind it whether the thread
    // has moved on. Found on the owner's first evening with it (15 November 2026): asked first, and in
    // three questions that each waited their turn behind a look through the month, a draft took
    // seconds to open.
    const GONE = Symbol('the thread moved on');
    const gone: Promise<typeof GONE> | null = options.asked
      ? new Promise((resolve) => { void watch.stillWaits(id).then((still) => { if (still === false) resolve(GONE); }, () => {}); })
      : null;
    const unlessGone = <T>(wait: Promise<T>): Promise<T | typeof GONE> => {
      if (!gone) return wait;
      // The wait that is left behind ends with the stage: that is not a failure of anything.
      wait.catch(() => {});
      return Promise.race([wait, gone]);
    };
    const movedOn = async (): Promise<NotchItemEnd> => {
      store.move(id, 'ready', 'answered', now());
      await stage.say(['The thread has moved on since. This reply is no longer needed.'], 3400, { src: 'mail' });
      return 'settled';
    };
    /** The time picked on the line, as the notch says it: the letter goes out with it, shown under its fuse. */
    let offering: string | null = null;
    /** A time was picked, and the letter is too long to be read under a fuse: it is opened as a draft. */
    let long = false;
    if (options.line) {
      // A reply whose times have passed while it waited is written again, for the calendar as it is now.
      if (row.slots?.length && !openSlots(row)) {
        const writing = stage.id();
        stage.put({ id: writing, kind: 'work', say: ['The times in a reply have passed. Writing it again…'], steps: 0, done: 0, src: 'mail' });
        const again = await watch.redraft(id, {}).catch(() => null);
        if (stage.ended()) return 'waits';
        if (again) row = again;
      }
      let slots = openSlots(row);
      let taken = '';
      // Said with the talk keys while the line was up: that time is the pick, if it is still one of them.
      let said = options.pick;
      while (slots) {
        const open = slots;
        let chosen = said ? open.find((slot) => slot.say === said) : undefined;
        said = undefined;
        if (!chosen) {
          // The prototype's line: who asked for what, and the free times as keys.
          const mine = { id, says: open.map((slot) => slot.say), showing: true, leftAt: 0 };
          slotsUp = mine;
          let pick: Awaited<ReturnType<NotchStage['choose']>> | typeof GONE;
          try {
            pick = await unlessGone(stage.choose(
              [...source('', ''), ...(taken ? [em(taken), ' has been taken since. Another?'] : [em(who), ` asked ${row.asked || 'for a time'}. Offer a slot?`])],
              mine.says, { src: 'mail' }));
          } catch (error) {
            // Taken off the notch by something else (the talk keys, above all): what is said in the next moment may pick one.
            if (slotsUp === mine) slotsUp = error instanceof NotchStageEnded ? { ...mine, showing: false, leftAt: now() } : null;
            throw error;
          }
          if (slotsUp === mine) slotsUp = null;
          if (pick === GONE) return movedOn();
          if (pick.act === 'fold') return 'waits';
          // Esc on the line that came back after a pick was taken back is not a no to the reply:
          // whoever presses Esc twice to be sure nothing goes must not lose the reply for it.
          if (pick.act === 'no') return tookBack.has(id) ? 'waits' : decline(id);
          chosen = open.find((slot) => slot.say === pick.option);
          if (pick.act !== 'pick' || !chosen) continue;
        }
        // The calendar is asked now: the reply may have waited for hours. Not known is not no.
        if ((await stillFree(chosen)) === false) {
          taken = chosen.say;
          slots = open.filter((slot) => slot !== chosen);
          if (slots.length === 0) {
            await stage.say(['None of those times is free any more. The reply is kept.'], 3600, { src: 'mail' });
            return 'waits';
          }
          continue;
        }
        if (chosen.words !== row.time) {
          row = { ...row, draft: row.draft.replace(row.time!, chosen.words), time: chosen.words, updatedAt: now() };
          store.put(row);
        }
        // Nothing a model wrote goes out unseen. A letter that the paper holds whole is shown under
        // the fuse. One that it does not is opened as any draft, and waits for its own yes.
        if (mailSlotRows(row) > MAIL_SLOT_PAPER_ROWS) long = true; else offering = chosen.say;
        break;
      }
      if (!offering && !long) {
        const first = await unlessGone(stage.offer([...source('you', 'You'), ' have not replied to ', em(who), '. I drafted a reply.'], 'show', { src: 'mail' }));
        if (first === GONE) return movedOn();
        if (first.act === 'fold') return 'waits';
        if (first.act === 'no') return tookBack.has(id) ? 'waits' : decline(id);
      }
    }
    // A sheet the owner did not ask for by a yes to "show": the letter of a pick that was too long
    // for the fuse, or could not be shown under it, or a reply whose pick they took back. Esc
    // closes it and keeps the reply, and the key says so. "Not needed" is the no, in words.
    const keep = options.keep ?? (long || options.unseen || tookBack.has(id) ? 'close' : undefined);

    if (!offering) {
    // The draft, on paper. Only yes and Esc answer it: a click somewhere else is neither.
    const sheet = stage.id();
    stage.put({ id: sheet, kind: 'sheet', say: ['Reply to ', em(who)], blocks: mailDraftBlocks(row, long ? 'Too long to send on a pick: read it first. Not sent yet.' : options.unseen ? 'The letter could not be shown whole under its fuse, so nothing was sent. Read it here. Not sent yet.' : undefined), yes: 'send', stay: true, ...(keep ? { no: keep } : {}), src: 'mail' });
    /** The owner said what the reply is to say: it is written again with that, and the paper says so while it is. */
    const retell = async (value: string): Promise<boolean> => {
      stage.surface.update(sheet, { blocks: mailDraftBlocks({ ...row!, told: value }, 'Writing it again…') });
      const again = await watch.redraft(id, { told: value });
      if (stage.ended()) return false;
      if (again) row = again;
      stage.surface.update(sheet, { blocks: mailDraftBlocks(row!, again ? undefined : 'I could not write it again. This is the reply as it was.') });
      return true;
    };
    // This draft is in hand: what is said with the talk keys while it is open is about it (`route`).
    const mine = { id, showing: true, leftAt: 0 };
    inHand = mine;
    /** The owner answered the draft: sent, closed or turned down. It is in hand no more. */
    let closed = false;
    try {
    // Said with the talk keys, a moment ago, while this draft was open.
    if (options.steer && !(await retell(options.steer))) return 'waits';
    for (;;) {
      const answer = await unlessGone(stage.answer(sheet, ['yes', 'no', 'word', 'button']));
      if (answer === GONE || answer.act === 'yes' || answer.act === 'no' || (answer.act === 'button' && answer.button === MAIL_NOT_NEEDED)) closed = true;
      if (answer === GONE) return movedOn();
      if (answer.act === 'button') { if (answer.button === MAIL_NOT_NEEDED) return decline(id); continue; }
      // Esc. On a draft the owner opened from the list or from Home it closes the draft, and the sheet
      // says so beside the key: the reply is kept. On the draft of a reply that was offered, it is a no.
      if (answer.act === 'no') return keep ? 'waits' : decline(id);
      if (answer.act === 'yes') break;
      const value = (answer.value ?? '').trim();
      if (answer.word === 'when' && row.time && value && value !== row.time && row.draft.includes(row.time)) {
        // The owner's own time, in the place of the one that was proposed.
        row = { ...row, draft: row.draft.replace(row.time, value), time: value, updatedAt: now() };
        store.put(row);
        stage.surface.update(sheet, { blocks: mailDraftBlocks(row) });
      }
      if (answer.word === 'tone' && value in MAIL_TONES && MAIL_TONES[value] !== row.tone) {
        // A new tone is a new letter: it is written again, and the paper says so while it is.
        stage.surface.update(sheet, { blocks: mailDraftBlocks({ ...row, tone: MAIL_TONES[value]! }, 'Writing it again…') });
        const again = await watch.redraft(id, { tone: MAIL_TONES[value]! });
        if (stage.ended()) return 'waits';
        if (again) row = again;
        stage.surface.update(sheet, { blocks: mailDraftBlocks(row, again ? undefined : 'I could not write it again. This is the reply as it was.') });
      }
      if (answer.word === MAIL_TOLD_WORD && value && value !== MAIL_TELL && value !== MAIL_TELL_AGAIN && value !== row.told) {
        // What was not known, or what the reply is to say instead: typed, or one of the turns picked.
        if (!(await retell(value))) return 'waits';
      }
    }
    } finally {
      // Taken off the notch by something else (the talk keys, above all): still in hand for a moment.
      if (inHand === mine) inHand = closed ? null : { id, showing: false, leftAt: now() };
    }
    }

    // Yes: into the thread as a draft, a fuse, and out.
    const mailbox = deps.mailbox();
    if (!mailbox) {
      await stage.say(['I cannot reach Gmail from here to send it. The reply is kept.'], 4200, { mood: 'worried', src: 'mail' });
      return 'waits';
    }
    // Asked of the mailbox itself, not of what was seen a minute ago: this is about to be sent.
    if ((await watch.stillWaits(id, 0)) === false) {
      // Whoever found it out has usually marked it already; here it is made sure of.
      store.move(id, 'ready', 'answered', now());
      await stage.say(['The thread has moved on since. I did not send it.'], 3600, { src: 'mail' });
      return 'settled';
    }
    // The last yes pressed Send and nothing confirmed it. That the thread has not moved on is not
    // enough to send again: it was the only guard, and a thread that could not be read let a
    // second send through. The mailbox is asked for the reply as it was sent.
    const before = maybeSent.get(id);
    if (before) {
      const looking = stage.id();
      stage.put({ id: looking, kind: 'work', say: ['Looking whether it went…'], steps: 0, done: 0, src: 'mail' });
      const there = await mailbox.went({ to: row.to[0]?.address ?? row.who.address, thread: row.thread, subject: row.subject, text: before.text }, before.since).catch(() => null);
      if (there === true) {
        maybeSent.delete(id);
        store.move(id, 'ready', 'sent', now());
        log('[notch] a reply that may have gone had gone: it is not sent again');
        await stage.say(['It had gone: it is in the thread. I did not send it again.'], 3800, { mood: 'happy', mark: 'check', src: 'mail' });
        return 'settled';
      }
      if (there === null) {
        await stage.say(['I cannot see whether it went the first time, so I am not sending it again. Look in the thread first.'], 5200, { mood: 'careful', src: 'mail' });
        return 'waits';
      }
    }
    // The reply as it goes: what is asked after it went is asked about this one.
    const going = row;
    const plan: MailReplyPlan = { thread: going.thread, to: going.to.map((person) => person.address), cc: going.cc.map((person) => person.address), text: going.draft };
    watch.hold(id);
    // Said at once: the tab may be in the middle of a look, and the yes must not seem to have gone nowhere.
    const putting = stage.id();
    // Before the letter of a picked time the notch must be in sight: where it hides behind a video, it comes back for this line already.
    stage.put({ id: putting, kind: 'work', say: ['Putting it in the thread…'], steps: 0, done: 0, src: 'mail', ...(offering ? { asks: true } : {}) });
    // The line shows "esc stop", and it means it. Nobody listened: Esc dimmed the line, and "Sending to…" came
    // all the same a few seconds later. An Esc here ends it before anything is sent.
    let stopped = false;
    stage.answer(putting, ['stop']).then(() => { stopped = true; }, () => {});
    /** How the fuse ended: only a fuse that was seen to burn out lets the reply go. */
    let went = 'lost' as 'done' | 'undo' | 'unseen' | 'lost';
    /**
     * `back`: a picked time was taken back. The line with the times comes up again, once the thread is let go.
     * `open`: its letter was not seen under the fuse by a page that was there. It is opened as a draft.
     */
    const ended = await (async (): Promise<NotchItemEnd | 'back' | 'open'> => {
    try {
      // The one way a mail is sent in a thread (./send.ts): written, the fuse, Send, and the look.
      const end = await sendMail(mailbox, plan, {
        stopped: () => stopped,
        gate: async () => {
          // A picked time: the letter is on the notch for as long as the fuse burns, with the time lit.
          // It is the first and only time the owner sees it before it goes, so the fuse is longer, and
          // only a page that says it drew the letter and showed its end lets it go (`NotchStage.letter`).
          went = offering
            ? await stage.letter(['Offering ', em(offering), ` to ${who}…`], MAIL_SLOT_FUSE_MS, mailSlotBlocks(going), { src: 'mail' })
            : await stage.fuse(['Sending to ', em(who), '…'], MAIL_FUSE_MS, { src: 'mail' });
          return went === 'done';
        },
        // A reply is called sent when it is the last word in its thread: Gmail's word alone is not it.
        trust: 'thread',
        // What the owner read and said yes to stays in their drafts when it does not go, and is said to be there.
        leftover: 'keep',
        asks: MAIL_SENT_LOOKS,
        waitMs: MAIL_SENT_LOOK_MS,
        // A stage that ends between two looks fails this wait, and the looking ends there (./send.ts).
        wait: (ms) => stage.wait(ms),
        now,
      });
      if (end.state === 'not_sent' && end.at === 'stopped') {
        // Written down before anything is said: it holds whatever takes the notch now.
        if (offering) tookBack.add(id);
        // The owner stopped it. A draft that was there before is somebody's: stopping this reply does not throw that one away.
        await stage.say(
          end.draft === 'none' ? ['Not sent. It is kept here.']
            : end.draft === 'theirs' ? ['Not sent. The draft that was in that thread is left as it was.']
              : end.draft === 'gone' ? ['Not sent. No draft is left in Gmail.'] : ['Not sent. The draft is still in your Gmail drafts.'],
          3200, { src: 'mail' });
        return offering ? 'back' : 'waits';
      }
      if (end.state === 'not_sent' && end.at === 'write' && end.draft === 'theirs') {
        // Somebody's draft is in that thread: the owner's own, or an earlier
        // one that did not go. It is not written into, and above all it is
        // not thrown away.
        log('[notch] a reply was not written: its thread already holds a draft');
        // The same words as this reply: most likely this reply, left from a try that did not end
        // (the brain stopped while its fuse burnt). Said, and still not touched: it may be the owner's.
        await stage.say(end.same
          ? ['This reply is already in that thread as a draft, left from an earlier try. I left it alone, and nothing was sent. Send it there, or delete it and pick again.']
          : ['There is a draft in that thread already. I left it alone, and nothing was sent.'], end.same ? 7200 : 5200, { mood: 'careful', src: 'mail' });
        return 'waits';
      }
      if (end.state === 'not_sent' && end.at === 'write') {
        log(`[notch] a reply could not be put in its thread: ${end.why}`);
        // Whatever got as far as the page was taken away again: nothing half written is left behind.
        // When that did not work the truth is said: a draft left in the thread stands in the way
        // of every later reply to it, and the owner has to know where to look.
        const gone = end.draft === 'gone';
        if (!gone) log(`[notch] what was begun in the thread could not be taken away: ${end.leftWhy ?? ''}`);
        await stage.say(gone
          ? ['I could not put the reply in the thread, so nothing was sent. It is kept here.']
          : ['I could not put the reply in the thread, so nothing was sent. A draft may be left in that thread in Gmail. The reply is kept here.'], gone ? 4600 : 6200, { mood: 'worried', mark: 'fail', src: 'mail' });
        return 'waits';
      }
      if (end.state === 'not_sent' && end.at === 'gate') {
        // Taken back, or nobody was there to see it burn: nothing went out, and the draft was taken away.
        const left = end.draft !== 'gone';
        if (went === 'undo') {
          if (offering) tookBack.add(id);
          await stage.say(left ? ['Not sent. The draft is still in your Gmail drafts.'] : ['Not sent. No draft is left in Gmail.'], 3200, { src: 'mail' });
          if (offering) tookBack.add(id);
          return offering ? 'back' : 'waits';
        }
        if (went === 'unseen') {
          // A page was there, said the fuse ran out, and did not vouch for the letter (an older
          // page that draws none, a letter whose end was off screen, a notch out of sight). The
          // owner may have watched the fuse burn out: they are told nothing went, and get the
          // letter as a draft to read, rather than the same refusal at every pick.
          tookBack.add(id);
          await stage.say(left ? ['Not sent: the letter could not be shown whole. The draft is still in your Gmail drafts.'] : ['Not sent: the letter could not be shown whole. Here it is to read.'], 3600, { mood: 'careful', src: 'mail' });
          return 'open';
        }
        // No page said anything: the notch went away while the letter was up.
        if (offering) await stage.say(left ? ['Not sent: the notch went away while the letter was up. The draft is still in your Gmail drafts.'] : ['Not sent: the notch went away while the letter was up. The reply is kept.'], 4200, { mood: 'careful', src: 'mail' });
        return 'waits';
      }
      if (end.state === 'not_sent') {
        // The page refused before it pressed Send: nothing went.
        log(`[notch] a reply could not be sent: ${end.why}`);
        await stage.say(['I could not send it. It is in your Gmail drafts.'], 4600, { mood: 'worried', mark: 'fail', src: 'mail' });
        return 'waits';
      }
      if (end.state === 'unsure') {
        // Send was pressed and nothing shows that it went. It may have gone all the same: it is
        // written down before anything is said, so that the next yes looks for it first whatever
        // takes the notch now.
        maybeSent.set(id, { since: end.since, text: going.draft });
        if (end.said) {
          await stage.say(['Gmail says it was sent, but I do not see it in the thread yet. I will look again.'], 4600, { mood: 'curious', src: 'mail' });
          return 'waits';
        }
        // Gmail did not say it went, and the thread does not show it. It used to be called "in
        // your Gmail drafts", and the owner sent it a second time.
        log(`[notch] a reply was sent and nothing confirms it: ${end.why}`);
        await stage.say(['I pressed Send, and nothing says it went. Look in the thread before sending it again.'], 5200, { mood: 'worried', src: 'mail' });
        return 'waits';
      }
      maybeSent.delete(id);
      store.move(id, 'ready', 'sent', now());
      await stage.say(offering ? ['Offered ', em(offering), ` to ${who}.`] : ['Sent to ', em(who), '.'], offering ? 2800 : 2400, { mood: 'happy', mark: 'check', src: 'mail' });
      // The prototype: "Always use a short tone with Marco?" A reply that went in a manner the owner chose
      // on its draft, and that does not stand for this person yet. Asked once: a no is not asked again.
      const name = MAIL_TONE_NAMES[going.tone];
      if (!offering && name && store.tone(going.who.address) !== going.tone && store.toneAsked(going.who.address) !== going.tone) {
        const always = await stage.offer(['Always use a ', em(name), ' tone with ', em(who), '?'], 'yes', { mood: 'curious', src: 'mail' });
        if (always.act === 'yes') {
          store.setTone(going.who, going.tone, now());
          log('[notch] a manner was remembered for one person');
          await stage.say(['Remembered.'], 2400, { mood: 'happy', mark: 'check', src: 'mail' });
        } else if (always.act === 'no') {
          store.declineTone(going.who, going.tone, now());
        }
      }
      return 'settled';
    } finally {
      watch.release(id);
    }
    })();
    // Esc took the pick back, and nothing else: the owner is where they were, on the line with the times.
    if (ended === 'back') return play(stage, id, { line: true, ...(options.asked ? { asked: true } : {}) });
    if (ended === 'open') return play(stage, id, { line: false, unseen: true });
    return ended;
  }

  /**
   * How a line about mail begins. Always with its source: in Gmail the place itself says it, anywhere
   * else the line does ("In Gmail: you ..."). `after` is the word that follows the source, `alone` the
   * word the line begins with when no source is named.
   */
  const source = (after: string, alone: string): NotchPart[] => (deps.inGmail?.() === false ? [em('In Gmail:'), after ? ` ${after}` : ' '] : alone ? [alone] : []);

  /** Is this reply still an answer to the last word? Asked of the mailbox unless a look saw so a moment ago. Not known is not no. */
  const stillTrue = async (row: MailProposalRow): Promise<boolean> =>
    store.proposal(row.id)?.state === 'ready' && (await watch.stillWaits(row.id)) !== false;

  /** The list of the replies that wait: who, and about what. A row opens its reply. */
  const listBlocks = (ready: MailProposalRow[]): NotchBlock[] =>
    ready.map((row) => {
      const who = mailFirstName(row.who);
      // The row begins with who it is: a sentence that begins with them too goes on from there.
      const about = row.about.startsWith(`${who} `) ? row.about.slice(who.length + 1) : row.about;
      return { kind: 'row', id: row.thread, lead: short(who, 18), say: [short(about || row.subject, 110)], go: true };
    });

  /** The list, until it is closed or nothing is left in it. Every reply in it has been seen from then on. */
  async function list(stage: NotchStage): Promise<void> {
    for (;;) {
      const ready = store.ready();
      if (ready.length === 0) return;
      for (const row of ready) seen.add(row.id);
      const answer = await stage.sheet([ready.length === 1 ? '1 reply waits' : `${ready.length} replies wait`], listBlocks(ready), { src: 'mail' });
      if (answer.act !== 'go' || !answer.row) return;
      const row = ready.find((entry) => entry.thread === answer.row);
      if (!row) continue;
      await play(stage, row.id, { line: false, keep: 'back', asked: true });
    }
  }

  /**
   * Mail in the count: the replies the owner has not seen. One reply when it
   * speaks up by itself or only one is unseen, one line and the list behind
   * it when the owner came and several are. Whatever they do with the line,
   * it has had its say: the replies wait in Home from then on.
   */
  async function playMail(stage: NotchStage, how: { unasked: boolean }): Promise<NotchItemEnd> {
    const left = (): NotchItemEnd => (unseen().length > 0 ? 'waits' : 'settled');
    const fresh = unseen();
    if (fresh.length === 0) return 'settled';
    if (how.unasked) {
      // Speaking up by itself: nobody is waiting, so the mailbox is asked first. A line about a thread
      // that was answered a minute ago is not said and then taken back.
      let row: MailProposalRow | undefined;
      for (const candidate of fresh) {
        seen.add(candidate.id);
        if (await stillTrue(candidate)) { row = candidate; break; }
      }
      if (row) await play(stage, row.id, { line: true });
      return left();
    }
    const [only] = fresh;
    if (fresh.length === 1 && only) {
      seen.add(only.id);
      await play(stage, only.id, { line: true, asked: true });
      return left();
    }
    for (const row of fresh) seen.add(row.id);
    const many = await stage.offer([...source('', ''), em(`${fresh.length} people`), ' are waiting for a reply. I drafted them.'], 'show', { src: 'mail' });
    // Esc here is not a no to anyone's reply: each is turned down on its own draft.
    if (many.act === 'yes') await list(stage);
    return left();
  }

  const item = (speaks: boolean): NotchItem => ({
    id: NOTCH_MAIL_ITEM,
    subject: NOTCH_MAIL_ITEM,
    class: 'person',
    speaks,
    title: () => {
      const fresh = unseen();
      const [only] = fresh;
      return fresh.length === 1 && only ? ['Reply to ', em(mailFirstName(only.who)), `: ${short(only.subject, 60)}`] : [em(`${fresh.length} replies`), ' drafted, waiting for your word'];
    },
    check: () => unseen().length > 0,
    play: playMail,
  });

  function sync(): void {
    // What is no longer waiting need not be remembered as seen.
    const ready = new Set(store.ready().map((row) => row.id));
    for (const id of [...seen]) if (!ready.has(id)) seen.delete(id);
    for (const id of [...tookBack]) if (!ready.has(id)) tookBack.delete(id);
    const waiting = unseen().length > 0;
    if (waiting && (!present || !inbox.has(NOTCH_MAIL_ITEM))) { present = true; inbox.add(item(false)); }
    // The last unseen reply was answered, sent or turned down elsewhere: mail leaves the count by itself.
    if (!waiting && present) { present = false; inbox.remove(NOTCH_MAIL_ITEM); }
  }

  function speak(): void {
    sync();
    // A reply the owner has not seen takes the notch when the notch lets it. Something that is up
    // already is not spoken over, and nobody's one say is used up for it.
    if (unseen().length === 0 || inbox.showing() !== null) return;
    present = true;
    inbox.add(item(true));
  }

  async function arrived(): Promise<'spoke' | 'said' | 'reading' | 'nothing'> {
    // What is known is brought up to date first, unless it was just now. A look that is under way is
    // not waited for: the first one goes through a month, and what it has prepared so far is there.
    const last = watch.lastLook();
    let look: MailLook | null = last && now() - last.at < MAIL_LOOK_FRESH_MS ? last.look : null;
    const reading = watch.busy();
    if (!look && !reading) look = await watch.look('recent').catch(() => null);
    if (store.ready().length > 0) { speak(); return 'spoke'; }
    sync();
    // The mailbox could not be reached at all: that is what is said, whatever else is not known.
    const unreachable = !!look && !look.through && !reading;
    // Still being read, or the month not yet gone through, and nothing found so far: who is waiting is
    // not known. That is said, once, so that the owner is not left looking at a notch that says nothing,
    // and "nobody is waiting" is kept for when it is true.
    if (!unreachable && (reading || deps.monthRead?.() === false)) {
      if (!saidReading) saidReading = inbox.present('mail-reading', (stage) => stage.say(['I am reading your mail. One moment.'], 2600, { mood: 'read', src: 'mail' }));
      return 'reading';
    }
    if (now() - saidNothingAt < MAIL_NOTHING_AGAIN_MS) return 'nothing';
    // Said only when it is true: the mailbox was looked at, and nobody is waiting. When it could not be
    // looked at, that is what is said.
    const words: NotchPart[] = look?.through
      ? ['Nobody in your mail is waiting for a reply.']
      : ['I cannot see your mail right now. My own browser may not be signed in to Gmail.'];
    if (inbox.present('mail-nothing', (stage) => stage.say(words, 3600, { src: 'mail' }))) saidNothingAt = now();
    return 'said';
  }

  function homeRow(): NotchBlock | null {
    const ready = store.ready();
    const [only] = ready;
    if (!only) return null;
    return {
      kind: 'row', id: 'mail', lead: 'Mail', go: true,
      say: ready.length === 1 ? ['Reply to ', em(mailFirstName(only.who)), ' is drafted'] : [em(`${ready.length} replies`), ' drafted, waiting for your word'],
    };
  }

  async function open(stage: NotchStage): Promise<void> {
    const ready = store.ready();
    const [only] = ready;
    if (ready.length === 1 && only) {
      seen.add(only.id);
      // From Home's row: as from the list, closing the draft throws nothing away.
      await play(stage, only.id, { line: false, keep: 'close', asked: true });
    } else {
      await list(stage);
    }
    // Seen now, all of them: mail is out of the count, if it was in it.
    sync();
  }

  function told(): void {
    for (const row of unseen()) seen.add(row.id);
    sync();
  }

  sync();
  /**
   * What was said with the talk keys while a draft is open, or was a moment
   * ago, is what that reply is to say: it is written again with it and comes
   * back up. Has no effect until `run`.
   */
  function slot(text: string, how?: { source: 'spoken' | 'typed' | 'offered'; at: number }): { did: string; run(): void } | null {
    // A time said over the line of free times picks it: "Friday at ten works". Meant only by what was
    // said with the keys that took that line off, as for a draft.
    const line = slotsUp;
    if (line && !line.showing && how?.source === 'spoken' && now() - line.leftAt < MAIL_STEER_SAID_MS && how.at <= line.leftAt + MAIL_STEER_KEYS_MS) {
      const at = saidOption(line.says, text);
      const row = at >= 0 ? store.proposal(line.id) : null;
      if (row?.state === 'ready') {
        const pick = line.says[at]!;
        return {
          did: `Offer ${pick}.`,
          run: () => {
            if (slotsUp === line) slotsUp = null;
            log('[notch] a free time was picked by voice');
            seen.add(line.id);
            inbox.present('mail-slot', async (stage) => { await play(stage, line.id, { line: true, pick }); sync(); });
          },
        };
      }
    }
    return null;
  }
  function steer(text: string, how?: { source: 'spoken' | 'typed' | 'offered'; at: number }): { did: string; run(): void } | null {
    const hand = inHand;
    if (!hand || !mailSteer(text)) return null;
    // A draft that has left the notch is still meant only by what was said
    // with the keys that took it off. It used to be meant by anything said or
    // typed in the next 45 seconds: a draft pushed aside by a meeting's
    // warning, then "open the Q3 deck", and the deck was never opened. The
    // words were taken as what the reply should say (the hardening audit,
    // 17 November 2026).
    if (!hand.showing) {
      if (now() - hand.leftAt >= MAIL_STEER_SAID_MS) return null;
      // The keys went down while the draft was still up, or within a moment of its going.
      if (!how || how.source !== 'spoken' || how.at > hand.leftAt + MAIL_STEER_KEYS_MS) return null;
    }
    const said = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const row = store.proposal(hand.id);
    if (!said || !row || row.state !== 'ready') return null;
    return {
      did: 'Write the reply again, as told.',
      run: () => {
        log('[notch] a reply is written again from what the owner said with the draft open');
        seen.add(hand.id);
        inbox.present('mail-steer', async (stage) => { await play(stage, hand.id, { line: false, keep: 'close', steer: said }); sync(); });
      },
    };
  }

  const intents: NotchIntent[] = [{
    // The reply is written with that time and shown under its fuse, which can be taken back.
    id: 'mail.slot', feature: 'mail', says: 'a time said over the line of free times picks it for the reply', band: 'up', act: 'send', first: 'line',
    examples: ['Friday at ten works'],
    match: slot,
  }, {
    // Only the draft on the notch is written again: nothing is sent by it.
    id: 'mail.steer', feature: 'mail', says: 'what is said with a draft open is what that reply is to say', band: 'up', act: 'none', first: 'acts',
    examples: ['decline it, we are full until January'],
    match: steer,
  }];
  const route = (text: string, how?: { source: 'spoken' | 'typed' | 'offered'; at: number }): { did: string; run(): void } | null => routeByIntents(intents, text, how);
  return { sync, arrived, speak, newSince: (at) => unseen().filter((row) => row.createdAt >= at).length, told, homeRow, open, route, intents: () => intents };
}
