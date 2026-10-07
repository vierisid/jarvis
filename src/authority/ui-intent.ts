import type { ToolGate } from '../actions/tools/registry';
import type { ActionCategory } from '../roles/authority';
import { forCard } from '../util/card-text';
import { CONFUSABLE_PROTOTYPES } from './confusables-data';

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
 * since it can only add.
 *
 * A fourth pass reads every one of those readings as its UTS #39 skeleton
 * (#794): a cross-script look-alike -- `Send` with a Cyrillic U+0405 for the
 * S, `Submit` with a Turkish dotless i -- reads as the real word to a person,
 * so it is classified as one. The skeleton is applied to the patterns too
 * (`skeletonPattern`), since it maps some ASCII as well (`m` -> `rn`), and to
 * each reading as written, lower-cased and upper-cased, since the table is
 * case-sensitive and the patterns are not (`I` -> `l`, but `i` -> `i`); each
 * skeleton is folded again too (`allReadings`). The result is the union of
 * this pass and the three before it, so it only ever ADDS a category to what
 * they found; a test pins that. A hint is evidence, not proof, and the card
 * says so.
 */
export function uiEffectHints(action: string, name: string, context: string, value = ''): ActionCategory[] {
  return [...new Set(hintsFrom(action, () => allReadings(name), () => allReadings(context), () => allReadings(value)))];
}

/**
 * The hints without the skeleton pass: what `uiEffectHints` returned before
 * #794. Exported for the test that pins the skeleton pass as additive only.
 */
export function uiEffectHintsWithoutSkeleton(action: string, name: string, context: string, value = ''): ActionCategory[] {
  const plain = (text: string) => () => readings(text).map((t) => ({ text: t, patterns: PATTERNS }));
  return [...new Set(hintsFrom(action, plain(name), plain(context), plain(value)))];
}

/** A reading of a text and the patterns it is matched against. */
type Reading = { text: string; patterns: Patterns };

/**
 * Every reading the classifier judges: the three plain ones (#723), and each
 * of those as a skeleton -- as written and lower-cased against the lower-case
 * skeleton patterns, upper-cased against the upper-case ones -- each also
 * folded (#794 review: a prototype can carry edge punctuation, `'P` for U+01A4,
 * or a combining mark, which the fold removes as it does for the plain text).
 */
function allReadings(text: string): Reading[] {
  const plain = readings(text);
  const out = new Map<string, Reading>();
  const add = (t: string, patterns: Patterns, family: string) => {
    const key = `${family}\u0000${t}`;
    if (!out.has(key)) out.set(key, { text: t, patterns });
  };
  for (const t of plain) add(t, PATTERNS, 'plain');
  // Each distinct case form is skeletonized and folded once (#794 review: on
  // a long text the cost is building readings, not matching them).
  const lowerForms = new Set<string>();
  const upperForms = new Set<string>();
  for (const t of plain) {
    lowerForms.add(t);
    lowerForms.add(t.toLowerCase());
    upperForms.add(t.toUpperCase());
  }
  for (const form of lowerForms) {
    const s = confusableSkeleton(form);
    add(s, SKELETON_PATTERNS, 'lower');
    add(foldedSkeleton(s), SKELETON_PATTERNS, 'lower');
  }
  for (const form of upperForms) {
    const s = confusableSkeleton(form);
    add(s, SKELETON_UPPER_PATTERNS, 'upper');
    add(foldedSkeleton(s), SKELETON_UPPER_PATTERNS, 'upper');
  }
  return [...out.values()];
}

/**
 * A skeleton folded like the plain text, and with its apostrophes dropped:
 * the table writes a hook or a tail as an apostrophe beside the letter
 * (U+01A4 -> `'P`, U+0187 -> `C'`), which a person does not read as one.
 */
function foldedSkeleton(skeleton: string): string {
  return folded(skeleton.replace(/'/g, ''));
}

/**
 * Every reading of the name with every reading of the context and of the keys,
 * each pattern run once per reading rather than once per combination, and a
 * text's readings built only when the action reads it: a click never reads the
 * keys, a key press never reads the name, and the context (a page title, which
 * a hostile page chooses) only once a name or a key could send (#794 review:
 * the readings of a large name, title and value cost more than the patterns).
 * The result is the same set the full product gives, in the same first-seen
 * order.
 */
function hintsFrom(action: string, names: () => Reading[], contexts: () => Reading[], values: () => Reading[]): ActionCategory[] {
  const hints: ActionCategory[] = [];
  if (action === 'click') {
    let mail: boolean[] | null = null;
    for (const n of names()) {
      const text = n.text.trim();
      const p = n.patterns;
      if (p.payment.test(text)) hints.push('make_payment');
      if (p.delete.test(text)) hints.push('delete_data');
      if (p.settings.test(text)) hints.push('modify_settings');
      if (p.send.test(text)) {
        mail ??= contexts().map((c) => c.patterns.mail.test(c.text));
        for (const m of mail) hints.push(m ? 'send_email' : 'send_message');
      }
    }
  }
  if (action === 'press_keys') {
    const keys = values().map((v) => {
      // The upper-case skeleton patterns are upper-case and case-sensitive.
      const k = v.patterns === SKELETON_UPPER_PATTERNS ? v.text : v.text.toLowerCase();
      const p = v.patterns;
      return { plainEnter: p.plainEnter.test(k) && !p.modifier.test(k), chordEnter: p.chordEnter.test(k) };
    });
    if (keys.some((k) => k.plainEnter || k.chordEnter)) {
      for (const c of contexts()) {
        const messaging = c.patterns.messaging.test(c.text);
        const mail = c.patterns.mail.test(c.text);
        for (const k of keys) {
          if (k.plainEnter && messaging) hints.push('send_message');
          if (k.chordEnter && mail) hints.push('send_email');
        }
      }
    }
  }
  return hints;
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

type Patterns = {
  payment: RegExp; delete: RegExp; settings: RegExp; send: RegExp; mail: RegExp; messaging: RegExp;
  plainEnter: RegExp; chordEnter: RegExp; modifier: RegExp;
};

const PATTERNS: Patterns = {
  payment: PAYMENT_RE, delete: DELETE_RE, settings: SETTINGS_RE, send: SEND_RE,
  mail: MAIL_CONTEXT, messaging: MESSAGING_CONTEXT,
  plainEnter: /(^|\+|\s)(enter|return)$/, chordEnter: /(ctrl|cmd|meta)\+(enter|return)$/, modifier: /ctrl|cmd|meta|alt/,
};

/** One code point to its prototype (`confusables-data.ts`). */
const PROTOTYPE = new Map<string, string>(CONFUSABLE_PROTOTYPES);

/**
 * The UTS #39 skeleton: NFD, each code point replaced by its prototype, NFD
 * again, over the full MA table (`confusables-data.ts`).
 */
export function confusableSkeleton(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFD')) out += PROTOTYPE.get(ch) ?? ch;
  return out.normalize('NFD');
}

/**
 * Constructs `skeletonPattern` would misread if a pattern ever used them: a
 * character class (`[m]` would become `[rn]`), braces (`\p{L}`, `{2}`), group
 * syntax (`(?<name>`), and escapes that carry letters (`\cM`, `\k`, `\u`,
 * `\x`, `\p`). Checked at load, so a new pattern fails loudly rather than
 * silently matching nothing.
 */
const UNREWRITABLE = /\[|\{|\(\?|\\[cCkKuUxXpP]/;

/**
 * A pattern with its literal letters replaced by their skeleton, so it matches
 * the skeleton of the words it matched (`submit` -> `subrnit`, `\bmail\b` ->
 * `\brnail\b`). `lower` maps each letter's lower case and keeps the flags, for
 * readings as written and lower-cased; upper maps each letter's upper case
 * (`I` -> `l`, `M` -> `M`) and drops `i`, for readings upper-cased, so an
 * all-capitals look-alike (`SUBMIT` with a Greek capital Mu) is read in the
 * case it is written in (#794 review). Only letters outside an escape are
 * rewritten.
 */
export function skeletonPattern(re: RegExp, upper: boolean): RegExp {
  if (UNREWRITABLE.test(re.source)) throw new Error(`ui-intent: pattern ${re.source} uses syntax the skeleton rewrite cannot handle`);
  if (!re.flags.includes('i') && /(^|[^\\])[A-Z]/.test(re.source)) {
    throw new Error(`ui-intent: case-sensitive pattern ${re.source} has upper-case letters the skeleton rewrite would change`);
  }
  let source = '';
  for (let i = 0; i < re.source.length; i++) {
    const ch = re.source[i]!;
    if (ch === '\\') { source += ch + (re.source[i + 1] ?? ''); i++; continue; }
    if (/[A-Za-z]/.test(ch)) {
      source += confusableSkeleton(upper ? ch.toUpperCase() : ch.toLowerCase()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    source += ch;
  }
  return new RegExp(source, upper ? re.flags.replace('i', '') : re.flags);
}

function skeletonPatterns(upper: boolean): Patterns {
  return Object.fromEntries(Object.entries(PATTERNS).map(([key, re]) => [key, skeletonPattern(re, upper)])) as Patterns;
}

const SKELETON_PATTERNS = skeletonPatterns(false);
const SKELETON_UPPER_PATTERNS = skeletonPatterns(true);

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
