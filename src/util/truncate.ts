/**
 * Cut text to at most `maxChars` UTF-16 code units and say how long it was.
 *
 * `slice(0, n)` counts code units, so a cut at n can land between the two
 * halves of a surrogate pair (any emoji, most CJK extension characters) and
 * leave a lone high surrogate at the end. That string is not well-formed
 * Unicode: it has no UTF-8 encoding, and once JSON-encoded for a provider it
 * is an escaped lone surrogate a strict parser refuses. The framed tool path
 * already repairs this (`toWellFormed` in roles/untrusted.ts); the unframed
 * one, which most tools take, did not.
 *
 * So the cut backs off one code unit rather than split a pair, and the kept
 * text is made well-formed, which also repairs a lone surrogate the input
 * carried. Text within the budget is returned whole, made well-formed too: a
 * lone surrogate the tool itself emitted fails the provider the same way.
 */
export function truncateWithNote(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.toWellFormed();
  return truncateHead(text, maxChars) + `\n... (truncated, was ${text.length} chars)`;
}

/** The first `maxChars` code units of `text`, never ending inside a pair, well-formed. */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.toWellFormed();
  let end = Math.max(0, maxChars);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).toWellFormed();
}
