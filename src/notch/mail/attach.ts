/**
 * The mail layer, put together: the store, the watcher on its clock, the
 * mailbox behind it, and the line on the notch.
 *
 * Every way to something goes through ../ways.ts: a connection first, when
 * one exists, and the notch's own tab in the signed-in browser when not. Today
 * no connection reads mail thread by thread, so the mailbox is the tab; the
 * calendar has both ways.
 *
 * The clock: a glance at the top of the list every minute (a new mail, or the
 * owner's own answer, is there), the last two days every five, and the whole
 * month every six hours. When the brain starts, the last two days come first,
 * so that a reply is ready within a minute, and the month right after. A look
 * through the month that was cut short (the browser was closed under it) is
 * taken again at the next minute, until one has gone through. One look at a
 * time, and none while everything is stopped.
 */
import type { Database } from 'bun:sqlite';
import type { NotchInbox } from '../inbox.ts';
import type { StandingMail } from '../standing.ts';
import { firstWay } from '../ways.ts';
import type { MailBrowser } from './browser.ts';
import { browserCalendar } from './calendar.ts';
import { browserDriveSearch } from './drive.ts';
import { browserMailbox, type Mailbox, type MailStep } from './mailbox.ts';
import { attachNotchMail, type NotchMail } from './notch.ts';
import { googlePage } from './page.ts';
import type { MailCalendarEvent, MailThink } from './proposer.ts';
import { MailStore, type MailProposalRow } from './store.ts';
import { MailTabTurn } from './tab.ts';
import { mailFirstName, type MailPerson, type MailThread } from './thread.ts';
import { MailWatch, type MailLookKind, type MailReader } from './watch.ts';

export const MAIL_GLANCE_MS = 60 * 1000;
export const MAIL_RECENT_MS = 5 * 60 * 1000;
export const MAIL_SWEEP_MS = 6 * 60 * 60 * 1000;
/** How long after the brain starts the first look is taken: the desktop app has to have connected. */
export const MAIL_FIRST_LOOK_MS = 20 * 1000;
/** How long a reading of the calendar is good for. */
const MAIL_CALENDAR_KEPT_MS = 10 * 60 * 1000;
const GMAIL = 'mail.google.com';

export interface NotchMailLayerDeps {
  db: Database;
  /** The notch's own tab in a connected desktop app, or null when no desktop app has one. */
  tab(): MailBrowser | null;
  /** The mailbox through a connection, when one that reads threads exists. */
  connection?(): Promise<MailReader | null>;
  /** The calendar through a connection: null when none is connected. */
  connectedCalendar?(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  /** One call to the brain's model, counted as the mail layer's. */
  think: MailThink;
  paused?(): boolean;
  /** Whether a model is set up: without one nothing is looked at. */
  modelReady?(): boolean;
  zone?: string;
  /** A shorter wait than the rule's four hours, on a test brain. */
  waitMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Given by tests: no clock is started, and looks are asked for by hand. */
  noClock?: boolean;
}

export interface NotchMailLayer {
  store: MailStore;
  watch: MailWatch;
  mail: NotchMail;
  /** The site in front has changed: the one the person has come to, or "" when they have left for no site. */
  arrived(site: string): void;
  /** What was sent today, for the list of what was done. */
  sentSince(since: number): { at: number; text: string; small: string }[];
  /** One look now, of a kind. */
  look(kind: MailLookKind): ReturnType<MailWatch['look']>;
  /** Whether the month still has to be gone through. */
  monthDue(): boolean;
  /** Whether the mailbox can be read now, by any way: Jarvis's own browser is signed in, or a connection reads it. Nothing is read. */
  reached(): Promise<boolean>;
  /** The owner's calendar between two moments, by whichever way reaches it, or null. */
  calendar(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  /** What an eye and a chase need of the mailbox (../standing.ts). */
  standing: StandingMail;
  stop(): void;
}

const tokens = (row: MailProposalRow): string => `${(row.tokensIn + row.tokensOut).toLocaleString('en-GB')} tokens`;

/** A name for an address nobody has given one to: what stands before the @, as a name is written. */
const nameOfAddress = (address: string): string => {
  const local = (address.split('@')[0] ?? '').split(/[._+-]/)[0] ?? '';
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : address;
};

/** Whether a person in a thread is the one a name asks for: a whole word of their name, or how their address begins. */
const mailNamed = (person: MailPerson, asked: string): boolean => {
  const words = person.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return asked.split(/\s+/).every((part) => words.includes(part)) || person.address.split('@')[0] === asked.replace(/\s+/g, '.');
};

/**
 * Sends one nudge: in its thread when it has one, as a new mail when it has
 * none or when the thread would not take the words.
 *
 * Once Send was pressed in the thread the nudge may be on its way whatever is
 * read afterwards, and it is never sent a second time as a new mail. It used
 * to be: the thread does not show a mail for a moment after it is sent, that
 * read as "not sent", and the same nudge went out again as a mail of its own
 * (the hardening audit, 17 November 2026).
 */
/** Why a nudge is called not sent when Send was pressed and nothing confirmed it. Short: the notch shows 80 signs of it. */
export const NUDGE_UNSURE = 'Gmail did not confirm it went. Look in the thread before trying again';

export async function sendNudge(
  box: Pick<Mailbox, 'reply' | 'write'>,
  plan: { address: string; thread: string | null; subject: string; text: string },
  now: () => number,
  log: (line: string) => void,
): Promise<MailStep> {
  if (plan.thread) {
    const since = now();
    let pressed = false;
    const inThread = await box.reply({ thread: plan.thread, to: [plan.address], cc: [], text: plan.text }, async (session): Promise<MailStep> => {
      const written = await session.write();
      if (!written.ok) return written;
      pressed = true;
      const sent = await session.send();
      // Gmail said it went: it went. The thread showing it is a matter of a moment.
      if (sent.ok) return { ok: true };
      // No answer to the send (it can take longer than is waited for): the thread is asked.
      if ((await session.sent(since)) === true) return { ok: true };
      await session.discard();
      return sent;
    });
    if (inThread.ok) return inThread;
    // Send was pressed and nothing says it went: it may have. That is said, and it is not sent again.
    if (pressed) return { ok: false, why: NUDGE_UNSURE };
    // The thread would not take it (it goes to others too, or it has moved on): a mail of its own, then.
    log('[notch] a nudge could not be written in its thread, so it goes as a new mail');
  }
  return box.write({ to: plan.address, subject: plan.subject, text: plan.text });
}

export function attachMailLayer(inbox: NotchInbox, deps: NotchMailLayerDeps): NotchMailLayer {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = new MailStore(deps.db);
  const turn = new MailTabTurn();
  const page = () => { const browser = deps.tab(); return browser ? googlePage(browser) : null; };
  const mailbox = (): Mailbox | null => { const tab = page(); return tab ? browserMailbox(tab, turn, { now }) : null; };

  let calendarKept: { at: number; from: number; to: number; events: MailCalendarEvent[] | null } | null = null;
  const calendar = async (from: number, to: number): Promise<MailCalendarEvent[] | null> => {
    if (calendarKept && now() - calendarKept.at < MAIL_CALENDAR_KEPT_MS && calendarKept.from <= from && calendarKept.to >= to) return calendarKept.events;
    const reached = await firstWay<MailCalendarEvent[]>([
      { name: 'connection', get: async () => (await deps.connectedCalendar?.(from, to)) ?? null },
      { name: 'browser', get: async () => { const tab = page(); return tab ? (await turn.take(() => browserCalendar(tab, from, to)))?.events ?? null : null; } },
    ]);
    for (const way of reached.tried) if (way.why === 'failed') log(`[notch] the calendar could not be read through the ${way.name}: ${way.reason}`);
    calendarKept = { at: now(), from, to, events: reached.value };
    return reached.value;
  };

  let mail: NotchMail | null = null;
  /** Whether Gmail is the site in front: there a reply speaks up as soon as it is prepared, not only on arrival. */
  let inGmail = false;
  /**
   * Whether the first look through the month is over. What it finds is mail that had been lying there, and
   * speaks only in Gmail. A reply prepared after it is to a mail that has just come, and speaks from anywhere.
   */
  let sweptOnce = false;
  /** Whether the owner, in Gmail, was told to wait for a look that was under way: they are owed its result. */
  let owed = false;
  const speak = (): void => {
    void mail?.arrived().then(
      (came) => { owed = came === 'reading'; },
      (error) => log(`[notch] mail on arrival failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  const readListeners: ((threads: MailThread[]) => void)[] = [];
  const watch = new MailWatch({
    store,
    think: deps.think,
    reader: async () => {
      const reached = await firstWay<MailReader>([
        { name: 'connection', get: async () => (await deps.connection?.()) ?? null },
        { name: 'browser', get: async () => (await mailbox()?.reader()) ?? null },
      ]);
      for (const way of reached.tried) if (way.why === 'failed') log(`[notch] the mailbox could not be reached through the ${way.name}: ${way.reason}`);
      return reached.value ? { reader: reached.value, through: reached.through } : null;
    },
    calendar,
    files: async (words) => { const tab = page(); return tab ? turn.take(() => browserDriveSearch(tab, words, { most: 4 })) : null; },
    changed: () => { mail?.sync(); if (inGmail) speak(); else if (sweptOnce) mail?.speak(); },
    read: (threads) => { for (const listener of readListeners) listener(threads); },
    paused: deps.paused,
    modelReady: deps.modelReady,
    now,
    zone: deps.zone,
    waitMs: deps.waitMs,
    log,
  });
  mail = attachNotchMail(inbox, { store, watch, mailbox, inGmail: () => inGmail, monthRead: () => sweptOnce, now, log });

  const timers: ReturnType<typeof setInterval>[] = [];
  let first: ReturnType<typeof setTimeout> | null = null;
  const said = { through: undefined as string | null | undefined };
  /** Whether the month still has to be gone through: at the start, every six hours, and for as long as a look through it was cut short. */
  let monthDue = true;
  const look = async (kind: MailLookKind) => {
    const result = await watch.look(kind);
    if (kind === 'sweep' && result.through && !result.failed) { sweptOnce = true; monthDue = false; }
    // The owner came to Gmail while this look was under way and was told to wait: now they are told.
    if (owed && inGmail) speak();
    // Said when it changes, not every minute: which way the mail is reached, or that there is none.
    if (result.through !== said.through && !deps.paused?.() && deps.modelReady?.() !== false) {
      said.through = result.through;
      log(result.through ? `[notch] mail is read through the ${result.through}` : '[notch] mail cannot be reached: no connection, and no signed-in browser tab');
    }
    if (result.prepared || result.overtaken) log(`[notch] mail, ${kind}: ${result.read} threads read, ${result.prepared} replies prepared, ${result.overtaken} left`);
    return result;
  };
  if (!deps.noClock) {
    // The last two days first: a reply to what came lately is ready within a minute. Then the month.
    first = setTimeout(() => { void look('recent').then(() => look('sweep')); }, MAIL_FIRST_LOOK_MS);
    first.unref?.();
    let ticks = 0;
    const every = setInterval(() => {
      ticks++;
      if (ticks % Math.round(MAIL_SWEEP_MS / MAIL_GLANCE_MS) === 0) monthDue = true;
      const recent = ticks % Math.round(MAIL_RECENT_MS / MAIL_GLANCE_MS) === 0;
      // A look that is under way is the one that is waited for: asking again while the month is read changes nothing.
      void look(monthDue && !watch.busy() ? 'sweep' : recent ? 'recent' : 'glance');
    }, MAIL_GLANCE_MS);
    every.unref?.();
    timers.push(every);
  }

  return {
    store,
    watch,
    mail,
    arrived: (site) => { inGmail = site === GMAIL; if (inGmail) speak(); else owed = false; },
    sentSince: (since) => store.sentSince(since).map((row) => ({
      at: row.sentAt ?? row.updatedAt,
      text: `Replied to ${mailFirstName(row.who)}: ${row.subject}`,
      small: tokens(row),
    })),
    look,
    monthDue: () => monthDue,
    async reached() {
      try {
        if (await deps.connection?.()) return true;
        return (await mailbox()?.reader()) != null;
      } catch { return false; }
    },
    calendar,
    standing: {
      onRead: (listener) => { readListeners.push(listener); },
      owner: () => mailFirstName({ name: watch.name(), address: '' }),
      look: async () => { await look('glance'); },
      async find(who) {
        const box = mailbox();
        const reader = await box?.reader();
        if (!box || !reader) throw new Error('the mailbox cannot be reached');
        const owner = (await reader.owner()).toLowerCase();
        const asked = who.trim().toLowerCase();
        const byAddress = asked.includes('@');
        // The newest thread with them, written by either side: a nudge goes where the talk already is.
        const rows = await box.search(byAddress ? `{from:${asked} to:${asked}} newer_than:90d` : `{from:(${asked}) to:(${asked})} newer_than:90d`, 1);
        for (const row of rows) {
          const them = row.people.find((person) => person.address && person.address !== owner
            && (byAddress ? person.address === asked : mailNamed(person, asked)));
          if (them) return { name: them.name || nameOfAddress(them.address), address: them.address, thread: { id: row.id, subject: row.subject } };
        }
        // An address nobody has written from yet can still be written to. A name with no mail behind it cannot.
        return byAddress ? { name: nameOfAddress(asked), address: asked, thread: null } : null;
      },
      async send(plan) {
        const box = mailbox();
        if (!box) return { ok: false, why: 'the mailbox cannot be reached' };
        return sendNudge(box, plan, now, log);
      },
    },
    stop: () => { if (first) clearTimeout(first); for (const timer of timers) clearInterval(timer); },
  };
}
