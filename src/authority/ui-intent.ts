import type { ToolGate } from '../actions/tools/registry';
import type { ActionCategory } from '../roles/authority';
import { forCard } from '../util/card-text';

// UI text is untrusted evidence, not a capability declaration. These hints
// may add a policy check; neither a matching label nor an absent match proves
// what an arbitrary page's event handler does.
const MAIL_CONTEXT = /gmail|outlook|\bmail\b|mail\.|proton|thunderbird|yahoo|fastmail|hey\.com/i;
const MESSAGING_CONTEXT = /slack|teams|discord|whatsapp|telegram|messenger|signal|imessage|\bsms\b|\bchat\b|linkedin|twitter|x\.com|bluesky|mastodon|reddit/i;
const PAYMENT_RE = /\b(pay|pay now|purchase|buy|buy now|checkout|check out|place (your )?order|confirm (payment|purchase|order)|subscribe|complete (purchase|order|payment))\b/i;
const DELETE_RE = /\b(delete|remove|trash|erase|discard|uninstall|permanently|empty (bin|trash))\b/i;
const SEND_RE = /^(send|send (now|email|mail|message|it|reply)|reply|reply all|forward|post|publish|submit|tweet|share)$/i;
const SETTINGS_RE = /^(save (settings|changes|preferences)|apply|grant|allow access|change password|update (settings|permissions))$/i;

/**
 * What a UI action may do beyond controlling the app, judged on the text as it
 * IS and as it LOOKS, and the union taken (#723).
 *
 * The anchored patterns below used to see only the raw accessible name, while
 * the card shows a reduced one (`forCard`: ignorables and controls dropped,
 * whitespace collapsed). The two disagreed: `Se<ZWSP>nd` or `Send  now` got no
 * send category, so a deny or approval rule on `send_email` was skipped, while
 * the card said `click Send`. The classification is the half with authority,
 * so it now also reads the reduction the person reads -- uncapped, so a long
 * label cannot drop a raise by being cut -- and keeps every category either
 * reading reaches. A disguised label is classified by what it looks like as
 * well as what it is; the union can only add a check, never remove one.
 *
 * Every reading of the name is paired with every reading of the context and
 * of the keys (#723 review): a send label that matches only once reduced, in
 * an app whose title matches "mail" only as written (`x<SHY>mail` reduces to
 * `xmail`), must still be a send_email. The raw-with-raw pairing is among them,
 * so the result always contains what the raw-only classifier returned.
 *
 * A third reading is for classification only and never shown: compatibility
 * forms decomposed (NFKD: `Send` in fullwidth letters, accents), marks and
 * every format character dropped (`forCard` keeps the format characters outside
 * Default_Ignorable), the Braille blank read as a space, and punctuation
 * trimmed from both ends (`Send.`, `Send...`). It is deliberately aggressive,
 * since it can only add. What NO reading covers is a cross-script look-alike
 * (`Send` with a Cyrillic U+0405 for the S): folding confusables needs a
 * UTS #39 skeleton table, which this does not carry. A hint is evidence, not proof, and the card says so.
 */
export function uiEffectHints(action: string, name: string, context: string, value = ''): ActionCategory[] {
  const hints = new Set<ActionCategory>();
  const names = readings(name);
  const contexts = readings(context);
  const values = readings(value);
  for (const n of names) {
    for (const c of contexts) {
      for (const v of values) for (const h of rawEffectHints(action, n, c, v)) hints.add(h);
    }
  }
  return [...hints];
}

/** The text as written, as a reviewer reads it (`forCard`, uncapped), and folded for matching. */
function readings(text: string): string[] {
  const shown = forCard(text, Number.POSITIVE_INFINITY);
  return [...new Set([text, shown, folded(shown)])];
}

function folded(text: string): string {
  const collapsed = text.normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/\u2800/gu, ' ')
    .replace(/\s+/gu, ' ');
  return trimToLettersAndDigits(collapsed);
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Punctuation off both ends, by a scan from each end rather than an anchored
 * regex (#723 review): `/[^\p{L}\p{N}]+$/` retries from every start
 * position, so a long run of non-letters between letters -- a page title of
 * dashes, which a hostile page chooses -- took 2.3 s for one call at 80k
 * characters, inside an authority gate on the daemon's only thread. This is
 * linear: a click and a key press over an 80k-character title measured 6.8 s
 * before and 2 ms after.
 */
function trimToLettersAndDigits(text: string): string {
  const units = [...text];
  let start = 0;
  let end = units.length;
  while (start < end && !LETTER_OR_DIGIT.test(units[start]!)) start++;
  while (end > start && !LETTER_OR_DIGIT.test(units[end - 1]!)) end--;
  return units.slice(start, end).join('');
}

function rawEffectHints(action: string, name: string, context: string, value: string): ActionCategory[] {
  const hints: ActionCategory[] = [];
  if (action === 'click') {
    const n = name.trim();
    if (PAYMENT_RE.test(n)) hints.push('make_payment');
    if (DELETE_RE.test(n)) hints.push('delete_data');
    if (SETTINGS_RE.test(n)) hints.push('modify_settings');
    if (SEND_RE.test(n)) hints.push(MAIL_CONTEXT.test(context) ? 'send_email' : 'send_message');
  }
  if (action === 'press_keys') {
    const keys = value.toLowerCase();
    const plainEnter = /(^|\+|\s)(enter|return)$/.test(keys) && !/ctrl|cmd|meta|alt/.test(keys);
    const chordEnter = /(ctrl|cmd|meta)\+(enter|return)$/.test(keys);
    if (plainEnter && MESSAGING_CONTEXT.test(context)) hints.push('send_message');
    if (chordEnter && MAIL_CONTEXT.test(context)) hints.push('send_email');
  }
  return hints;
}

// Applies by tool identity, including createBrowserTools' isolated controller
// and tools exposed to sub-agents. A model-supplied intent/effect never opts a
// raw action out. Screenshots and snapshots remain available without a card.
export const REVIEWED_UI_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press_key',
  'browser_upload_file', 'browser_hover', 'browser_scroll', 'browser_evaluate',
  'desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app',
  'desktop_focus_window', 'ui_act',
]);

export function rawUiGate(toolName: string, params: Record<string, unknown>): ToolGate | null {
  if (!REVIEWED_UI_TOOLS.has(toolName)) return null;
  if (toolName === 'ui_act' && params.action === 'get_value') return null;
  // Arguments are already present on the approval card. Do not duplicate
  // typed text, file contents or arbitrary expressions in the intent/logs.
  const element = typeof params.element_id === 'number' ? ` on element [${params.element_id}]` : '';
  return {
    actionCategory: 'control_app',
    intent: `Review ${toolName}${element}. Business effect unknown: this UI action may send, submit, delete or change data. Check the current screen and the exact arguments before approving; prefer a typed connector for a known business action.`,
    confirm: 'always',
  };
}
