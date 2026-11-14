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
import type { MailBrowser } from '../notch/mail/browser.ts';
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

/** What the mail study's dev route needs of a running brain. */
export function notchStudyDeps(options: {
  manager: Pick<SidecarManager, 'listSidecars' | 'dispatchRPC'>;
  llm: () => LLMManager;
  /** The brain's Google connection as it is now: it can come and go while the brain runs. */
  google: () => GoogleAuth | null;
}): NotchStudyDeps {
  return {
    browser: () => notchMailBrowser(options.manager),
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
