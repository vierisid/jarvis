/**
 * The notch's own tab in Jarvis's browser, as the brain uses it.
 *
 * The desktop app keeps a tab beside the page the agent drives, and takes it
 * to Gmail, Google Calendar and Google Drive and nowhere else
 * (sidecar/browser_mail_tab.go). Here that tab is the `MailBrowser` the
 * readers and the writer in this folder work with, and one thing more: a
 * turn. There is one tab, and a look at the mailbox, a look at the calendar
 * and a reply being sent all need it. Whoever has the turn has the tab to
 * themselves until they are done, so that a look never navigates away from a
 * reply that is half written.
 */
import type { MailBrowser } from './browser.ts';
import { GOOGLE_SITES } from './page.ts';

/** The browser is there and is not signed in to Google: this way to the mailbox is not here. */
export class MailSignedOut extends Error {
  constructor() { super('Jarvis\'s browser is not signed in to Google'); }
}

/** One call to the desktop app that has the tab. Throws when the call fails. */
export type MailTabCall = (method: 'mail_tab_navigate' | 'mail_tab_evaluate', params: Record<string, unknown>) => Promise<unknown>;

const SITES = new Set<string>(Object.keys(GOOGLE_SITES));

/** The tab as a browser: go to an address, run a script and hear its answer. */
export function mailTabBrowser(call: MailTabCall): MailBrowser {
  const said = (error: unknown): never => {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.includes('mail tab: signed out')) throw new MailSignedOut();
    throw error instanceof Error ? error : new Error(reason);
  };
  return {
    async navigate(url) {
      const answer = await call('mail_tab_navigate', { url }).catch(said) as { site?: unknown } | null;
      const site = typeof answer?.site === 'string' ? answer.site : '';
      if (site === 'sign-in') throw new MailSignedOut();
      // Asked for one of the three sites and landed somewhere else: nothing is read there.
      if (!SITES.has(site)) throw new Error('the page that came up is not one of the sites that are read');
    },
    async evaluate(expression) {
      const answer = await call('mail_tab_evaluate', { expression }).catch(said);
      return typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
    },
  };
}

/**
 * Whose turn the tab is. Work is done one piece after the other, in the order
 * it was asked for, except that what the owner is waiting on (a reply they
 * just said yes to) goes before what Jarvis does by itself.
 */
export class MailTabTurn {
  private busy = false;
  private readonly waiting: { first: boolean; start: () => void }[] = [];

  /** Runs `work` with the tab to itself. `first`: the owner is waiting on it. */
  async take<T>(work: () => Promise<T>, options: { first?: boolean } = {}): Promise<T> {
    if (this.busy) {
      await new Promise<void>((start) => {
        const entry = { first: options.first === true, start };
        // Before everything Jarvis does by itself, after anything else the owner is already waiting on.
        const at = entry.first ? this.waiting.findIndex((other) => !other.first) : -1;
        if (at >= 0) this.waiting.splice(at, 0, entry); else this.waiting.push(entry);
      });
    }
    this.busy = true;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      // The turn passes straight to the next: nobody can slip in between.
      if (next) next.start(); else this.busy = false;
    }
  }

  /** Whether the tab is in use right now. */
  taken(): boolean {
    return this.busy;
  }
}
