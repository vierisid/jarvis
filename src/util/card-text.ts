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
 */
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

export function forCard(value: unknown, max = 600): string {
  const s = String(value ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
