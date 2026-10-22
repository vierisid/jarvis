/**
 * How much longer typing a text may run per character, on top of the bound a
 * desktop tool gets (#895 Linux, #903 macOS and Windows). Typing takes time in
 * proportion to the text, so a flat bound stops a long one part-typed, which
 * leaves the target holding half of it.
 *
 * Measured only on Linux: xdotool types with a 12 ms delay between keys by
 * default, measured as 12.8 ms per character, linear (50, 200 and 800
 * characters: 643, 2559 and 10220 ms, median of 3 each); twice that keeps a
 * slower machine clear of it. Characters outside the keymap, which xdotool
 * types by remapping a spare keycode for each, cost barely more (#895 review;
 * 100 characters, median of 3: e-acute 13.2 ms each, a CJK ideograph 13.3, an
 * emoji 13.3, against 12.9 for "x"). Not measured: a remote X server, where
 * each remap is a network round trip.
 *
 * NOT measured on macOS (System Events `keystroke`) or Windows
 * (SendKeys.SendWait): neither was available. They borrow Linux's rate until
 * someone measures them. The 30 s base bound is kept on top of it, so a
 * typist no slower than 26 ms a character is never cut off, and one twice as
 * slow (52 ms) is cut off at about 1150 characters instead of the flat
 * bound's 577. The allowance only ever moves the cut-off later; it loosens a hang
 * bound, never tightens one.
 */
export const TYPE_MS_PER_CHAR = 26;

/** The extra time typing `text` may take: per character typed, not per UTF-16 unit. */
export function typingAllowanceMs(text: string): number {
  return [...text].length * TYPE_MS_PER_CHAR;
}
