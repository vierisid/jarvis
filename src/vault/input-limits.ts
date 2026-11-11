/**
 * The longest text the memory vault takes for an entity name, a fact or a
 * relationship label, and the character rules for text written through the
 * API.
 *
 * The limits follow what Memory shows: a fact's value is capped at 4000 in the
 * Memory room's correct form (and by `FACT_TEXT_LIMIT`), a predicate or subject
 * at 200, and a name is a one-line label in pickers and cards, so it gets the
 * same 200. A relationship label is a short verb phrase ("works_at"), 100.
 * Lengths are UTF-16 units, as `FACT_TEXT_LIMIT`, the task limits and an HTML
 * `maxlength` count them, so a form and the API agree on what fits.
 *
 * The character rules are the ones a task's text is stored under
 * (`commitment-text.ts`, #1036, #1115), so the vault has one: a one-line value
 * refuses every C0 and C1 control, DEL and the line and paragraph separators
 * (`NOT_ONE_LINE`); a block of text may keep tab and line breaks (`NOT_TEXT`);
 * a lone surrogate is not text. Characters that reorder or hide text (the bidi
 * embeddings, overrides and isolates, the LRM, RLM and Arabic letter marks, and
 * stray tag characters) are dropped on save (`withoutHiddenText`). The ZWJ and
 * ZWNJ, the variation selectors and every script's letters are kept: Hebrew,
 * Arabic, Persian, CJK and emoji names are names.
 *
 * Two behaviours, on purpose. The HTTP routes REFUSE (a plain 400, nothing
 * stored): a person or script can fix the input. `createEntity`, `updateEntity`
 * and `createRelationship` are also called from the model (extractor),
 * awareness and profile sync, where refusing would drop or crash a whole turn,
 * so they clean the value instead (`cleanVaultText`). Rows stored before these
 * rules keep their full text and still read back unchanged.
 */
import { NOT_ONE_LINE, NOT_TEXT, withoutHiddenText } from './commitment-text.ts';

export const ENTITY_NAME_MAX_CHARS = 200;
export const RELATIONSHIP_TYPE_MAX_CHARS = 100;
export const FACT_PREDICATE_MAX_CHARS = 200;

/** True when `value` holds a character the rule for its kind refuses. */
export function hasControlCharacters(value: string, multiline = false): boolean {
  return (multiline ? NOT_TEXT : NOT_ONE_LINE).test(value);
}

/** A plain refusal sentence for a value written through the API, or null when it is fine. */
export function refuseVaultText(value: string, label: string, max: number, multiline = false): string | null {
  if (!value.isWellFormed()) return `${label} is not valid text`;
  if (value.length > max) return `${label} must be at most ${max} characters`;
  if (hasControlCharacters(value, multiline)) return `${label} cannot contain control characters`;
  return null;
}

// eslint-disable-next-line no-control-regex
const ONE_LINE_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * For internal writers, and the stored form of what the API accepted: never
 * throws. Well formed, every control or separator a space, the characters that
 * reorder or hide text dropped, then cut at `max` on a code point boundary.
 * A no-op for ordinary text.
 */
export function cleanVaultText(value: string, max: number): string {
  let out = withoutHiddenText(value.toWellFormed().replace(ONE_LINE_BREAKS, ' '));
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}
