/**
 * The mail study's dev route (POST /api/notch/study), behind the demo gate.
 *
 * Before the notch proposes anything about mail, a study answers two
 * questions (the plan's Track B): can Gmail be read reliably in Jarvis's own
 * browser, and are the proposals any good. The study is run from a script
 * (scripts/notch/mail-study.ts) against a development brain, and this route
 * is what that script may ask of the brain. It exists only where the demo
 * gate is open: a brain started with its secret, with the notch on, and
 * never a hosted one.
 *
 * What the secret is worth here is more than on the other routes behind it:
 * on a brain whose owner has signed in to Gmail in Jarvis's browser, it reads
 * that mail. So the owner's word is asked before the study is run, and what
 * the study reads is kept in the brain's own data folder.
 *
 * Five things can be asked (the fifth, `watch`, is one look by the mail layer
 * of pass 7 and what it has done so far, as numbers: for checking a build):
 *  - `navigate`: go to an address at mail.google.com, and nowhere else.
 *    (One page script, ./page/site.js, takes the same signed-in browser on
 *    to Google Calendar and Google Drive: a calendar or a file with no
 *    connection behind it is looked for there. ./page.test.ts holds that it
 *    is the only script that leaves a site, and that those are the only two
 *    other places.)
 *  - `run`: run one of the page scripts in ./page, by name. The script is
 *    read from the source folder at that moment, so that it can be corrected
 *    against the real page without restarting the brain. What the caller
 *    hands it travels as data, never as code.
 *  - `think`: one call to the brain's own model, counted under its own name,
 *    so that the study drafts with the model the product would draft with.
 *  - `calendar`: what is in the calendar between two moments, through the
 *    brain's Google connection when there is one. When there is none the
 *    script reads the same calendar in the browser (../ways.ts, ./calendar.ts).
 */
import { evaluateLong, gmailAddress, withoutAddresses, type MailBrowser } from './browser.ts';
import { GOOGLE_SITES, pageScript } from './page.ts';
import type { MailLook, MailLookKind } from './watch.ts';

export interface NotchStudyThought { content: string; model: string; input: number; output: number; cached: number }
export interface NotchStudyMessage { role: 'system' | 'user'; content: string }

export interface NotchStudyEvent { summary: string; start: string; end: string; attendees: string[] }

export interface NotchStudyDeps {
  /** Jarvis's own browser, or null when no desktop app with one is connected. */
  browser(): MailBrowser | null;
  /** One call to the brain's model. */
  think(messages: NotchStudyMessage[], options: { tier: 'low' | 'medium' | 'high'; maxTokens: number }): Promise<NotchStudyThought>;
  /** The calendar between two moments, or null when the brain has no Google connection. */
  calendar(from: string, to: string): Promise<NotchStudyEvent[] | null>;
  /** A page script by name, or null when there is none. Read from the source folder when not given. */
  script?: (name: string) => string | null;
  /** The notch's own tab (pass 7), or null when no desktop app has one. Used when a call says `tab: true`. */
  tab?: () => MailBrowser | null;
  /** The mail layer of this brain (pass 7), or null when it is not running. */
  mail?: () => { look(kind: MailLookKind): Promise<MailLook>; counts(): Record<string, number> } | null;
  log?: (line: string) => void;
}

export interface NotchStudyAnswer { status: number; body: Record<string, unknown> }

const PAGE_SCRIPT = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TIERS = ['low', 'medium', 'high'] as const;
const LOOKS = ['glance', 'recent', 'sweep'] as const;
const SITE_HOSTS = new Set<string>(Object.values(GOOGLE_SITES));

/** An https address at one of the three sites the tab is taken to. */
function googleSiteAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && SITE_HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}
/** The most text one `think` may carry: a long thread and its instructions. */
export const STUDY_THINK_MAX = 120_000;

/** The longest stretch of calendar one question may cover. */
const STUDY_CALENDAR_MAX_MS = 100 * 24 * 60 * 60 * 1000;

function moment(raw: unknown): number | null {
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? at : null;
}

function messagesOf(raw: unknown): NotchStudyMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
  const messages: NotchStudyMessage[] = [];
  let size = 0;
  for (const entry of raw) {
    const message = entry as { role?: unknown; content?: unknown } | null;
    if (!message || (message.role !== 'system' && message.role !== 'user') || typeof message.content !== 'string') return null;
    size += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  return size > 0 && size <= STUDY_THINK_MAX ? messages : null;
}

export async function notchStudyOp(raw: unknown, deps: NotchStudyDeps): Promise<NotchStudyAnswer> {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const op = typeof body.op === 'string' ? body.op : '';
  try {
    if (op === 'think') {
      const messages = messagesOf(body.messages);
      if (!messages) return { status: 400, body: { error: 'Give one to eight system or user messages, as text.' } };
      const tier = TIERS.find((known) => known === body.tier) ?? 'low';
      const asked = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) ? Math.floor(body.max_tokens) : 600;
      const thought = await deps.think(messages, { tier, maxTokens: Math.min(Math.max(asked, 1), 4000) });
      return { status: 200, body: { ...thought } };
    }
    if (op === 'calendar') {
      const from = moment(body.from);
      const to = moment(body.to);
      if (!from || !to || to <= from || to - from > STUDY_CALENDAR_MAX_MS) {
        return { status: 400, body: { error: 'Give a from and a to, as dates, no more than a hundred days apart.' } };
      }
      const events = await deps.calendar(new Date(from).toISOString(), new Date(to).toISOString());
      return { status: 200, body: events ? { connected: true, events } : { connected: false } };
    }
    if (op === 'watch') {
      // One look by the mail layer, now, and what it has done so far: numbers only.
      const mail = deps.mail?.() ?? null;
      if (!mail) return { status: 409, body: { error: 'The mail layer is not running on this brain.' } };
      const kind = LOOKS.find((known) => known === body.kind);
      const look = kind ? await mail.look(kind) : null;
      return { status: 200, body: { look, counts: mail.counts() } };
    }
    if (op !== 'navigate' && op !== 'run') return { status: 400, body: { error: 'Unknown op. One of: navigate, run, think, calendar, watch.' } };

    // `tab: true`: the notch's own tab, as the product uses it, and not the page the agent drives.
    const inTab = body.tab === true;
    const browser = inTab ? deps.tab?.() ?? null : deps.browser();
    if (!browser) return { status: 409, body: { error: inTab ? 'No desktop app with the notch\'s own tab is connected.' : 'No desktop app with a browser is connected.' } };
    if (op === 'navigate') {
      const url = typeof body.url === 'string' ? body.url : '';
      if (inTab) {
        if (!googleSiteAddress(url)) return { status: 400, body: { error: 'Only an address at Gmail, Google Calendar or Google Drive is opened in the tab.' } };
        await browser.navigate(url);
        return { status: 200, body: { ok: true } };
      }
      if (!gmailAddress(url)) return { status: 400, body: { error: 'Only an address at https://mail.google.com/ is opened here.' } };
      // Said only when asked for: naming it closes the browser that is open and starts the other kind.
      await browser.navigate(url, typeof body.headless === 'boolean' ? { headless: body.headless } : undefined);
      return { status: 200, body: { ok: true } };
    }
    const name = typeof body.name === 'string' ? body.name : '';
    const script = PAGE_SCRIPT.test(name) ? (deps.script ?? pageScript)(name) : null;
    if (script === null) return { status: 404, body: { error: 'There is no page script of that name.' } };
    const args = JSON.stringify(body.args ?? null);
    const answer = await evaluateLong(browser, `const args = ${args};\n${script}`);
    return { status: 200, body: { answer } };
  } catch (error) {
    // The reason, never what was on the page nor where the browser was.
    const reason = withoutAddresses(error instanceof Error ? error.message : String(error)).slice(0, 400);
    deps.log?.(`[notch] mail study: ${op} failed: ${reason.slice(0, 200)}`);
    return { status: 502, body: { error: reason } };
  }
}
