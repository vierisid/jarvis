/**
 * The rules a task's text is stored under (#1036, #1115), shared by every
 * writer: the dashboard's create and patch validate against them and refuse
 * (daemon/commitment-patch.ts), and `createCommitment` holds every other
 * writer -- work items, goal check-ins, the commitments tool, the extractor,
 * delegation and the chat's auto-created task -- to one well-formed line
 * (`oneLineTaskText`). Kept in the vault so the vault does not import the
 * daemon.
 */

/**
 * Length bounds on what the dashboard may store in a task (#1036).
 *
 * Measured on a real vault (41 tasks, from chat extraction, goal check-ins,
 * the model and the dashboard): the longest `what` was 112 characters, the
 * longest `context` 27 and the longest `assigned_to` 6. The bounds are well
 * clear of that. A task's text has to fit an approval card sentence
 * (`forCard` caps a value at 600); `context` takes the bound the goals routes
 * already put on a goal's description (`goals/validation.ts` `text`).
 */
export const COMMITMENT_WHAT_MAX_CHARS = 500;
export const COMMITMENT_ASSIGNEE_MAX_CHARS = 100;
export const COMMITMENT_CONTEXT_MAX_CHARS = 20_000;

/**
 * What ends a line for something reading the text, not only `\n`: every C0
 * control (the line breaks with them; a tab is made a space first), DEL, every C1 control (NEL,
 * U+0085, is a line break) and the Unicode line and paragraph separators.
 */
// eslint-disable-next-line no-control-regex
export const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The same, less the tab and the line breaks a block of text may hold. */
// eslint-disable-next-line no-control-regex
export const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Characters that reorder or hide text, dropped on save (#1036): the bidi
 * embeddings, overrides and isolates, the LRM, RLM and Arabic letter marks,
 * and the tag characters, which spell ASCII nobody sees. They change what
 * the model reads without changing what a person sees.
 *
 * NOT the wider set an approval card drops (`withoutCardInvisibles`): that
 * is fine for a card, which is shown once, but stored text is the user's,
 * and it would change it. The ZWNJ (U+200C) and ZWJ (U+200D) spell Persian,
 * Malayalam and the other scripts that need them, and join emoji sequences;
 * the variation selectors U+FE00-FE0F pick emoji or text presentation and
 * make keycaps (the #859 carve-out keeps U+FE0E and U+FE0F for the same
 * reason); a soft hyphen is a hyphenation point. They are kept.
 */
const REORDERS_OR_HIDES = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * An emoji tag sequence (UTS #51): the black flag, a subdivision code of
 * lower-case tag letters and tag digits, and CANCEL TAG, as in the England,
 * Scotland and Wales flags. Its tags are kept; any other tag character is
 * dropped, including upper case or spaces between a flag and its CANCEL TAG,
 * which no flag uses and which is how hidden ASCII would hide inside one.
 */
const TAGS = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}|[\u{E0000}-\u{E007F}]/gu;

export function withoutHiddenText(value: string): string {
  return value.replace(REORDERS_OR_HIDES, '').replace(TAGS, (match) => (match.startsWith('\u{1F3F4}') ? match : ''));
}

/**
 * `text` cut to at most `max` UTF-16 units on a code point boundary, ending in
 * "..." when it was cut. Never splits a surrogate pair, which `slice` does: a
 * lone surrogate is not text, and SQLite stores it as a broken code point
 * that swallows the character after it.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 3) return '';
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 3) break;
    out += ch;
  }
  return out.trimEnd() + '...';
}

/** Every run of characters that ends a line or controls the terminal. */
// eslint-disable-next-line no-control-regex
const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * A task's text as `createCommitment` stores it, from any writer (#1115): well
 * formed (a lone surrogate becomes U+FFFD), on one line (every run of control
 * characters and line or paragraph separators becomes one space), with the
 * characters that reorder or hide text dropped, trimmed, and at most
 * COMMITMENT_WHAT_MAX_CHARS long. Null when nothing is left.
 *
 * Normalised, not refused, because the writers it reaches are not a person at
 * a form: a goal check-in or an extraction that failed on a line break in a
 * model's title would lose the task. The dashboard, where a person is
 * typing, still refuses (daemon/commitment-patch.ts), so this is a no-op for
 * anything it accepted.
 */
export function oneLineTaskText(input: string): string | null {
  const text = withoutHiddenText(input.toWellFormed().replace(LINE_BREAKS_AND_CONTROLS, ' ')).trim();
  if (text === '') return null;
  return truncateText(text, COMMITMENT_WHAT_MAX_CHARS);
}

/**
 * One task as the system prompt lists it (agent-service and the background
 * agent): its text JSON-encoded (#1115), so a task called "pay rent -- completed"
 * cannot read as a finished task in every turn's prompt.
 */
export function commitmentPromptLine(c: { priority: string; what: string; when_due: number | null; status: string }): string {
  const due = c.when_due ? ` (due: ${new Date(c.when_due).toLocaleString()})` : '';
  return `[${c.priority}] ${JSON.stringify(c.what)}${due} \u2014 ${c.status}`;
}
