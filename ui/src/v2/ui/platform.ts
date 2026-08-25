/**
 * What to call the Command/Control key in text the user reads.
 *
 * The shortcuts themselves accept EITHER modifier — AppShell's Talk hotkey is
 * `(e.metaKey || e.ctrlKey) && j`, and the palette's is the same shape — so
 * this is only ever about the label. Which is exactly why it went wrong: a
 * hardcoded ⌘ still worked on Windows for whoever guessed Ctrl, so nothing
 * broke loudly enough to notice, and the onboarding tour taught new Windows
 * users a key their keyboard does not have.
 *
 * Split into PURE functions with the globals read once at the bottom. The
 * obvious shape — a lone `IS_MAC` const and a `modKey` that branches on it —
 * cannot be tested: under `bun test` there is a `navigator`, and its userAgent
 * is "Bun/1.3.14", so `IS_MAC` is frozen false on every host. Any test then
 * derives its expectation from the same constant the code branches on, agrees
 * with itself, and would sail past the one regression that matters — a
 * detection bug that reports Mac everywhere.
 */

/** Does this user-agent (or legacy platform string) describe a Mac? */
export function detectMac(uaOrPlatform: string): boolean {
  return /mac|iphone|ipad/i.test(uaOrPlatform);
}

/** Write a modifier shortcut the way the given platform writes it. */
export function modKeyFor(key: string, isMac: boolean): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

export const IS_MAC =
  typeof navigator !== "undefined" &&
  detectMac(navigator.userAgent || (navigator as { platform?: string }).platform || "");

/** `⌘J` on a Mac, `Ctrl+J` everywhere else. */
export function modKey(key: string): string {
  return modKeyFor(key, IS_MAC);
}
