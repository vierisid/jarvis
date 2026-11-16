/**
 * Text a person or a model wrote (a step title, a branch name), cleaned for an
 * accessible name. An aria-label is never drawn, so nothing on screen shows a
 * bidi override or an invisible character in it, and either can make a screen
 * reader say something other than what the canvas shows. Bidi controls,
 * zero-width and tag characters are dropped; control characters and line or
 * paragraph separators become spaces; runs of whitespace become one space.
 * ZWJ and ZWNJ stay: emoji sequences and several scripts need them.
 */
const DROPPED = /[\u00ad\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
const SPACED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g;

export function accessibleText(text: string | null | undefined): string {
  return (text ?? "").replace(DROPPED, "").replace(SPACED, " ").trim();
}
