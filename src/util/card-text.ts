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
 */
export function forCard(value: unknown, max = 600): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
