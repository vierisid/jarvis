/**
 * Standing things (pass 11): what Jarvis keeps doing after the notch has
 * gone back to rest.
 *
 *   an eye     "Tell me when Sam replies." One thing is watched for, it is
 *              told once when it happens, and the eye is gone. While any eye
 *              is kept, one of the notch's own eyes is citron.
 *   a chase    "Get Sam's answer by Friday." Jarvis writes to Sam, writes
 *              once more if nothing comes, and only comes back when the
 *              answer is in or when it is stuck. Then it asks what now.
 *
 * Both stand on the mail the notch already reads (./mail): a message that
 * arrives is heard of there, and a nudge is one short mail sent from the
 * owner's own Gmail. Nothing here reads the mailbox a second time.
 *
 * What a chase sends is shown before it starts: both mails word for word,
 * who they go to, and when the follow-up goes. One yes is leave for both
 * mails, and for nothing else. The plan: "You give permission once, when you
 * start it." The two mails are fixed, short, and the same for everyone:
 * nothing a model wrote is sent in the owner's name without being seen.
 *
 * The yes burns a fuse before the first mail goes, and Esc takes it back. A
 * chase that comes back from somebody who had taken it does not go on by
 * itself: it asks what now. And a chase that is stuck keeps why, so that its
 * question is asked again after a restart.
 *
 * One watcher per person: a chase takes over from an eye on the same person,
 * and an eye is not kept on someone who is already being chased.
 *
 * Everything is kept in the brain's database, so an eye or a chase outlives
 * a restart. Nothing runs while everything is stopped (the product's pause).
 *
 * The words on the notch are the prototype's (v15: keepEye, viewEyes,
 * untilAsk, startChase, CHASES, viewChasing).
 */
import type { Database } from 'bun:sqlite';
import type { NotchInbox } from './inbox.ts';
import type { MailThread } from './mail/thread.ts';
import type { NotchBlock, NotchPart, NotchWord } from './protocol.ts';
import type { NotchStage } from './stage.ts';

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...new Set(options)], ...more } });
const cap = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** How long a mail may be older than the moment a watch began and still count as an answer to it: Gmail tells when a mail came to the minute. */
export const NOTCH_STANDING_SLACK_MS = 120_000;
/** The least and the most a chase waits between two steps, when nothing says otherwise. */
export const NOTCH_CHASE_WAIT_MIN_MS = 20 * 3_600_000;
export const NOTCH_CHASE_WAIT_MAX_MS = 72 * 3_600_000;
/** How many mails a chase sends before it asks what now. */
export const NOTCH_CHASE_NUDGES = 2;
/** How often the chases are looked at. */
export const NOTCH_STANDING_TICK_MS = 30_000;
/** How long a chase that is over stays in the list. */
export const NOTCH_CHASE_KEPT_MS = 24 * 3_600_000;
/**
 * How long the owner has to take a yes back before a chase's mail goes: the
 * first one, and a follow-up they ask for by hand. README 22: a yes is not
 * acted on at once. The first mail used to go the moment yes was pressed.
 */
export const NOTCH_CHASE_FUSE_MS = 5000;

const NOT_A_NAME = /^(the|a|an|my|me|his|her|their|it|this|that|he|she|they|him|them|someone|anyone|somebody|anybody|answer|reply|signature|you|us|we|up|down|on|off|in|out|back|over|for|to|with|about|from|by|at|of|and|or|if|when|until|after|before|some|all|any|every|each|more|one|what|who|which|where|how|why|ready|started|rid|going|there|here)$/i;
/** Somebody who is meant and not named: "he", "they", "this one". The notch asks who. */
const SOMEBODY = /^(?:he|she|they|it|this|that|him|her|them|someone|somebody|anyone|anybody|this one|that one)$/i;
const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/i;
const LEAD = '(?:(?:ok(?:ay)?|hey|jarvis|please|now|and|then|so)[,\\s]+)*';

/** Who a sentence names: an address as it stands, or a name. Empty when it names nobody. */
function whoOf(raw: string): string {
  const address = raw.match(ADDRESS);
  if (address) return address[0].toLowerCase().replace(/[.,;:!?]+$/, '');
  const name = raw.trim().replace(/[.,;:!?]+$/, '').replace(/'s$/i, '');
  if (!name || name.split(/\s+/).length > 3 || name.split(/\s+/).some((part) => NOT_A_NAME.test(part)) || !/^[\p{L}][\p{L}\s.'-]*$/u.test(name)) return '';
  return name.replace(/\s+/g, ' ');
}

/**
 * "Tell me when Sam replies", "let me know when sam@northwind.example writes
 * back": an eye is asked for. Gives who, or '' when the sentence names
 * nobody ("tell me when he replies" with nothing shown). Null when it is not
 * such a sentence at all.
 */
export function eyeRequest(text: string): { who: string } | null {
  const said = text.trim().replace(/[’`]/g, "'");
  if (!said || said.split(/\s+/).length > 16) return null;
  const match = said.match(new RegExp(`^${LEAD}(?:tell|let|ping|warn|notify) me(?: know)? (?:when|once|as soon as|the moment|if) (.+?) (?:repl(?:y|ies)|answers?|writes?(?: (?:back|to me))*|gets? back(?: to me)?|responds?|e?mails?(?: me)?)(?: back)?(?: to me)?[.!]?$`, 'i'));
  if (!match) return null;
  const who = whoOf(match[1]!);
  // Nobody is named. "When he replies" means somebody, and the notch asks
  // who. "If the supplier responds", "when the server answers" is about
  // something else: an ordinary sentence, and it goes on as one. Taken here
  // it was answered "Who? Say the name." (the hardening audit, 17 November 2026).
  if (!who && !SOMEBODY.test(match[1]!.trim())) return null;
  return { who };
}

/** The days a chase can be asked to be done by, as the notch says them. */
export const NOTCH_CHASE_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** A day as it was said: "friday", "tomorrow", "next week". '' when it is none. */
export function chaseDay(raw: string): string {
  const said = raw.trim().toLowerCase().replace(/[.,;:!?]+$/, '').replace(/^(?:on |this |next (?=mon|tue|wed|thu|fri|sat|sun))/, '');
  if (said === 'tomorrow' || said === 'next week' || said === 'today') return said;
  const day = NOTCH_CHASE_DAYS.find((name) => name.toLowerCase() === said || name.toLowerCase().slice(0, 3) === said);
  return day ?? '';
}

/** When a day that was said is over: six in the evening of it, the next one that comes. */
export function chaseBy(day: string, now: number): number {
  const at = new Date(now);
  const evening = (date: Date): number => { date.setHours(18, 0, 0, 0); return date.getTime(); };
  if (day === 'today') return Math.max(evening(at), now + 4 * 3_600_000);
  if (day === 'tomorrow') { at.setDate(at.getDate() + 1); return evening(at); }
  const index = day === 'next week' ? 0 : NOTCH_CHASE_DAYS.findIndex((name) => name === day);
  // Monday is 1 to a Date, and the first of the days here.
  const want = index < 0 ? 5 : (index + 1) % 7;
  let ahead = (want - at.getDay() + 7) % 7;
  if (ahead === 0) ahead = 7;
  at.setDate(at.getDate() + ahead);
  return evening(at);
}

export interface ChaseAsked {
  /** A name or an address, or '' when the sentence names nobody. */
  who: string;
  thing: 'answer' | 'reply' | 'signature';
  /** What it is about, when that was said: "the contract". */
  about: string;
  /** The day it was said to be done by, or ''. */
  day: string;
}

/** "Get Sam's answer on the contract by Friday", "chase Sam until it is done": a chase is asked for. Null when it is not. */
export function chaseRequest(text: string): ChaseAsked | null {
  const said = text.trim().replace(/[’`]/g, "'");
  if (!said || said.split(/\s+/).length > 22) return null;
  const low = said.toLowerCase();
  if (!new RegExp(`^${LEAD}(?:get|chase)\\b.*\\b(?:answer|reply|signature)\\b`, 'i').test(said)
    && !new RegExp(`^${LEAD}(?:get|chase)\\b.*\\buntil (?:it is|it's|he|she|they) (?:done|answers?|repl(?:y|ies))`, 'i').test(said)) return null;
  // The first of these that names somebody: "get Sam's answer", "a reply from Sam", "chase Sam".
  const named = [
    said.match(/\b(?:get|chase)\s+(\S+@\S+|[\p{L}]+)(?:'s)?\s+(?:answer|reply|signature)/iu),
    said.match(/\bfrom\s+(\S+@\S+|[\p{L}]+)/iu),
    said.match(/\b(?:get|chase)\s+(\S+@\S+|[\p{L}]+)/iu),
  ].map((match) => (match ? whoOf(match[1]!) : '')).find(Boolean) ?? '';
  // Nobody is named. It is still a chase when it is put as one: "get the
  // answer by Friday", "get his reply", "chase him until he answers", and
  // the notch asks whose. Anything else is an ordinary sentence that has
  // "get" and "answer" in it: "get me the answer to question five", "chase
  // up the signature page in my downloads". Those go on as instructions.
  if (!named
    && !new RegExp(`^${LEAD}(?:get|chase)\\s+(?:(?:the|an?|his|her|their|that|this)\\s+)?(?:answer|reply|signature)\\b`, 'i').test(said)
    && !new RegExp(`^${LEAD}(?:get|chase)\\s+(?:him|her|them)\\b`, 'i').test(said)) return null;
  const thing = (low.match(/\b(answer|reply|signature)\b/)?.[1] ?? 'answer') as ChaseAsked['thing'];
  const about = said.match(/\b(?:on|about|for)\s+(.+?)(?:\s+by\s+.+|\s+until\s+.+|[.!?]?$)/i)?.[1]?.trim() ?? '';
  const day = chaseDay(low.match(/\bby\s+(.+?)[.!?]?$/)?.[1] ?? '');
  return { who: named, thing, about: about.length <= 60 ? about : '', day };
}

/** A person in the owner's mailbox, and the newest thread with them, if there is one. */
export interface StandingPerson {
  name: string;
  address: string;
  thread: { id: string; subject: string } | null;
}

/** What the standing things need of the owner's mail (./mail/attach.ts gives it). */
export interface StandingMail {
  /** Tells of every thread the notch reads in full, as it reads it. */
  onRead(listener: (threads: MailThread[]) => void): void;
  /** Who a name or an address is. Null when the mailbox holds nobody of that name. Throws when the mailbox cannot be reached. */
  find(who: string): Promise<StandingPerson | null>;
  /** Sends one short mail: in the thread when there is one, as a new mail when there is none. `also`: more people it goes to, as a new mail. */
  /**
   * On a no, `pressed` says whether Send was pressed. Only `false` means
   * nothing went: anything else is a mail that may have gone, and `since` is
   * the moment to look for it from.
   */
  send(plan: { address: string; also?: string[]; thread: string | null; subject: string; text: string }): Promise<{ ok: true; left?: boolean } | { ok: false; why: string; pressed?: boolean; since?: number; left?: boolean }>;
  /**
   * Whether a mail that may have gone did: its thread, or the Sent folder,
   * shows it since then. Null when that cannot be told. Asked before a mail
   * is sent a second time.
   */
  went(plan: { address: string; thread: string | null; subject: string; text: string }, since: number): Promise<boolean | null>;
  /** Looks at the top of the mailbox now, so that an answer that has just come is heard of before the next step. */
  look(): Promise<void>;
  /** The owner's first name, for signing. '' when it is not known yet. */
  owner(): string;
}

/** `handed`: somebody else took it, with its history (./people-jobs.ts). It is not done and not dropped, and it can come back. */
export type NotchChaseState = 'on' | 'stuck' | 'done' | 'dropped' | 'handed';

/**
 * Why a chase is stuck, kept with it: the question it asks is asked again
 * after a restart, and it has to be the same question.
 *
 *   quiet  its mails went and nothing came.
 *   send   a mail of it could not be sent, and why.
 *   back   whoever had taken it handed it back.
 */
export type NotchChaseStuck = { kind: 'quiet' } | { kind: 'send'; why: string } | { kind: 'back'; from: string };

/**
 * A mail of a chase on which Send was pressed and that nothing confirmed: it
 * may have gone. Kept with the chase and not with why it is stuck, because
 * it has to outlive every state the chase goes through before that mail is
 * sent again: handed to somebody and back, waiting until Monday, held with
 * no connection. It was kept with the stuck reason, and a chase that was
 * handed over and came back sent the mail again without looking.
 * `text` is the mail as it was sent: what is looked for is that, not what
 * the mail would be if it were written now.
 */
export interface NotchChaseUnsure { since: number; text: string }

/** How long a look that did not find the mail holds before the mail is sent: after that it is looked for again. */
export const NOTCH_CHASE_LOOK_FRESH_MS = 60_000;

export interface NotchEye {
  id: string;
  createdAt: number;
  name: string;
  address: string;
}

export interface NotchChase {
  id: string;
  createdAt: number;
  name: string;
  address: string;
  thing: ChaseAsked['thing'];
  about: string;
  /** The day it is to be done by, as it is said: "Friday". */
  day: string;
  byAt: number;
  thread: string | null;
  subject: string;
  state: NotchChaseState;
  /** How many mails have gone. */
  nudges: number;
  /** When the next step is due. */
  nextAt: number;
  steps: { at: number; text: string }[];
  updatedAt: number;
  /** The mail of it that may have gone, until it is known. */
  unsure?: NotchChaseUnsure | null;
  /** Why it is stuck, while it is. */
  stuck?: NotchChaseStuck | null;
}

interface StoredChase { id: string; created_at: number; name: string; address: string; thing: string; about: string; day: string; by_at: number; thread: string | null; subject: string; state: string; nudges: number; next_at: number; steps: string; updated_at: number; stuck_why: string | null; unsure: string | null }

/** Why a chase is stuck, as it was written down. Null when nothing readable was. */
function stuckOf(raw: string | null): NotchChaseStuck | null {
  if (!raw) return null;
  try {
    const read = JSON.parse(raw) as { kind?: unknown; why?: unknown; from?: unknown } | null;
    if (read?.kind === 'quiet') return { kind: 'quiet' };
    if (read?.kind === 'send') return { kind: 'send', why: typeof read.why === 'string' ? read.why : '' };
    if (read?.kind === 'back' && typeof read.from === 'string') return { kind: 'back', from: read.from };
  } catch { /* not readable: not known */ }
  return null;
}

/** The mail that may have gone, as it was written down. Null when nothing readable was. */
function unsureOf(raw: string | null): NotchChaseUnsure | null {
  if (!raw) return null;
  try {
    const read = JSON.parse(raw) as { since?: unknown; text?: unknown } | null;
    if (typeof read?.since === 'number' && Number.isFinite(read.since) && typeof read.text === 'string') return { since: read.since, text: read.text };
  } catch { /* not readable: not known */ }
  return null;
}

/** Where eyes and chases are kept. */
export class NotchStandingStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_eyes (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS notch_chases (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, thing TEXT NOT NULL,
      about TEXT NOT NULL, day TEXT NOT NULL, by_at INTEGER NOT NULL, thread TEXT, subject TEXT NOT NULL, state TEXT NOT NULL,
      nudges INTEGER NOT NULL, next_at INTEGER NOT NULL, steps TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    // Why a chase is stuck (26 November 2026): the question was kept only in memory, so a restart lost it.
    const columns = (db.query('PRAGMA table_info(notch_chases)').all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('stuck_why')) db.run('ALTER TABLE notch_chases ADD COLUMN stuck_why TEXT');
    if (!columns.includes('unsure')) db.run('ALTER TABLE notch_chases ADD COLUMN unsure TEXT');
  }

  eyes(): NotchEye[] {
    return (this.db.query('SELECT id, created_at, name, address FROM notch_eyes ORDER BY created_at').all() as { id: string; created_at: number; name: string; address: string }[])
      .map((row) => ({ id: row.id, createdAt: row.created_at, name: row.name, address: row.address }));
  }

  addEye(eye: NotchEye): void {
    this.db.run('INSERT INTO notch_eyes (id, created_at, name, address) VALUES (?, ?, ?, ?)', [eye.id, eye.createdAt, eye.name, eye.address]);
  }

  /** Takes an eye off. True when it was there: an eye that fires, fires once. */
  dropEye(id: string): boolean {
    return this.db.run('DELETE FROM notch_eyes WHERE id = ?', [id]).changes > 0;
  }

  chases(): NotchChase[] {
    return (this.db.query('SELECT * FROM notch_chases ORDER BY created_at').all() as StoredChase[]).map((row) => {
      let steps: NotchChase['steps'] = [];
      try { const raw = JSON.parse(row.steps) as unknown; if (Array.isArray(raw)) steps = raw as NotchChase['steps']; } catch { steps = []; }
      return {
        id: row.id, createdAt: row.created_at, name: row.name, address: row.address, thing: row.thing as ChaseAsked['thing'], about: row.about, day: row.day,
        byAt: row.by_at, thread: row.thread, subject: row.subject, state: row.state as NotchChaseState, nudges: row.nudges, nextAt: row.next_at, steps, updatedAt: row.updated_at,
        stuck: row.state === 'stuck' ? stuckOf(row.stuck_why) : null,
        unsure: unsureOf(row.unsure),
      };
    });
  }

  chase(id: string): NotchChase | null {
    return this.chases().find((row) => row.id === id) ?? null;
  }

  putChase(chase: NotchChase): void {
    this.db.run(
      `INSERT INTO notch_chases (id, created_at, name, address, thing, about, day, by_at, thread, subject, state, nudges, next_at, steps, updated_at, stuck_why, unsure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET day = excluded.day, by_at = excluded.by_at, thread = excluded.thread, state = excluded.state, nudges = excluded.nudges,
         next_at = excluded.next_at, steps = excluded.steps, updated_at = excluded.updated_at, stuck_why = excluded.stuck_why, unsure = excluded.unsure`,
      [chase.id, chase.createdAt, chase.name, chase.address, chase.thing, chase.about, chase.day, chase.byAt, chase.thread, chase.subject, chase.state, chase.nudges, chase.nextAt,
        JSON.stringify(chase.steps.slice(-40)), chase.updatedAt,
        // Why it is stuck is kept only while it is: a chase that goes on is no longer asking anything.
        chase.state === 'stuck' && chase.stuck ? JSON.stringify(chase.stuck) : null,
        // A mail that may have gone is kept whatever the chase does next, until it is known.
        chase.unsure ? JSON.stringify({ since: chase.unsure.since, text: chase.unsure.text.slice(0, 2000) }) : null],
    );
  }

  /**
   * A chase is stuck, and why. Only from one of the states given, as `move`:
   * one that ended a moment ago does not come back to ask.
   */
  stick(id: string, from: NotchChaseState[], why: NotchChaseStuck, at: number): boolean {
    const marks = from.map(() => '?').join(', ');
    return this.db.run(`UPDATE notch_chases SET state = 'stuck', stuck_why = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`, [JSON.stringify(why), at, id, ...from]).changes > 0;
  }

  /**
   * Moves a chase from one state to another, and only from that one: two
   * things that end a chase at the same moment (an answer, and the owner's
   * Stop) end it once.
   */
  move(id: string, from: NotchChaseState[], to: NotchChaseState, at: number): boolean {
    const marks = from.map(() => '?').join(', ');
    return this.db.run(`UPDATE notch_chases SET state = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`, [to, at, id, ...from]).changes > 0;
  }

  forgetOld(before: number): void {
    this.db.run("DELETE FROM notch_chases WHERE state IN ('done', 'dropped') AND updated_at < ?", [before]);
  }
}

const first = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
const live = (chase: NotchChase): boolean => chase.state === 'on' || chase.state === 'stuck';
export const chaseWhat = (chase: Pick<NotchChase, 'name' | 'thing'>): string => `${first(chase.name)}'s ${chase.thing}`;

/** Whether a mail is from the person a watch is for. */
function fromThem(message: MailThread['messages'][number], them: { address: string }): boolean {
  return message.from.address.toLowerCase() === them.address.toLowerCase();
}

/** What a chase writes down when its second mail went. The time of it is when an automatic reply to it would come. */
const STEP_FOLLOWED_UP = 'No answer yet. Sent a short follow-up.';

/** How soon after a nudge a mail that reads like an automatic reply is taken for one. */
export const NOTCH_AUTO_REPLY_MS = 5 * 60_000;

const AUTO_SUBJECT = /^\s*(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response)|autoreply|out of (?:the )?office|risposta automatica|fuori ufficio|abwesenheit\w*|r[ée]ponse automatique|absence|respuesta autom[aá]tica|fuera de la oficina)\b/i;
const AUTO_TEXT = /\b(?:out of (?:the )?office|automatic reply|auto-?reply|automated (?:reply|response|message)|on (?:annual |parental |sick )?leave|currently (?:away|out)|away from (?:the office|my desk|my e-?mail)|limited access to (?:my )?e-?mail|fuori ufficio|risposta automatica|abwesenheitsnotiz|nicht im b[üu]ro|absent du bureau|r[ée]ponse automatique|fuera de la oficina|respuesta autom[aá]tica)\b/i;

/**
 * Whether a mail reads like the reply a mailbox sends by itself: "I am out of
 * the office until Monday". By how it is headed, or by how it begins.
 */
export function mailAutoReply(text: string, subject = ''): boolean {
  return AUTO_SUBJECT.test(subject) || AUTO_TEXT.test(text.slice(0, 240));
}

/**
 * Whether a mail of theirs is their mailbox answering a nudge by itself: it
 * reads like one, and it came within minutes of the nudge. Such a mail is no
 * answer, and the chase goes on. Both have to hold: a person who writes "I
 * was out of office last week, yes we can sign" has answered, and is not
 * written to again.
 */
export function chaseAutoReply(message: MailThread['messages'][number], subject: string, nudgedAt: number[]): boolean {
  if (!mailAutoReply(message.text, subject)) return false;
  return nudgedAt.some((at) => message.at >= at - NOTCH_STANDING_SLACK_MS && message.at - at <= NOTCH_AUTO_REPLY_MS);
}

/** The mail of theirs that came since a watch began, if a thread holds one. */
function answerIn(thread: MailThread, them: { address: string }, since: number): MailThread['messages'][number] | null {
  return thread.messages.find((message) => fromThem(message, them) && message.at >= since - NOTCH_STANDING_SLACK_MS) ?? null;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('').trimEnd()}…` : flat;
};

/**
 * The two mails a chase sends. Fixed, short and plain: they go out in the
 * owner's name, so they are shown before the chase starts and nothing else
 * is ever sent by it.
 */
export function chaseMail(chase: Pick<NotchChase, 'name' | 'about' | 'day' | 'thread'>, n: number, owner: string): string {
  const hello = `Hi ${first(chase.name)},`;
  const by = chase.day === 'next week' ? 'early next week' : chase.day === 'today' || chase.day === 'tomorrow' ? chase.day : `by ${chase.day}`;
  const about = chase.about ? `on ${chase.about}` : 'on this';
  const body = n === 0
    ? `A quick nudge ${about}: could you get back to me ${by}?`
    : `Following up ${chase.thread ? 'on my note below' : `on my last mail ${chase.about ? `about ${chase.about}` : ''}`.trim()}. Could you let me know ${by}?`;
  return [hello, '', body, '', 'Thanks,', owner || ''].join('\n').trimEnd();
}

export const chaseSubject = (chase: Pick<NotchChase, 'about' | 'subject'>): string => chase.subject || (chase.about ? cap(chase.about) : 'Following up');

export interface NotchStandingDeps {
  inbox: NotchInbox;
  db: Database;
  mail: StandingMail;
  /** Shows or takes away the citron eye: whether anything is being watched for. */
  eye(on: boolean): void;
  /** The eye it kept opens wide: the thing it watched for has happened. */
  fired?(): void;
  /** How long a chase waits between two steps. Given by a test brain; otherwise it is worked out from the day it is to be done by. */
  waitMs?: number;
  paused?: () => boolean;
  /**
   * Whether the machine has no connection now. A follow-up that is due then
   * is held, not tried and called failed: it goes out when the connection is
   * back (`released`).
   */
  offline?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchStanding {
  store: NotchStandingStore;
  /** What the notch does itself with these words: an eye, or a chase. Null when they are an instruction like any other. Has no effect until `run`. */
  route(text: string): { did: string; run(): void } | null;
  /** The rows on Home: what is watched for, and what is chased. */
  rows(): NotchBlock[];
  /** Opens the list a Home row leads to. */
  open(stage: NotchStage, which: 'eyes' | 'chases'): Promise<void>;
  /** The clock: the next step of a chase that is due. Tests call it by hand. */
  tick(): Promise<void>;
  /** How many eyes are kept, and how many chases are under way. */
  counts(): { eyes: number; chases: number };
  /**
   * The connection is back: the follow-ups that were held while it was gone
   * go out now. Comes back with how many went: the prototype's "2 things I
   * was holding went out".
   */
  released(): Promise<number>;
  /**
   * What was started since a moment, for the list of what was done (./today.ts):
   * each eye that is still kept, each chase. An eye, and a chase that is
   * still under way, can be taken back.
   */
  done(since: number): { id: string; at: number; text: string; small: string; undo: boolean }[];
  /** The chases that are under way: the ones that can be handed to somebody. */
  handable(): NotchChase[];
  chase(id: string): NotchChase | null;
  /** Somebody took this chase: it is theirs now, and nothing of it is sent from here. False when it was over already. */
  hand(id: string, to: string): boolean;
  /**
   * A chase that was handed over comes back, with what was done meanwhile.
   * It is not under way again by itself: it is stuck, and asks what now.
   * The yes that started it was for it here, and it has been somewhere else
   * since: whoever had it may have written a moment ago.
   */
  back(id: string, steps: { at: number; text: string }[], from: string): boolean;
  /** Whoever took a chase ended it. */
  closed(id: string, how: 'done' | 'dropped', by: string): boolean;
  /**
   * A chase somebody handed over, as one that could be started here: with
   * its history, not started and not kept. Null when one for that person is
   * under way here already, or everything is stopped.
   */
  drafted(job: { name: string; address: string; thing: ChaseAsked['thing']; about: string; day: string; steps: { at: number; text: string }[]; from: string }): NotchChase | null;
  /** What a chase sends when it starts, as it is shown before it does. */
  blocks(chase: NotchChase): NotchBlock[];
  /**
   * Starts it: a fuse burns on the stage, and then its first mail goes. `ok`
   * is whether it is a chase here now. `took` when the fuse did not burn
   * out: `undo` is the owner's Esc, `lost` is a fuse nobody saw (then there
   * is nothing to say). `unsure`: it is a chase here, and its first mail may
   * have gone or not: it asks what now, and looks before it sends again.
   */
  begin(chase: NotchChase, stage: NotchStage): Promise<{ ok: boolean; took?: 'undo' | 'lost'; unsure?: boolean; parts: NotchPart[]; ms: number; extras: { mood?: 'proud' | 'sorry' | 'careful'; mark?: 'check' | 'fail' } }>;
  /**
   * Takes one of them back, by the id its row has: an eye is closed, a chase
   * is stopped. Comes back with what to say, or null when it is none of
   * these or is over already. A mail that went stays sent, and the words say so.
   */
  undo(id: string): NotchPart[] | null;
  stop(): void;
}

export function attachNotchStanding(deps: NotchStandingDeps): NotchStanding {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = new NotchStandingStore(deps.db);
  let stopped = false;
  let n = 0;
  /** An eye that has fired stays citron until its line has been said. */
  let telling = 0;

  const paintEye = (): void => deps.eye(store.eyes().length + telling > 0);
  paintEye();

  const tell = (parts: NotchPart[], ms = 3000, extras: { mood?: 'look' | 'proud' | 'sorry' | 'careful' | 'confused' | 'happy' | 'worried'; mark?: 'check' | 'fail' } = {}): void => {
    const id = `standing-say-${++n}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, ms, extras); return 'settled'; },
    });
  };

  const STOPPED: NotchPart[] = ['Everything is stopped. Wake me first.'];
  const NO_MAIL: NotchPart[] = ['I cannot reach your mail right now, so I cannot do that.'];

  /** Who was named, in the mailbox. Says why not, and gives null, when they cannot be found. */
  async function person(who: string): Promise<StandingPerson | null> {
    let found: StandingPerson | null;
    try { found = await deps.mail.find(who); } catch (error) {
      log(`[notch] the mailbox could not be asked who someone is: ${error instanceof Error ? error.name : 'error'}`);
      tell(NO_MAIL, 3600, { mood: 'sorry' });
      return null;
    }
    if (!found) {
      tell(['I do not know ', em(`${who}'s`), ' address. Say it instead of the name.'], 4200, { mood: 'confused' });
      return null;
    }
    return found;
  }

  // ── eyes ───────────────────────────────────────────────────────────────

  async function keepEye(who: string): Promise<void> {
    if (deps.paused?.()) { tell(STOPPED, 3200, { mood: 'careful' }); return; }
    if (!who) { tell(['Who? Say the name, or the address.'], 3000, { mood: 'confused' }); return; }
    const them = await person(who);
    if (!them || stopped) return;
    if (store.eyes().some((eye) => eye.address === them.address)) { tell(['I already have an eye on that.'], 2600); return; }
    // One watcher per person.
    if (store.chases().some((chase) => live(chase) && chase.address === them.address)) {
      tell(['I am already chasing that. You will hear from me.'], 3400);
      return;
    }
    store.addEye({ id: `eye-${now().toString(36)}-${++n}`, createdAt: now(), name: them.name, address: them.address });
    paintEye();
    log('[notch] an eye is kept on mail from one person');
    tell(['Eye on ', em(`mail from ${first(them.name)}`), '. I will tell you when ', em(`${first(them.name)} replies`), ', even if it is covered.'], 4000, { mood: 'look', mark: 'check' });
  }

  function eyeFired(eye: NotchEye, message: MailThread['messages'][number], thread: MailThread): void {
    // Fires once: an eye that is already gone says nothing.
    if (!store.dropEye(eye.id)) return;
    telling++;
    paintEye();
    deps.fired?.();
    log('[notch] an eye fired: the mail it was kept for has come');
    const said = oneLine(message.text, 90);
    const parts: NotchPart[] = [em(first(eye.name)), ' replied', ...(said ? [': ', `“${said}”`] : thread.subject ? [': ', em(oneLine(thread.subject, 60))] : ['.'])];
    const id = `eye-fired-${eye.id}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, once: true,
      title: () => parts,
      play: async (stage) => {
        try { await stage.say(parts, 7000, { mood: 'look', src: 'mail' }); } finally {
          // It has been said: the eye goes back to what it was.
          telling = Math.max(0, telling - 1);
          paintEye();
        }
        return 'settled';
      },
    });
  }

  // ── chases ─────────────────────────────────────────────────────────────

  const waitOf = (chase: Pick<NotchChase, 'createdAt' | 'byAt'>): number =>
    deps.waitMs ?? Math.max(NOTCH_CHASE_WAIT_MIN_MS, Math.min(NOTCH_CHASE_WAIT_MAX_MS, (chase.byAt - chase.createdAt) / 3));

  const step = (chase: NotchChase, text: string): void => { chase.steps.push({ at: now(), text }); chase.updatedAt = now(); };

  /** When the follow-up goes, as it is said before the chase starts. */
  function followUpSaid(chase: Pick<NotchChase, 'createdAt' | 'byAt'>): string {
    const wait = waitOf(chase);
    if (wait < 3_600_000) return `in ${Math.max(1, Math.round(wait / 60_000))} minutes`;
    if (wait < 36 * 3_600_000) return 'tomorrow';
    return `in ${Math.round(wait / (24 * 3_600_000))} days`;
  }

  /**
   * What is shown before a chase starts: the mail that goes now, to whom, and
   * the follow-up, both in full. README 116 says both are shown; only the
   * first was, and of the second the sheet said that one would go.
   */
  function chaseBlocks(chase: NotchChase): NotchBlock[] {
    const owner = deps.mail.owner();
    const paper = (n: number): NotchPart[][] => chaseMail(chase, n, owner).split('\n').filter((line) => line.trim()).map((line): NotchPart[] => [line]);
    return [
      { kind: 'paper', to: ['To ', em(chase.address), `  ·  ${chase.thread ? 'Re: ' : ''}${oneLine(chaseSubject(chase), 70)}`], lines: paper(0) },
      { kind: 'note', say: [`This goes now. If there is no answer, this follow-up goes ${followUpSaid(chase)}:`] },
      { kind: 'paper', to: ['To ', em(chase.address), '  ·  the follow-up'], lines: paper(1) },
      { kind: 'note', say: ['After that I ask you. Nothing else is sent.'] },
    ];
  }

  /** The mail a chase sends next, as the mailbox is handed it and as it is looked for afterwards. */
  const nextMail = (chase: NotchChase): { address: string; thread: string | null; subject: string; text: string } =>
    ({ address: chase.address, thread: chase.thread, subject: chaseSubject(chase), text: chaseMail(chase, chase.nudges, deps.mail.owner()) });

  /**
   * Sends the next mail of a chase. `unsure` on a no: Send was pressed, or it
   * is not known that it was not, and nothing confirmed the mail. It may have
   * gone. That is never called "could not be sent", and the moment to look
   * for it from is kept, with the mail as it was sent. `left`: something that
   * was begun in the thread could not be taken away again.
   */
  async function sendNudge(chase: NotchChase): Promise<{ ok: true; left?: boolean } | { ok: false; why: string; unsure?: NotchChaseUnsure; left?: boolean }> {
    const before = now();
    const mail = nextMail(chase);
    try {
      const sent = await deps.mail.send(mail);
      if (sent.ok) return sent;
      const left = sent.left ? { left: true } : {};
      return sent.pressed === false ? { ok: false, why: sent.why, ...left } : { ok: false, why: sent.why, unsure: { since: sent.since ?? before, text: mail.text }, ...left };
    } catch (error) {
      // Not known how far it got: it may have gone.
      return { ok: false, why: error instanceof Error ? error.message.slice(0, 160) : 'it could not be sent', unsure: { since: before, text: mail.text } };
    }
  }

  /** What a chase writes down when a draft it began in the thread could not be taken away: the owner finds it there. */
  const STEP_DRAFT_LEFT = 'A draft may be left in the thread: I could not take it away.';

  /** When each chase's mail was last looked for and not found. */
  const lookedAt = new Map<string, number>();

  /**
   * Whether the mail of a chase that may have gone did: asked of the mailbox,
   * for the mail as it was sent. Null when the mailbox cannot say. Asked
   * before that mail is sent again by any way: a yes on the question, the
   * clock after "wait until Monday", a chase that came back from somebody.
   */
  async function wentAlready(chase: NotchChase): Promise<boolean | null> {
    const unsure = chase.unsure;
    if (!unsure) return false;
    let there: boolean | null;
    try { there = await deps.mail.went({ address: chase.address, thread: chase.thread, subject: chaseSubject(chase), text: unsure.text }, unsure.since); } catch { there = null; }
    if (there === false) lookedAt.set(chase.id, now()); else lookedAt.delete(chase.id);
    return there;
  }

  /** The mail that may have gone had gone: it is counted as sent, and the chase goes on. */
  function counted(chase: NotchChase): void {
    const opening = chase.nudges === 0;
    chase.state = 'on'; chase.nudges++; chase.nextAt = now() + waitOf(chase); chase.unsure = null;
    step(chase, opening ? `Nudged ${first(chase.name)} by email.` : STEP_FOLLOWED_UP);
    store.putChase(chase);
    lookedAt.delete(chase.id);
    log('[notch] a mail that may have gone had gone: it is counted, and not sent again');
  }

  async function askChase(asked: ChaseAsked): Promise<void> {
    if (deps.paused?.()) { tell(STOPPED, 3200, { mood: 'careful' }); return; }
    // It never fills in someone who was not named.
    if (!asked.who) { tell(['Whose ', asked.thing, '? Say the name.'], 3000, { mood: 'confused' }); return; }
    const them = await person(asked.who);
    if (!them || stopped) return;
    if (store.chases().some((chase) => live(chase) && chase.address === them.address)) { tell(['I am already on that.'], 2400); return; }
    const day = asked.day || 'Friday';
    const draft: NotchChase = {
      id: `chase-${now().toString(36)}-${++n}`, createdAt: now(), name: them.name, address: them.address, thing: asked.thing, about: asked.about, day,
      byAt: chaseBy(day, now()), thread: them.thread?.id ?? null, subject: them.thread?.subject ?? '', state: 'on', nudges: 0, nextAt: 0, steps: [], updatedAt: now(),
    };
    const id = `chase-ask-${draft.id}`;
    const line = (): NotchPart[] => [
      'I will get ', em(chaseWhat(draft)), ' by ', word('by', draft.day, [draft.day, 'Friday', 'tomorrow', 'next week'], { label: 'By', read: 'day' }),
      ', and only come back if I am stuck. Go?',
    ];
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
      title: line,
      play: async (stage) => {
        let lineId = '';
        const show = (): void => {
          lineId = stage.id();
          stage.put({ id: lineId, kind: 'sheet', say: line(), blocks: chaseBlocks(draft), yes: 'go', mood: 'look' });
        };
        show();
        for (;;) {
          const answer = await stage.answer(lineId, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            const picked = answer.word === 'by' ? chaseDay(answer.value ?? '') : '';
            if (picked) { draft.day = picked; draft.byAt = chaseBy(picked, now()); }
            stage.surface.update(lineId, { say: line(), blocks: chaseBlocks(draft) });
            continue;
          }
          if (answer.act !== 'yes') return 'settled';
          const said = await beginChase(draft, stage);
          // A fuse nobody saw burn out decides nothing: the question is still there to be asked.
          if (said.took === 'lost') return 'waits';
          // Esc in the fuse takes back the yes, and nothing else: the sheet is up again.
          if (said.took === 'undo') { show(); continue; }
          await stage.say(said.parts, said.ms, said.extras);
          return 'settled';
        }
      },
    });
  }

  type Started = { parts: NotchPart[]; ms: number; extras: { mood?: 'proud' | 'sorry' | 'careful'; mark?: 'check' | 'fail' }; unsure?: boolean };

  /** Why a chase cannot be started now, as it is said. Null when it can. */
  const cannotStart = (chase: NotchChase): Started | null => {
    if (deps.paused?.()) return { parts: STOPPED, ms: 3200, extras: { mood: 'careful' } };
    if (store.chases().some((other) => live(other) && other.address === chase.address)) return { parts: ['I am already on that.'], ms: 2400, extras: {} };
    return null;
  };

  /**
   * The yes was given: a fuse burns, and the first mail goes when it has
   * burnt out with somebody there to see it (README 22). It went the moment
   * yes was pressed, with no way to take it back.
   */
  async function beginChase(chase: NotchChase, stage: NotchStage): Promise<Started & { ok: boolean; took?: 'undo' | 'lost' }> {
    // What would refuse it is said now, not after a fuse that could send nothing.
    const refused = cannotStart(chase);
    if (refused) return { ...refused, ok: false };
    const went = await stage.fuse(['Sending ', em(first(chase.name)), ' the first mail…'], NOTCH_CHASE_FUSE_MS, { src: 'mail' });
    if (went === 'undo') return { ok: false, took: 'undo', parts: ['Taken back. Nothing was sent.'], ms: 2600, extras: {} };
    if (went === 'lost') return { ok: false, took: 'lost', parts: [], ms: 0, extras: {} };
    const said = await startChase(chase);
    return { ...said, ok: store.chase(chase.id) !== null };
  }

  async function startChase(chase: NotchChase): Promise<Started> {
    const refused = cannotStart(chase);
    if (refused) return refused;
    chase.createdAt = now();
    const sent = await sendNudge(chase);
    if (!sent.ok && sent.unsure) {
      // Send was pressed and nothing confirmed it. It was said "I could not send it. Nothing was
      // started", and the same words then went a second time. The chase is kept, stuck on that
      // mail: it stands in the way of a second chase of that person, and before the mail is sent
      // again the mailbox is asked whether it went.
      chase.state = 'stuck';
      chase.stuck = { kind: 'send', why: sent.why };
      chase.unsure = sent.unsure;
      step(chase, 'The first mail may have gone: Gmail did not confirm it.');
      if (sent.left) step(chase, STEP_DRAFT_LEFT);
      store.putChase(chase);
      for (const eye of store.eyes()) if (eye.address === chase.address) store.dropEye(eye.id);
      paintEye();
      log('[notch] a chase is kept with its first mail unconfirmed: it may have gone');
      raise(chase);
      return { parts: ['The first mail to ', em(first(chase.name)), ' may have gone: Gmail did not confirm it. I ask you what now.'], ms: 5200, extras: { mood: 'careful' }, unsure: true };
    }
    if (!sent.ok) {
      log('[notch] a chase was not started: its first mail could not be sent');
      return { parts: ['I could not send it: ', oneLine(sent.why, 80), '. Nothing was started.'], ms: 5200, extras: { mood: 'sorry', mark: 'fail' } };
    }
    chase.nudges = 1;
    chase.nextAt = now() + waitOf(chase);
    step(chase, `Nudged ${first(chase.name)} by email.`);
    if (sent.left) step(chase, STEP_DRAFT_LEFT);
    store.putChase(chase);
    // The chase takes over from the eye: one watcher per person.
    for (const eye of store.eyes()) if (eye.address === chase.address) store.dropEye(eye.id);
    paintEye();
    log('[notch] a chase was started: its first mail went');
    return { parts: ['On it. I will come back when ', em(chaseWhat(chase)), ' is in, or if I am stuck.'], ms: 4400, extras: { mood: 'proud', mark: 'check' } };
  }

  function chaseDone(chase: NotchChase): void {
    if (!store.move(chase.id, ['on', 'stuck'], 'done', now())) return;
    const fresh = store.chase(chase.id)!;
    step(fresh, 'Done.');
    store.putChase(fresh);
    deps.inbox.remove(`chase-stuck-${chase.id}`);
    log('[notch] a chase is done: the answer came');
    const how = chase.thing === 'reply' ? ' replied.' : chase.thing === 'signature' ? ' answered. Whether it is signed is yours to see.' : ' answered.';
    const parts: NotchPart[] = ['Done. ', em(first(chase.name)), how];
    const id = `chase-done-${chase.id}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, once: true,
      title: () => parts,
      play: async (stage) => { stage.surface.act({ kick: 220 }); await stage.say(parts, 4600, { mood: 'proud', mark: 'check', src: 'mail' }); return 'settled'; },
    });
  }

  /**
   * Questions that were put in the inbox while the notch was busy and have
   * not been shown yet. A question that arrives then only joins the count,
   * and one about a mail that may have gone is raised in the middle of the
   * line that says so. The clock puts it up once the notch is free.
   */
  const unshown = new Set<string>();

  /** It only comes back when it needs the owner: what now? */
  function chaseStuck(chase: NotchChase, why: NotchChaseStuck): void {
    if (!store.stick(chase.id, ['on'], why, now())) return;
    log('[notch] a chase is stuck and asks what now');
    raise(store.chase(chase.id)!);
  }

  /**
   * The question of a chase that is stuck, put in the inbox. Asked from what
   * is kept with the chase, so that it can be asked again: the question lived
   * only in memory, and after a restart a stuck chase asked nothing, could
   * not be answered, and stood in the way of a new one for that person.
   */
  function raise(chase: NotchChase): void {
    const id = `chase-stuck-${chase.id}`;
    unshown.add(chase.id);
    const name = first(chase.name);
    // A chase stuck before the reason was kept: with a mail still to send it was a send that failed, otherwise silence.
    const why: NotchChaseStuck = chase.stuck ?? (chase.nudges < NOTCH_CHASE_NUDGES ? { kind: 'send', why: '' } : { kind: 'quiet' });
    /** Whether a mail of it has still not gone, and which. */
    const owed = chase.nudges < NOTCH_CHASE_NUDGES;
    const which = chase.nudges === 0 ? 'the first mail' : 'the follow-up';
    // Whatever the chase is stuck on: a mail of it that may have gone is looked for before it is sent again.
    const unsure = chase.unsure ?? null;
    /** Whether one of the answers sends a mail: then the mail is on the sheet, word for word. */
    const sends = owed && (why.kind === 'send' || why.kind === 'back');
    const head: NotchPart[] = why.kind === 'send'
      ? unsure
        ? [`${cap(which)} to `, em(name), ' may have gone: Gmail did not confirm it. What now?']
        : ['I could not send ', em(name), ` ${which}`, ...(why.why ? [': ', oneLine(why.why, 70)] : []), '. What now?']
      : why.kind === 'back'
        ? [em(why.from), ' handed ', em(chaseWhat(chase)), ' back. What now?']
        : [`${chase.nudges} ${chase.nudges === 1 ? 'nudge' : 'nudges'} and nothing from `, em(name), '. What now?'];
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true,
      title: () => head,
      check: () => store.chase(chase.id)?.state === 'stuck',
      play: async (stage) => {
        unshown.delete(chase.id);
        stage.surface.act({ kick: 200 });
        let picked: 'send' | 'monday' | 'call' | 'drop';
        if (sends) {
          // What a yes would send is shown before the yes (README 116): the question used to be a
          // line of choices, and "Try again" sent a mail the owner had last seen days before.
          const mail = nextMail(chase);
          const sheet = stage.id();
          stage.put({
            id: sheet, kind: 'sheet', say: head, mood: 'worried', stay: true, no: 'not now', yes: why.kind === 'send' ? 'try again' : 'send it',
            blocks: [
              { kind: 'paper', to: ['To ', em(chase.address), `  ·  ${which}`], lines: mail.text.split('\n').filter((line) => line.trim()).map((line): NotchPart[] => [line]) },
              { kind: 'note', say: [unsure ? 'Before it is sent again I look in your mail whether it went.' : 'This is what goes, after a moment in which you can take it back.'] },
              { kind: 'buttons', buttons: [...(why.kind === 'back' ? [{ id: 'monday', label: 'Wait until Monday' }] : []), { id: 'drop', label: 'Let it go' }] },
            ],
          });
          const answer = await stage.answer(sheet, ['yes', 'no', 'button']);
          if (answer.act === 'yes') picked = 'send';
          else if (answer.act === 'button' && answer.button === 'monday') picked = 'monday';
          else if (answer.act === 'button' && answer.button === 'drop') picked = 'drop';
          else return 'waits';
        } else {
          const options = [`Call ${name}`, 'Wait until Monday', 'Let it go'];
          const pick = await stage.choose(head, options, { fold: 0, mood: 'worried' });
          if (pick.act !== 'pick' || !pick.option) return 'waits';
          picked = pick.option === 'Wait until Monday' ? 'monday' : pick.option.startsWith('Call ') ? 'call' : 'drop';
        }
        const fresh = store.chase(chase.id);
        if (!fresh || fresh.state !== 'stuck') { await stage.say(['That one is already closed.'], 2400); return 'settled'; }
        if (picked === 'monday') {
          fresh.day = 'Monday'; fresh.byAt = chaseBy('Monday', now()); fresh.state = 'on'; fresh.nextAt = fresh.byAt - 9 * 3_600_000;
          step(fresh, 'You said: wait until Monday.');
          store.putChase(fresh);
          // With the follow-up still to go, waiting is leave for it to go then: that is said, not left to be found out.
          await stage.say(['Waiting until ', em('Monday'), owed ? `. If nothing has come by then, ${which} goes${unsure ? ', unless I find that it went' : ''}.` : '. Still on it.'], owed ? 3600 : 2800);
          return 'settled';
        }
        if (picked === 'send') {
          // Nothing is sent while everything is stopped, and no fuse burns for a mail that cannot go.
          if (deps.paused?.()) { await stage.say(STOPPED, 3200, { mood: 'careful' }); return 'waits'; }
          if (unsure) {
            // It may have gone the first time. The mailbox is asked before anything is sent again:
            // a mail that is there is counted, and is not sent twice.
            const looking = stage.id();
            stage.put({ id: looking, kind: 'work', say: ['Looking whether it went…'], steps: 0, done: 0, src: 'mail' });
            const there = await wentAlready(fresh);
            const now_ = store.chase(chase.id);
            if (!now_ || now_.state !== 'stuck') { await stage.say(['That one is already closed.'], 2400); return 'settled'; }
            if (there === true) {
              counted(now_);
              await stage.say(['It had gone: it is in your mail. I did not send it again. Still on it.'], 4200, { mark: 'check' });
              return 'settled';
            }
            if (there === null) {
              await stage.say(['I cannot see whether it went, so I am not sending it again. Look in your mail, or ask me again in a moment.'], 5200, { mood: 'careful' });
              return 'waits';
            }
          }
          // A yes to a mail: a fuse burns first, and Esc takes it back (README 22). "Try again" had none.
          const went = await stage.fuse(['Sending ', em(name), ` ${which}…`], NOTCH_CHASE_FUSE_MS, { src: 'mail' });
          if (went === 'lost') return 'waits';
          if (went === 'undo') { await stage.say(['Taken back. Nothing was sent.'], 2600); return 'waits'; }
          const still = store.chase(chase.id);
          if (!still || still.state !== 'stuck') { await stage.say(['That one is already closed.'], 2400); return 'settled'; }
          still.state = 'on'; still.nextAt = now();
          step(still, why.kind === 'send' ? 'You said: try again.' : `You said: send ${which}.`);
          store.putChase(still);
          // It goes by the same step as any mail of a chase: the mailbox is looked at first, and one that cannot go asks again.
          void tick();
          await stage.say(['Sending it. I will come back if it does not go.'], 2800);
          return 'settled';
        }
        if (picked === 'call') {
          fresh.state = 'done';
          step(fresh, 'Handed back to you: a call.');
          store.putChase(fresh);
          await stage.say(['The call is yours. I have stopped writing to ', em(name), '.'], 3600, { mark: 'check' });
          return 'settled';
        }
        fresh.state = 'dropped';
        step(fresh, 'You let it go.');
        store.putChase(fresh);
        await stage.say(unsure ? ['Dropped. I will not chase it. The mail that may have gone is not taken back.'] : ['Dropped. I will not chase it.'], unsure ? 3800 : 2600);
        return 'settled';
      },
    });
  }

  /** A mail has been read: an eye may fire, a chase may be done. */
  deps.mail.onRead((threads) => {
    if (stopped) return;
    for (const thread of threads) {
      for (const eye of store.eyes()) {
        const answer = answerIn(thread, eye, eye.createdAt);
        if (answer) eyeFired(eye, answer, thread);
      }
      for (const chase of store.chases()) {
        if (!live(chase)) continue;
        // Their mailbox answering the nudge by itself is not their answer: the
        // chase goes on. It used to end on it: "Done. Sam answered."
        const nudged = chase.steps.filter((entry) => entry.text.startsWith('Nudged') || entry.text === STEP_FOLLOWED_UP).map((entry) => entry.at);
        const answer = thread.messages.find((message) => fromThem(message, chase) && message.at >= chase.createdAt - NOTCH_STANDING_SLACK_MS
          && !chaseAutoReply(message, thread.subject, nudged));
        if (answer) chaseDone(chase);
      }
    }
  });

  let ticking = false;
  /** Chases whose follow-up came due while there was no connection. */
  const heldOffline = new Set<string>();
  async function tick(): Promise<void> {
    if (stopped) return;
    if (unshown.size > 0 && deps.inbox.showing() === null) {
      for (const id of [...unshown]) {
        const chase = store.chase(id);
        if (chase?.state === 'stuck') raise(chase); else unshown.delete(id);
      }
    }
    if (ticking || deps.paused?.()) return;
    ticking = true;
    try {
      store.forgetOld(now() - NOTCH_CHASE_KEPT_MS);
      const due = store.chases().filter((chase) => chase.state === 'on' && now() >= chase.nextAt);
      if (due.length === 0) return;
      // No connection: what is due is held. Tried now, it would only be written down as failed, and the
      // chase would ask what to do about a mail that could not have gone.
      if (deps.offline?.()) {
        for (const chase of due) heldOffline.add(chase.id);
        return;
      }
      // The outcome is checked before every step: nothing is sent to someone who has just answered.
      try { await deps.mail.look(); } catch { /* without a look the step waits for the next one */ return; }
      for (const was of due) {
        if (stopped || deps.paused?.()) return;
        const chase = store.chase(was.id);
        if (!chase || chase.state !== 'on') continue;
        if (chase.nudges >= NOTCH_CHASE_NUDGES) { chaseStuck(chase, { kind: 'quiet' }); continue; }
        // The first mail, when it is sent again after one that did not go: otherwise the follow-up.
        const opening = chase.nudges === 0;
        // This mail may have gone already. Whichever way it came to be due again (a yes, the wait
        // until Monday, a chase handed back, a connection that was gone), it is looked for right
        // before it is sent, unless it was looked for a moment ago.
        if (chase.unsure && now() - (lookedAt.get(chase.id) ?? -Infinity) > NOTCH_CHASE_LOOK_FRESH_MS) {
          const there = await wentAlready(chase);
          const looked = store.chase(chase.id);
          if (!looked || looked.state !== 'on') continue;
          if (there === true) { counted(looked); continue; }
          if (there === null) {
            step(looked, `I could not see whether ${opening ? 'the first mail' : 'the follow-up'} went, so it was not sent again.`);
            store.putChase(looked);
            chaseStuck(looked, { kind: 'send', why: 'I cannot see whether it went' });
            continue;
          }
        }
        const sent = await sendNudge(chase);
        const fresh = store.chase(chase.id);
        // Stopped, or answered, while the mail was on its way: nothing more is written down for it.
        if (!fresh || fresh.state !== 'on') continue;
        if (!sent.ok) {
          // Pressed and not confirmed is "may have gone", never "could not be sent": the owner sent
          // by hand what had gone, or tried again and it went twice.
          step(fresh, sent.unsure
            ? `${opening ? 'The first mail' : 'The follow-up'} may have gone: Gmail did not confirm it.`
            : `${opening ? 'The first mail' : 'The follow-up'} could not be sent.`);
          if (sent.left) step(fresh, STEP_DRAFT_LEFT);
          // Two tries that may both have gone are looked for from the earlier one.
          if (sent.unsure) { fresh.unsure = { since: Math.min(sent.unsure.since, fresh.unsure?.since ?? Infinity), text: sent.unsure.text }; lookedAt.delete(fresh.id); }
          store.putChase(fresh);
          log(sent.unsure ? '[notch] a mail of a chase may have gone: nothing confirmed it' : '[notch] a chase could not send its follow-up');
          chaseStuck(fresh, { kind: 'send', why: sent.why });
          continue;
        }
        fresh.nudges++;
        fresh.nextAt = now() + waitOf(fresh);
        fresh.unsure = null;
        lookedAt.delete(fresh.id);
        step(fresh, opening ? `Nudged ${first(fresh.name)} by email.` : STEP_FOLLOWED_UP);
        if (sent.left) step(fresh, STEP_DRAFT_LEFT);
        store.putChase(fresh);
        log('[notch] a chase sent its follow-up');
      }
    } finally {
      ticking = false;
    }
  }

  const clock = (at: number): string => {
    const date = new Date(at);
    const sameDay = new Date(now()).toDateString() === date.toDateString();
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return sameDay ? time : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]} ${time}`;
  };

  async function openEyes(stage: NotchStage): Promise<void> {
    for (;;) {
      const eyes = store.eyes();
      const blocks: NotchBlock[] = eyes.length
        ? eyes.map((eye): NotchBlock => ({ kind: 'row', id: eye.id, lead: 'Mail', say: [`Mail from ${first(eye.name)}, until ${first(eye.name)} replies.`], buttons: [{ id: 'stop', label: 'Stop', quiet: true }] }))
        : [{ kind: 'note', say: ['Nothing right now. Say "tell me when Sam replies", and I will.'] }];
      const answer = await stage.sheet(['What I keep an eye on'], blocks);
      if (answer.act !== 'button' || answer.button !== 'stop' || !answer.row) return;
      store.dropEye(answer.row);
      paintEye();
    }
  }

  async function openChases(stage: NotchStage): Promise<void> {
    for (;;) {
      const chases = store.chases().sort((a, b) => Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt);
      const blocks: NotchBlock[] = [];
      for (const chase of chases) {
        const tail = live(chase) ? `, by ${chase.day}.` : chase.state === 'done' ? '. Done.' : chase.state === 'handed' ? '. With somebody else now.' : '. Dropped.';
        blocks.push({ kind: 'row', id: chase.id, say: [`${cap(chaseWhat(chase))}${tail}`], ...(live(chase) ? { buttons: [{ id: 'stop', label: 'Stop', quiet: true }] } : {}) });
        for (const done of chase.steps) blocks.push({ kind: 'row', lead: clock(done.at), say: [done.text] });
        if (chase.steps.length === 0) blocks.push({ kind: 'row', lead: clock(chase.createdAt), say: ['Just started.'] });
      }
      if (chases.length === 0) blocks.push({ kind: 'note', say: ['Nothing. Say what you want done, and by when.'] });
      const answer = await stage.sheet(['What I am chasing'], blocks);
      if (answer.act !== 'button' || answer.button !== 'stop' || !answer.row) return;
      // No more nudges, ever: a chase that was stopped is never taken up again.
      if (store.move(answer.row, ['on', 'stuck'], 'dropped', now())) {
        const fresh = store.chase(answer.row)!;
        step(fresh, 'You stopped it.');
        store.putChase(fresh);
        deps.inbox.remove(`chase-stuck-${answer.row}`);
        log('[notch] a chase was stopped by the owner');
      }
    }
  }

  // What was stuck when the brain stopped is still stuck, and asks again.
  const stuckBefore = store.chases().filter((chase) => chase.state === 'stuck');
  for (const chase of stuckBefore) raise(chase);
  if (stuckBefore.length) log(`[notch] ${stuckBefore.length} stuck chase(s) ask again after a restart`);

  return {
    store,
    route(text) {
      if (stopped) return null;
      const eye = eyeRequest(text);
      if (eye) return { did: 'Keep an eye on mail from one person.', run: () => { void keepEye(eye.who); } };
      const chase = chaseRequest(text);
      if (chase) return { did: 'Chase one person for an answer.', run: () => { void askChase(chase); } };
      return null;
    },
    rows() {
      const rows: NotchBlock[] = [];
      const chases = store.chases();
      const on = chases.filter(live).length;
      if (on) rows.push({ kind: 'row', id: 'chases', go: true, say: ['I am chasing ', em(`${on} ${on === 1 ? 'thing' : 'things'}`), ' until it is done.'] });
      else if (chases.length) rows.push({ kind: 'row', id: 'chases', go: true, say: ['Nothing left to chase. See what I did.'] });
      const eyes = store.eyes().length;
      if (eyes) rows.push({ kind: 'row', id: 'eyes', go: true, say: ['I keep an eye on ', em(`${eyes} ${eyes === 1 ? 'thing' : 'things'}`), '.'] });
      return rows;
    },
    open: (stage, which) => (which === 'eyes' ? openEyes(stage) : openChases(stage)),
    tick,
    counts: () => ({ eyes: store.eyes().length, chases: store.chases().filter(live).length }),
    async released() {
      const waited = [...heldOffline];
      heldOffline.clear();
      if (waited.length === 0) return 0;
      const before = new Map(waited.map((id) => [id, store.chase(id)?.nudges ?? 0]));
      await tick();
      const went = waited.filter((id) => (store.chase(id)?.nudges ?? 0) > (before.get(id) ?? 0)).length;
      log(`[notch] ${went} of ${waited.length} follow-up(s) held without a connection went out`);
      return went;
    },
    done(since) {
      const stands: Record<NotchChaseState, string> = { on: 'on it', stuck: 'stuck', done: 'done', dropped: 'stopped', handed: 'handed over' };
      return [
        ...store.eyes().filter((eye) => eye.createdAt >= since)
          .map((eye) => ({ id: `eye:${eye.id}`, at: eye.createdAt, text: `Watching for ${first(eye.name)}'s reply`, small: 'watching', undo: true })),
        ...store.chases().filter((chase) => chase.createdAt >= since)
          .map((chase) => ({ id: `chase:${chase.id}`, at: chase.createdAt, text: `Getting ${chaseWhat(chase)} by ${chase.day}`, small: stands[chase.state] ?? 'done', undo: live(chase) })),
      ];
    },
    undo(id) {
      if (id.startsWith('eye:')) {
        const eye = store.eyes().find((one) => `eye:${one.id}` === id);
        if (!eye || !store.dropEye(eye.id)) return null;
        paintEye();
        log('[notch] an eye was taken back from the list of what was done');
        return ['No longer watching for ', em(`${first(eye.name)}'s reply`), '.'];
      }
      if (id.startsWith('chase:')) {
        // Moved from under way to stopped, and only from there: a chase that ended a moment ago is not stopped again.
        const was = store.chase(id.slice('chase:'.length));
        const mayHaveGone = !!was?.unsure;
        if (!store.move(id.slice('chase:'.length), ['on', 'stuck'], 'dropped', now())) return null;
        const chase = store.chase(id.slice('chase:'.length))!;
        step(chase, 'You took it back.');
        store.putChase(chase);
        // What it was about to ask is asked no more.
        deps.inbox.remove(`chase-stuck-${chase.id}`);
        paintEye();
        log('[notch] a chase was taken back from the list of what was done');
        // The first mail went when it started: that is said, not hidden behind the word undo.
        // And a mail that may have gone is not said to be "nothing sent".
        return chase.nudges > 0 || mayHaveGone
          ? ['Stopped. I will not write to ', em(first(chase.name)), ' again. ', !mayHaveGone ? 'What I sent stays sent.' : chase.nudges > 0 ? 'What I sent stays sent, and the follow-up that may have gone is not taken back.' : 'The mail that may have gone is not taken back.']
          : ['Stopped. Nothing was sent to ', em(first(chase.name)), '.'];
      }
      return null;
    },
    // --- a chase that changes hands (./people-jobs.ts) ---
    handable: () => store.chases().filter(live),
    chase: (id) => store.chase(id),
    hand(id, to) {
      // Only one that is under way. From then on nothing of it is sent from here.
      if (!store.move(id, ['on', 'stuck'], 'handed', now())) return false;
      const fresh = store.chase(id)!;
      step(fresh, `Handed to ${to}. ${to} took it.`);
      store.putChase(fresh);
      deps.inbox.remove(`chase-stuck-${id}`);
      log('[notch] a chase was handed to somebody else');
      return true;
    },
    back(id, steps, from) {
      // Back, and stuck: it asks what now. It used to be under way again at once, and a wait later
      // its follow-up went from the owner's mailbox with nobody having said so since it left.
      if (!store.stick(id, ['handed'], { kind: 'back', from }, now())) return false;
      const fresh = store.chase(id)!;
      for (const one of steps) fresh.steps.push({ at: one.at, text: `${from}: ${one.text}` });
      step(fresh, `Back with you, with what ${from} did.`);
      store.putChase(fresh);
      log('[notch] a chase that was handed over is back, and asks what now');
      raise(fresh);
      return true;
    },
    closed(id, how, by) {
      // Whoever took it ended it: it is over here too, and says by whom.
      if (!store.move(id, ['handed'], how === 'done' ? 'done' : 'dropped', now())) return false;
      const fresh = store.chase(id)!;
      step(fresh, how === 'done' ? `Done. ${by} closed it.` : `${by} let it go.`);
      store.putChase(fresh);
      return true;
    },
    drafted(job) {
      if (deps.paused?.() || stopped) return null;
      // One watcher per person, as for a chase that is said.
      if (store.chases().some((chase) => live(chase) && chase.address === job.address)) return null;
      const day = chaseDay(job.day) || 'Friday';
      return {
        id: `chase-${now().toString(36)}-${++n}`, createdAt: now(), name: job.name, address: job.address, thing: job.thing, about: job.about, day,
        byAt: chaseBy(day, now()), thread: null, subject: '', state: 'on', nudges: 0, nextAt: 0,
        // What was done before it came here, told as the other person's, and then what happened here.
        steps: [...job.steps.map((one) => ({ at: one.at, text: `${job.from}: ${one.text}` })), { at: now(), text: `Taken from ${job.from}.` }], updatedAt: now(),
      };
    },
    blocks: (chase) => chaseBlocks(chase),
    begin: (chase, stage) => beginChase(chase, stage),
    stop() { stopped = true; },
  };
}
