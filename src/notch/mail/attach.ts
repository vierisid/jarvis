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
 * month when the brain starts and every six hours after. One look at a time,
 * and none while everything is stopped.
 */
import type { Database } from 'bun:sqlite';
import type { NotchInbox } from '../inbox.ts';
import { firstWay } from '../ways.ts';
import type { MailBrowser } from './browser.ts';
import { browserCalendar } from './calendar.ts';
import { browserDriveSearch } from './drive.ts';
import { browserMailbox, type Mailbox } from './mailbox.ts';
import { attachNotchMail, type NotchMail } from './notch.ts';
import { googlePage } from './page.ts';
import type { MailCalendarEvent, MailThink } from './proposer.ts';
import { MailStore, type MailProposalRow } from './store.ts';
import { MailTabTurn } from './tab.ts';
import { mailFirstName } from './thread.ts';
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
  stop(): void;
}

const tokens = (row: MailProposalRow): string => `${(row.tokensIn + row.tokensOut).toLocaleString('en-GB')} tokens`;

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
  const speak = (): void => { void mail?.arrived().catch((error) => log(`[notch] mail on arrival failed: ${error instanceof Error ? error.message : String(error)}`)); };
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
    changed: () => { mail?.sync(); if (inGmail) speak(); },
    paused: deps.paused,
    modelReady: deps.modelReady,
    now,
    zone: deps.zone,
    waitMs: deps.waitMs,
    log,
  });
  mail = attachNotchMail(inbox, { store, watch, mailbox, now, log });

  const timers: ReturnType<typeof setInterval>[] = [];
  let first: ReturnType<typeof setTimeout> | null = null;
  const said = { through: undefined as string | null | undefined };
  const look = async (kind: MailLookKind) => {
    const result = await watch.look(kind);
    // Said when it changes, not every minute: which way the mail is reached, or that there is none.
    if (result.through !== said.through && !deps.paused?.() && deps.modelReady?.() !== false) {
      said.through = result.through;
      log(result.through ? `[notch] mail is read through the ${result.through}` : '[notch] mail cannot be reached: no connection, and no signed-in browser tab');
    }
    if (result.prepared || result.overtaken) log(`[notch] mail, ${kind}: ${result.read} threads read, ${result.prepared} replies prepared, ${result.overtaken} left`);
    return result;
  };
  if (!deps.noClock) {
    first = setTimeout(() => { void look('sweep'); }, MAIL_FIRST_LOOK_MS);
    first.unref?.();
    let ticks = 0;
    const every = setInterval(() => {
      ticks++;
      const sweep = ticks % Math.round(MAIL_SWEEP_MS / MAIL_GLANCE_MS) === 0;
      const recent = ticks % Math.round(MAIL_RECENT_MS / MAIL_GLANCE_MS) === 0;
      void look(sweep ? 'sweep' : recent ? 'recent' : 'glance');
    }, MAIL_GLANCE_MS);
    every.unref?.();
    timers.push(every);
  }

  return {
    store,
    watch,
    mail,
    arrived: (site) => { inGmail = site === GMAIL; if (inGmail) speak(); },
    sentSince: (since) => store.sentSince(since).map((row) => ({
      at: row.sentAt ?? row.updatedAt,
      text: `Replied to ${mailFirstName(row.who)}: ${row.subject}`,
      small: tokens(row),
    })),
    look,
    stop: () => { if (first) clearTimeout(first); for (const timer of timers) clearInterval(timer); },
  };
}
