/**
 * One model-supplied value for an approval card's sentence.
 *
 * The card renders the intent sentence and nothing else, so this string IS
 * the review. Whitespace is collapsed so a newline cannot push the real verb
 * out of view, and the value is capped so it cannot run on past the sentence
 * and append reassuring prose. Put the interesting free-text value LAST in the
 * sentence, with a budget big enough to show all of it: there is then nothing
 * after it to impersonate. A value in the middle of a sentence wants a short
 * cap, since that is the one that can forge an ending.
 *
 * Invisible formatting characters are dropped as well as collapsed whitespace,
 * because they reorder what the reader sees without changing the string.
 * `cv‮gpj.exe` renders as `cvexe.jpg`: a right-to-left override survives a
 * whitespace collapse and a length cap untouched, so a value the model chose --
 * a filename it wrote, say -- could make the card say something other than what
 * is being approved. Removed, not escaped: a card is prose for a person, and
 * there is no legitimate path or label that needs a bidi control in it.
 *
 * The set is the UNION of every format character (`\p{Cf}`) and every
 * Default_Ignorable_Code_Point, because neither contains the other. #659 review
 * widened it from a short list to Default_Ignorable: that list missed the
 * combining grapheme joiner, the variation selectors, the tag characters and
 * the Hangul fillers, so `no\u034Ftes` read as `notes` and a name of fillers
 * rendered blank. Default_Ignorable alone still missed 32 format characters
 * (#838): the Arabic number signs U+0600..U+0605, U+06DD and U+08E2, the
 * Syriac abbreviation mark U+070F, U+0890..U+0891, the interlinear annotation
 * controls U+FFF9..U+FFFB, U+110BD, U+110CD and the Egyptian hieroglyph format
 * controls U+13430..U+1343F. The log helpers (`inlineUntrusted`,
 * `logSafePath`) strip the union since #763, so the surface a person reads to
 * decide an approval was sanitising LESS than a log line. It is the same set
 * `roles/untrusted.ts`'s IGNORABLE looks through, plus its controls below. The
 * cost is mostly cosmetic (a ZWJ emoji sequence shows as its separate glyphs;
 * an Arabic number sign no longer spans the digits after it). One part is
 * not: 13 of the 32 (the prepended concatenation marks, U+0600..U+0605,
 * U+06DD, U+070F, U+0890..U+0891, U+08E2, U+110BD, U+110CD) draw a visible
 * sign, so a name holding one now reads the same on a card as the name
 * without it, as names split by an invisible always did. Flagging any
 * reduction on the card, rather than only making it, is a separate design
 * question (#807 left it open).
 *
 * WHAT #838 MOVED: a card sentence whose value held one of the 32 now reads
 * without it. An approval of such a sentence pending across the upgrade is
 * refused when it runs ("what it would do changed after approval", the
 * deferred executor's recomputed-sentence check) and has to be asked again.
 * Text without them is unchanged.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Control characters, dropped for the same reason (#659): raw C0 (other than
 * tab, newline and carriage return, which the whitespace collapse turns into a
 * space), DEL and C1. A name of `\u0001\u0001` survived the collapse non-empty
 * and rendered as nothing, and a `\u001b` sequence rendered as terminal junk.
 * With INVISIBLE above, this is exactly the set `roles/untrusted.ts`'s
 * IGNORABLE looks through (#838 widened both to the same union). #656 added it to `ui_act`'s gate alone; every other caller
 * here had the same hole.
 */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function forCard(value: unknown, max = 600): string {
  const s = String(value ?? '').replace(INVISIBLE, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * The characters a command may be shown verbatim in: printable ASCII and the
 * space, nothing else (#707 review). Not a denylist of hidden characters,
 * because what misleads a reviewer is wider than what is invisible: a no-break
 * space renders as a space but is a word character to sh, so `ls<NBSP>#<NBSP>x;
 * curl ... | sh` reads as a comment and runs the curl; curly quotes look like
 * quoting and quote nothing; homoglyphs, combining marks, strong right-to-left
 * letters and the format characters outside Default_Ignorable all change how
 * a line reads. Every one of them is outside this set.
 */
const COMMAND_PLAIN = /^[\x20-\x7e]*$/;
/** One UTF-16 unit outside the plain set (no `u` flag: astral characters escape as their surrogate pair). */
const COMMAND_NOT_PLAIN_UNIT = /[^\x20-\x7e]/g;

/**
 * A value as ONE quoted, escaped string literal: `JSON.stringify`, then a
 * `\uXXXX` escape for every UTF-16 unit still outside printable ASCII. Every
 * escape is valid JSON, so the literal decodes to exactly the value; nothing
 * is dropped, collapsed or cut; and an inner `"` is escaped, so the value
 * cannot close its own literal and forge the rest of the sentence. For a
 * model-supplied value in the MIDDLE of a sentence that must still be shown
 * whole: a working directory or a sidecar name in front of a command (#720).
 */
export function escapedLiteralForCard(value: unknown): string {
  return JSON.stringify(String(value ?? '')).replace(COMMAND_NOT_PLAIN_UNIT,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * The tail of a shell command's approval card: the command itself, never
 * reduced (#707; moved here from `sites/builder-tools.ts` by #720 so the
 * builtin `run_command` card and `site_run_command`'s are the same text).
 *
 * A card for a label can afford `forCard`; a card for a command cannot, because
 * the thing being approved IS the text. Collapsing a line break let a second
 * line read as part of a `#` comment on the first (`ls # tidy up` then
 * `curl ... | sh` rendered as one inert line), and a length cap showed a prefix
 * of a command the shell then ran in full. Both made the card something other
 * than what the person agreed to.
 *
 * So, no cap, and nothing dropped or collapsed:
 *   - a command made only of printable ASCII is shown verbatim;
 *   - anything else is shown as ONE escaped string (`escapedLiteralForCard`)
 *     after trusted words that say how many lines it has.
 *
 * Why this keeps the argument of `forCard`'s docblock rather than overturning
 * it. Its two worries about a long value were prose appended after the real
 * sentence and newlines pushing the real verb out of view. The command goes
 * LAST in its sentence, and no line break reaches the card raw in either form.
 * (The joined `intent` field appends the Authority engine's reason in
 * parentheses after a gate's sentence -- `formatApprovalIntent` -- so there
 * something does follow it. Since #792 no approval surface renders that joined
 * string: each shows the reason in an element of its own, the channel card on
 * its own `Reason:` line, and the toast after the impact.) Its other point -- that cutting the command is the WORSE
 * failure, because an injected payload is unlikely to be in the first few
 * words -- is what having no budget honours. A command too long to read is a
 * card to deny; a card showing less than will run cannot be judged at all. Nor
 * is the size a new exposure: the same approval broadcast already carries the
 * whole command in `tool_arguments`.
 *
 * `trim` follows the caller's `execute`: `site_run_command` trims before
 * `sh -c`, so its card does; `run_command` hands the command over untrimmed,
 * so its card shows the outer whitespace too (a trailing newline makes it a
 * two-line command, because that is what the shell receives).
 */
export function commandForCard(value: unknown, { trim = true }: { trim?: boolean } = {}): string {
  const raw = String(value ?? '');
  const command = trim ? raw.trim() : raw;
  if (COMMAND_PLAIN.test(command)) return `run: ${command}`;
  const lines = command.split('\n').length;
  const legend = [lines > 1 ? '\\n is a new line' : '', /[^\x20-\x7e\n\r\t\b\f]/.test(command) ? '\\uXXXX is a character by its code' : '']
    .filter(Boolean).join(', ');
  return `run this ${lines > 1 ? `${lines}-line ` : ''}command, as an escaped string${legend ? ` (${legend})` : ''}: ${escapedLiteralForCard(command)}`;
}
