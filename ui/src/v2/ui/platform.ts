/**
 * What to call the Command/Control key in text the user reads.
 *
 * The shortcuts themselves accept EITHER modifier — AppShell's Talk hotkey is
 * `(e.metaKey || e.ctrlKey) && j`, and the palette's is the same shape — so
 * this is only ever about the label. Which is exactly why it went wrong: a
 * hardcoded ⌘ still worked on Windows for whoever guessed Ctrl, so nothing
 * broke loudly enough to notice, and the onboarding tour taught new Windows
 * users a key their keyboard does not have.
 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.userAgent || (navigator as { platform?: string }).platform || "");

/**
 * Render a modifier shortcut the way this platform writes it: `⌘J` on a Mac,
 * `Ctrl+J` everywhere else.
 */
export function modKey(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}
