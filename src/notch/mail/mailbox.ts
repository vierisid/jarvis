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

export type MailStep = { ok: true } | { ok: false; why: string };

/** One reply, with the tab to itself. */
export interface MailReplySession {
  /** Opens the thread and writes the reply into it. Gmail keeps it as a draft. Nothing is sent. */
  write(): Promise<MailStep>;
  /** Presses Send, once. */
  send(): Promise<MailStep>;
  /** Throws the reply away: nothing is left in Drafts. */
  discard(): Promise<MailStep>;
  /** After a send: does the mailbox show a mail of the owner's, sent since then, as the last word in the thread? Null when that could not be read. */
  sent(since: number): Promise<boolean | null>;
}

/** A new mail to one person. Short: it travels in the address that opens Gmail's writing window. */
export interface MailNewPlan {
  to: string;
  subject: string;
  text: string;
}

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
   */
  write(plan: MailNewPlan): Promise<MailStep>;
  /** The threads a search of the mailbox finds, newest first. */
  search(query: string, pages?: number): Promise<MailListed[]>;
  /** Runs one reply from its first step to its last, with the tab to itself. */
  reply<T>(plan: MailReplyPlan, work: (session: MailReplySession) => Promise<T>): Promise<T>;
}

interface StepAnswer { ok?: unknown; why?: unknown }
const stepOf = (answer: StepAnswer | null): MailStep =>
  (answer?.ok === true ? { ok: true } : { ok: false, why: typeof answer?.why === 'string' ? answer.why.slice(0, 200) : 'the page did not answer' });

export function browserMailbox(page: Required<GooglePage>, turn: MailTabTurn, options: { now?: () => number } = {}): Mailbox {
  const now = options.now ?? Date.now;

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
        if (!/^[^\s<>,;"]+@[^\s<>,;"]+$/.test(plan.to) || !plan.subject.trim() || !plan.text.trim() || plan.text.length > MAIL_NEW_TEXT_MAX) {
          return { ok: false, why: 'the mail is not one that can be sent this way' };
        }
        const part = encodeURIComponent;
        await page.go('mail', `/mail/u/0/?view=cm&fs=1&tf=1&to=${part(plan.to)}&su=${part(plan.subject)}&body=${part(plan.text)}`);
        const window = await page.run<{ subject?: number | null; body?: number | null; send?: boolean }>('shape-compose', { wait: 9000 });
        if (window?.subject !== plan.subject.length || !window.body || !window.send) return { ok: false, why: 'the writing window did not open as expected' };
        const sent = await page.run<{ sent?: boolean; why?: string }>('compose-send', { subject: plan.subject, to: plan.to });
        // The writing window is left: the tab goes back to the list for whoever reads next.
        await page.go('mail', '/mail/u/0/#inbox').catch(() => {});
        return sent?.sent ? { ok: true } : { ok: false, why: typeof sent?.why === 'string' && sent.why ? sent.why.slice(0, 200) : 'Gmail did not say it was sent' };
      } catch (error) {
        return { ok: false, why: (error instanceof Error ? error.message : String(error)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(an address)').slice(0, 200) };
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
        send: () => step(async () => stepOf(await page.run<StepAnswer>('reply', { ...told, do: 'send' }))),
        discard: () => step(async () => stepOf(await page.run<StepAnswer>('reply', { ...told, do: 'discard' }))),
        async sent(since) {
          try {
            const owner = (await page.run<{ address: string }>('owner')).address;
            const { threads } = await gmailThreads(page, [{ id: plan.thread, draft: false, subject: '' }], { batch: 1, pauses: [] });
            const last = threads[0]?.messages.at(-1);
            if (!last) return null;
            // Gmail prints when a mail was sent to the minute: one sent at 9:05:40 reads as 9:05.
            return last.from.address === owner.toLowerCase() && last.at >= since - 120_000;
          } catch {
            return null;
          }
        },
      };
      return work(session);
    }, { first: true }),
  };
}
