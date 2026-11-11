/**
 * The longest text the memory vault takes for an entity name, a fact or a
 * relationship label, and the control-character rule for text written through
 * the API.
 *
 * The limits follow what Memory shows: a fact's value is capped at 4000 in the
 * Memory room's correct form (and by `FACT_TEXT_LIMIT`), a predicate or subject
 * at 200, and a name is a one-line label in pickers and cards, so it gets the
 * same 200. A relationship label is a short verb phrase ("works_at"), 100.
 *
 * Two behaviours, on purpose. The HTTP routes REFUSE (a plain 400, nothing
 * stored): a person or script can fix the input. `createEntity` and
 * `createRelationship` are also called from the model (extractor), awareness
 * and profile sync, where refusing would drop or crash a whole turn, so they
 * clean the value instead: control characters become spaces and an over-long
 * value is cut at the limit. Rows stored before these limits keep their full
 * text and still read back unchanged.
 */
export const ENTITY_NAME_MAX_CHARS = 200;
export const RELATIONSHIP_TYPE_MAX_CHARS = 100;

/** C0 controls and DEL. Tab and line breaks are allowed only where `multiline`. */
const CONTROLS_SINGLE_LINE = /[\x00-\x1f\x7f]/;
const CONTROLS_MULTI_LINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function hasControlCharacters(value: string, multiline = false): boolean {
  return (multiline ? CONTROLS_MULTI_LINE : CONTROLS_SINGLE_LINE).test(value);
}

/** A plain refusal sentence for a value written through the API, or null when it is fine. */
export function refuseVaultText(value: string, label: string, max: number, multiline = false): string | null {
  if (value.length > max) return `${label} must be at most ${max} characters`;
  if (hasControlCharacters(value, multiline)) return `${label} cannot contain control characters`;
  return null;
}

/** For internal writers: never throws. Controls become spaces, then the value is cut at `max`. */
export function cleanVaultText(value: string, max: number): string {
  let out = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}
