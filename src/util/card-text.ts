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
 * The set is every Default_Ignorable_Code_Point (#659 review), not the short
 * list it used to be: that list missed the combining grapheme joiner, the
 * variation selectors, the tag characters and the Hangul fillers, so `no\u034Ftes`
 * read as `notes` and a name of fillers rendered blank. It is the same property
 * `roles/untrusted.ts`'s IGNORABLE strips; the cost is cosmetic (a ZWJ emoji
 * sequence shows as its separate glyphs).
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Control characters, dropped for the same reason (#659): raw C0 (other than
 * tab, newline and carriage return, which the whitespace collapse turns into a
 * space), DEL and C1. A name of `\u0001\u0001` survived the collapse non-empty
 * and rendered as nothing, and a `\u001b` sequence rendered as terminal junk.
 * With INVISIBLE above, this is exactly the set `roles/untrusted.ts`'s
 * IGNORABLE strips. #656 added it to `ui_act`'s gate alone; every other caller
 * here had the same hole.
 */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function forCard(value: unknown, max = 600): string {
  const s = String(value ?? '').replace(INVISIBLE, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
