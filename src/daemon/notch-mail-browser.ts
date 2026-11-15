/**
 * Jarvis's own browser, for the mail reader: the browser of the connected
 * desktop app, reached by its own calls. These go straight to the desktop
 * app. They are not tool calls by an agent, so nothing is asked about and
 * nothing is marked as outside content on the way: what comes back is read
 * by code, and the code that hands any of it to a model marks it itself.
 */
import { listUpcomingEvents } from '../integrations/google-api.ts';
import type { GoogleAuth } from '../integrations/google-auth.ts';
import type { LLMManager } from '../llm/manager.ts';
import { runWithOrigin } from '../llm/origin.ts';
import type { Database } from 'bun:sqlite';
import type { MailBrowser } from '../notch/mail/browser.ts';
import { mailTabBrowser } from '../notch/mail/tab.ts';
import type { NotchRealDeps } from '../notch/real.ts';
import type { NotchStudyDeps } from '../notch/mail/study-route.ts';
import { servesCapability } from '../sidecar/capability-predicate.ts';
import type { SidecarManager } from '../sidecar/manager.ts';

/** A page of mail can take a while to come up the first time. */
const MAIL_RPC_TIMEOUT = { initial: 45_000, max: 60_000 };

/** The browser of the first connected desktop app that has one, or null. */
export function notchMailBrowser(manager: Pick<SidecarManager, 'listSidecars' | 'dispatchRPC'>): MailBrowser | null {
  const machine = manager.listSidecars().find((sidecar) => servesCapability(sidecar, 'browser'));
  if (!machine) return null;
  return {
    async navigate(url, options) {
      const params = options?.headless === undefined ? { url } : { url, headless: options.headless };
      await manager.dispatchRPC(machine.id, 'browser_navigate', params, MAIL_RPC_TIMEOUT);
    },
    async evaluate(expression) {
      const answer = await manager.dispatchRPC(machine.id, 'browser_evaluate', { expression }, MAIL_RPC_TIMEOUT);
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  };
}

/** A script in the notch's tab may read a batch of threads: the desktop app gives it ninety seconds. */
const MAIL_TAB_TIMEOUT = { initial: 100_000, max: 120_000 };
/** The feature a desktop app names when it has the notch's own tab (sidecar/browser_mail_tab.go). */
export const MAIL_TAB_FEATURE = 'browser_mail_tab';

/**
 * The notch's own tab in the first connected desktop app that has one, or
 * null. It is beside the page the agent drives, so a look at the mail never
 * takes that page.
 */
export function notchMailTab(manager: Pick<SidecarManager, 'listSidecars' | 'dispatchRPC'>): MailBrowser | null {
  const machine = manager.listSidecars().find((sidecar) => servesCapability(sidecar, 'browser') && sidecar.features?.includes(MAIL_TAB_FEATURE));
  if (!machine) return null;
  return mailTabBrowser((method, params) => manager.dispatchRPC(machine.id, method, params, MAIL_TAB_TIMEOUT));
}

/** What the notch's mail layer (pass 7) needs of a running brain. */
export function notchMailLayerDeps(options: {
  db: Database;
  manager: Pick<SidecarManager, 'listSidecars' | 'dispatchRPC'>;
  llm: () => LLMManager;
  google: () => GoogleAuth | null;
  modelReady: () => boolean;
  /** A shorter wait than the rule's four hours, in minutes: for trying a build. */
  waitMinutes?: number;
}): NonNullable<NotchRealDeps['mail']> {
  const wait = options.waitMinutes;
  return {
    db: options.db,
    tab: () => notchMailTab(options.manager),
    // Jarvis by itself, reading mail other people wrote: not the person's own words.
    think: (messages, { maxTokens }) => runWithOrigin('background', async () => {
      const answer = await options.llm().chatTier('medium', 'notch_mail', messages, { max_tokens: maxTokens, temperature: 0 });
      return {
        content: answer.content,
        model: answer.model,
        input: answer.usage.input_tokens,
        output: answer.usage.output_tokens,
        cached: answer.usage.cache_read_input_tokens ?? 0,
      };
    }),
    connectedCalendar: async (from, to) => {
      const google = options.google();
      if (!google?.isAuthenticated()) return null;
      const events = await listUpcomingEvents(await google.getAccessToken(), 'primary', new Date(from).toISOString(), new Date(to).toISOString(), 250);
      return events.map((event) => ({ summary: event.summary, start: event.start, end: event.end, ...(event.attendees.length > 1 ? { withOthers: true } : {}) }));
    },
    modelReady: options.modelReady,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(wait && Number.isFinite(wait) && wait >= 1 && wait <= 240 ? { waitMs: Math.floor(wait) * 60_000 } : {}),
  };
}

/** What the mail study's dev route needs of a running brain. */
export function notchStudyDeps(options: {
  manager: Pick<SidecarManager, 'listSidecars' | 'dispatchRPC'>;
  llm: () => LLMManager;
  /** The brain's Google connection as it is now: it can come and go while the brain runs. */
  google: () => GoogleAuth | null;
  /** The mail layer of this brain, once the notch is attached. */
  mail?: NotchStudyDeps['mail'];
}): NotchStudyDeps {
  return {
    browser: () => notchMailBrowser(options.manager),
    tab: () => notchMailTab(options.manager),
    mail: options.mail,
    // Run by the person at their desk: not held behind background work.
    think: (messages, { tier, maxTokens }) => runWithOrigin('user', async () => {
      const answer = await options.llm().chatTier(tier, 'notch_mail_study', messages, { max_tokens: maxTokens, temperature: 0 });
      return {
        content: answer.content,
        model: answer.model,
        input: answer.usage.input_tokens,
        output: answer.usage.output_tokens,
        cached: answer.usage.cache_read_input_tokens ?? 0,
      };
    }),
    calendar: async (from, to) => {
      const google = options.google();
      if (!google?.isAuthenticated()) return null;
      const events = await listUpcomingEvents(await google.getAccessToken(), 'primary', from, to, 500);
      return events.map((event) => ({ summary: event.summary, start: event.start, end: event.end, attendees: event.attendees }));
    },
    log: (line) => console.log(line),
  };
}
