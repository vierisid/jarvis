/**
 * The owner's mailbox through the notch's own tab: read, and written to.
 *
 * Reading is what ./watch.ts asks for (the list, and threads in full).
 * Writing is one reply in one thread: put in as a draft, then sent, or thrown
 * away. Both go through the same tab (./tab.ts), and each piece of work takes
 * the tab's turn, so that nothing navigates away under anything else.
 *
 * A reply holds the turn from its first step to its last: the draft is
 * written, the owner's window to take it back burns down, and it is sent or
 * discarded, all in the thread that was opened for it.
 */
import { gmailSearch, gmailThreads, type GmailRow } from './gmail.ts';
import type { GooglePage } from './page.ts';
import { MailSignedOut, type MailTabTurn } from './tab.ts';
import type { MailThread } from './thread.ts';
import type { MailListed, MailReader } from './watch.ts';

/** How many pages of the list a look may go through: a month of a busy mailbox, and room. */
export const MAILBOX_PAGES_MONTH = 150;
export const MAILBOX_PAGES_RECENT = 8;

export interface MailReplyPlan {
  /** The thread the reply is written in. */
  thread: string;
  /** Who it goes to, and who is in copy: addresses. Decided by ./waiting.ts, checked on the page before every step. */
  to: string[];
  cc: string[];
  text: string;
}

/**
 * `pressed`, on a no: whether Send was pressed. Only `false` says that
 * nothing went. `true`, or nothing said at all, is a mail that may be on its
 * way: it is never sent again on the strength of this no, and whoever sends
 * it again looks first (`Mailbox.went`). `since` is the moment before the
 * press, for that look.
 */
export type MailStep = { ok: true } | { ok: false; why: string; pressed?: boolean; since?: number };

/** A mail that may have gone, as it is looked for afterwards: where, to whom, and how it begins. */
export interface MailSentAsk {
  to: string;
  /** The thread it was written in, or null for a mail of its own. */
  thread: string | null;
  subject: string;
  text: string;
}

/**
 * Why a new mail is called not sent when Send was pressed and the Sent folder
 * does not show it. Short: the notch shows 80 signs of it.
 */
export const MAIL_WHY_UNSURE = 'Gmail did not confirm it went. Look in Sent before trying again';

/** How often the Sent folder is asked again for a mail it does not show yet, and how long between. */
export const MAIL_SENT_ASKS = 3;
export const MAIL_SENT_WAIT_MS = 2000;

/**
 * Why a reply was not written when its thread already holds a draft with
 * words in it (./page/reply.js says exactly this). That draft is somebody's:
 * it is never written into and never thrown away.
 */
export const MAIL_WHY_DRAFT_THERE = 'a reply is already being written in that thread';

/** One reply, with the tab to itself. */
export interface MailReplySession {
  /** Opens the thread and writes the reply into it. Gmail keeps it as a draft. Nothing is sent. */
  write(): Promise<MailStep>;
  /**
   * Presses Send, once. Yes means Gmail said, after the press, that it went.
   * A no says whether Send was pressed: when it was, `sent` is asked.
   */
  send(): Promise<MailStep>;
  /** Throws the reply away: nothing is left in Drafts. */
  discard(): Promise<MailStep>;
  /** After a send: does the mailbox show a mail of the owner's, sent since then, as the last word in the thread? Null when that could not be read. */
  sent(since: number): Promise<boolean | null>;
}

/** A new mail to one person. Short: it travels in the address that opens Gmail's writing window. */
export interface MailNewPlan {
  to: string;
  /**
   * More people the same mail goes to, each of them named by the owner. The
   * follow-up to a call is the one mail that has them (src/notch/call.ts).
   */
  also?: string[];
  subject: string;
  text: string;
}

/** The most people a new mail goes to. */
export const MAIL_NEW_TO_MOST = 6;

/** The longest a new mail's words may be. */
export const MAIL_NEW_TEXT_MAX = 900;

export interface Mailbox {
  /** The mailbox for reading, or null when the browser is not signed in to Google. */
  reader(): Promise<MailReader | null>;
  /**
   * Writes one new mail to one person and sends it, with the tab to itself.
   * Nothing is sent unless the writing window holds exactly this mail, to
   * exactly this person (page/compose-send.js). When it says no after the
   * window opened, a draft may be left in Gmail: the reason says what failed.
   * Yes means Gmail said, after Send was pressed, that it went; or, when it
   * said nothing, that the Sent folder shows it. A no with `pressed` not
   * false is a mail that may have gone all the same.
   */
  write(plan: MailNewPlan): Promise<MailStep>;
  /**
   * Whether a mail that may have gone did: the thread, or the Sent folder for
   * a mail of its own, shows a mail of the owner's since then that begins
   * with these words. Null when that could not be read. Asked before
   * anything is sent a second time.
   */
  went(mail: MailSentAsk, since: number): Promise<boolean | null>;
  /** The threads a search of the mailbox finds, newest first. */
  search(query: string, pages?: number): Promise<MailListed[]>;
  /** Runs one reply from its first step to its last, with the tab to itself. */
  reply<T>(plan: MailReplyPlan, work: (session: MailReplySession) => Promise<T>): Promise<T>;
}

interface StepAnswer { ok?: unknown; why?: unknown }
const stepOf = (answer: StepAnswer | null): MailStep =>
  (answer?.ok === true ? { ok: true } : { ok: false, why: typeof answer?.why === 'string' ? answer.why.slice(0, 200) : 'the page did not answer' });

export function browserMailbox(page: Required<GooglePage>, turn: MailTabTurn, options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Mailbox {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

  /** How a mail begins, for telling it from another: its first words, however they are spaced. */
  const begins = (message: string, text: string): boolean => { const start = flat(text).slice(0, 120); return start.length > 0 && flat(message).startsWith(start); };
  /**
   * Whether a mail in a thread is the one that was sent: the owner's, since
   * then, and beginning with our words. "An owner mail in the last two
   * minutes" was taken for it, and the owner answering by hand at the same
   * moment was read as our mail having gone.
   */
  const isOurs = (message: MailThread['messages'][number], owner: string, text: string, since: number): boolean =>
    // Gmail prints when a mail was sent to the minute: one sent at 9:05:40 reads as 9:05.
    message.from.address === owner.toLowerCase() && message.at >= since - 120_000 && begins(message.text, text);

  /**
   * Does the Sent folder show a mail of the owner's to that person, with that
   * subject and beginning with those words, sent since then? Null when that
   * could not be read. Asked with the tab's turn already held.
   */
  const inSent = async (to: string, subject: string, text: string, since: number): Promise<boolean | null> => {
    try {
      const owner = (await page.run<{ address: string }>('owner')).address;
      const days = Math.max(1, Math.ceil((now() - since) / 86_400_000) + 1);
      const rows = (await gmailSearch(page, `in:sent to:${to} newer_than:${days}d`, { pages: 1 })).filter((row) => flat(row.subject) === flat(subject)).slice(0, 2);
      if (rows.length === 0) return false;
      const { threads } = await gmailThreads(page, rows, { batch: 2, pauses: [] });
      if (threads.length === 0) return null;
      return threads.some((thread) => thread.messages.some((message) => isOurs(message, owner, text, since)));
    } catch {
      return null;
    }
  };
  /** The same, of a thread: any mail in it, for a look that comes later, or only its last word. */
  const inThread = async (thread: string, text: string, since: number, which: 'last' | 'any'): Promise<boolean | null> => {
    try {
      const owner = (await page.run<{ address: string }>('owner')).address;
      const { threads } = await gmailThreads(page, [{ id: thread, draft: false, subject: '' }], { batch: 1, pauses: [] });
      const messages = threads[0]?.messages ?? [];
      const last = messages.at(-1);
      if (!last) return null;
      return which === 'last' ? isOurs(last, owner, text, since) : messages.some((message) => isOurs(message, owner, text, since));
    } catch {
      return null;
    }
  };

  /** Gmail up in the tab: the tab may have been left on the calendar, on Drive, or on nothing. */
  const gmailUp = async (): Promise<void> => {
    const where = await page.run<{ up?: boolean }>('where').catch((error: unknown) => {
      if (error instanceof MailSignedOut) throw error;
      return null;
    });
    if (where?.up) return;
    await page.go('mail', '/mail/u/0/#inbox');
  };
  /** A piece of reading: the tab's turn, and Gmail up in it. */
  const reading = <T>(work: () => Promise<T>): Promise<T> => turn.take(async () => { await gmailUp(); return work(); });
  const readingPage = { run: <T>(name: string, args?: unknown) => reading(() => page.run<T>(name, args)) };
  const listed = (row: GmailRow, filed?: MailThread['filed']): MailListed => ({ ...row, ...(filed ? { filed } : {}) });

  const reader: MailReader = {
    owner: async () => (await reading(() => page.run<{ address: string }>('owner'))).address,
    async list(days, top) {
      const window = `newer_than:${Math.max(1, Math.floor(days))}d`;
      const pages = top ?? (days > 7 ? MAILBOX_PAGES_MONTH : MAILBOX_PAGES_RECENT);
      // Everything but advertising, social notices and mailing lists. A search that names chats shows no mail at all.
      const rows = await gmailSearch(page, `${window} -category:promotions -category:social -category:forums`, { pages, step: reading });
      // The top of the list is where a mail that just came is: the rest is for the fuller looks.
      if (top) return rows.map((row) => listed(row));
      // A mailing list is a person only when the owner has been writing in the thread.
      const forums = await gmailSearch(page, `${window} category:forums from:me`, { pages: 3, step: reading }).catch(() => [] as GmailRow[]);
      const have = new Set(rows.map((row) => row.id));
      return [...rows.map((row) => listed(row)), ...forums.filter((row) => !have.has(row.id)).map((row) => listed(row, 'forums'))];
    },
    // A look reads a few threads at a time and goes on to the next: one that Gmail did not give is read by the next look.
    // Four to a turn of the tab: what the owner asks for in the middle of a look waits for one such turn at most.
    read: async (rows) => (await gmailThreads(readingPage, rows, { batch: 4, pauses: [] })).threads,
    // The owner's own latest mail, for their voice.
    sent: async (days) => (await gmailSearch(page, `in:sent newer_than:${Math.max(1, Math.floor(days))}d`, { pages: 1, step: reading })).map((row) => listed(row)),
  };

  return {
    async reader() {
      try {
        await reading(async () => {});
        return reader;
      } catch (error) {
        if (error instanceof MailSignedOut) return null;
        throw error;
      }
    },
    search: async (query, pages = 1) => (await gmailSearch(page, query, { pages, step: reading })).map((row) => listed(row)),
    write: (plan) => turn.take(async () => {
      try {
        // Everybody it goes to, each once. One of them that is not an address makes it no mail at all.
        const people = [...new Set([plan.to, ...(plan.also ?? [])].map((one) => one.trim().toLowerCase()))];
        if (people.length > MAIL_NEW_TO_MOST || people.some((one) => !/^[^\s<>,;"]+@[^\s<>,;"]+$/.test(one)) || !plan.subject.trim() || !plan.text.trim() || plan.text.length > MAIL_NEW_TEXT_MAX) {
          return { ok: false, why: 'the mail is not one that can be sent this way', pressed: false };
        }
        const part = encodeURIComponent;
        await page.go('mail', `/mail/u/0/?view=cm&fs=1&tf=1&to=${people.map(part).join(',')}&su=${part(plan.subject)}&body=${part(plan.text)}`);
        const window = await page.run<{ subject?: number | null; body?: number | null; send?: boolean }>('shape-compose', { wait: 9000 });
        if (window?.subject !== plan.subject.length || !window.body || !window.send) return { ok: false, why: 'the writing window did not open as expected', pressed: false };
        // Send is told exactly whom this mail may go to: that one person, or those people and nobody else.
        const since = now();
        // A page that went away while Send was being pressed gives no answer: the mail may have gone all the same.
        const sent = await page.run<{ sent?: boolean; pressed?: boolean; why?: string }>('compose-send', { subject: plan.subject, to: people.length === 1 ? people[0] : people })
          .catch(() => ({ sent: false, pressed: true, why: '' }));
        // The writing window is left: the tab goes back to the list for whoever reads next.
        await page.go('mail', '/mail/u/0/#inbox').catch(() => {});
        // Refused before Send was pressed: nothing went, and the reason is the page's. Only a page
        // that says it did not press is believed: no word about it is a mail that may have gone.
        if (sent?.sent !== true && sent?.pressed === false) return { ok: false, why: typeof sent.why === 'string' && sent.why ? sent.why.slice(0, 200) : 'Gmail did not say it was sent', pressed: false };
        // Gmail said, after the press, that it went: it went (the hardening audit, 17 November 2026).
        if (sent?.sent === true) return { ok: true };
        // Gmail said nothing. It may have gone all the same: the Sent folder is asked, and it
        // takes a moment to show a mail.
        let there = await inSent(people[0]!, plan.subject, plan.text, since);
        for (let asks = 1; there === false && asks < MAIL_SENT_ASKS; asks++) { await sleep(MAIL_SENT_WAIT_MS); there = await inSent(people[0]!, plan.subject, plan.text, since); }
        await page.go('mail', '/mail/u/0/#inbox').catch(() => {});
        if (there === true) return { ok: true };
        return { ok: false, why: MAIL_WHY_UNSURE, pressed: true, since };
      } catch (error) {
        // Nothing was pressed yet when this failed: the press itself is caught where it is made.
        return { ok: false, why: (error instanceof Error ? error.message : String(error)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(an address)').slice(0, 200), pressed: false };
      }
    }, { first: true }),
    went: (mail, since) => turn.take(async () => {
      try {
        await gmailUp();
        const there = mail.thread ? await inThread(mail.thread, mail.text, since, 'any') : await inSent(mail.to.trim().toLowerCase(), mail.subject, mail.text, since);
        await page.go('mail', '/mail/u/0/#inbox').catch(() => {});
        return there;
      } catch {
        return null;
      }
    }, { first: true }),
    reply: (plan, work) => turn.take(async () => {
      const told = { do: '', thread: plan.thread, to: plan.to, cc: plan.cc, text: plan.text };
      // A step that throws (the page went away, the desktop app did not answer) is a step that did not
      // happen, with its reason: whoever asked decides what that means, and is never left without an answer.
      const step = async (work: () => Promise<MailStep>): Promise<MailStep> => {
        try {
          return await work();
        } catch (error) {
          return { ok: false, why: (error instanceof Error ? error.message : String(error)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(an address)').slice(0, 200) };
        }
      };
      const session: MailReplySession = {
        write: () => step(async () => {
          // Gmail opens a thread from its own address only when it is loaded afresh: the number makes the address new.
          await page.go('mail', `/mail/u/0/?zx=${now().toString(36)}#all/${plan.thread}`);
          const open = await page.run<{ open?: boolean }>('thread-open', { id: plan.thread });
          if (!open?.open) return { ok: false, why: 'the thread did not open' };
          return stepOf(await page.run<StepAnswer>('reply', { ...told, do: 'write' }));
        }),
        async send() {
          // A send that gave no answer (the page went away under it) may have been pressed: only a
          // page that says it did not press is a send that did not happen.
          const answer = await step(async () => {
            const said = await page.run<StepAnswer & { pressed?: unknown }>('reply', { ...told, do: 'send' });
            const stepped = stepOf(said);
            return stepped.ok ? stepped : { ...stepped, pressed: said?.pressed !== false };
          });
          return answer.ok || answer.pressed !== undefined ? answer : { ...answer, pressed: true };
        },
        discard: () => step(async () => stepOf(await page.run<StepAnswer>('reply', { ...told, do: 'discard' }))),
        // The last word in the thread is the owner's, sent since then, and begins with this reply.
        sent: (since) => inThread(plan.thread, plan.text, since, 'last'),
      };
      return work(session);
    }, { first: true }),
  };
}
