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

export type Desktop = "mac" | "windows" | "other";

/**
 * Classify the host from its user-agent, POSITIVELY — never "not a Mac,
 * therefore Windows".
 *
 * That inference is what this replaces, and it was wrong twice over. The app
 * ships on Linux too, so "not a Mac" named the wrong OS to those users; and a
 * WebKit build on Linux can carry a mac-shaped agent string, so the Linux
 * marker is checked FIRST and wins — better to fall through to copy that names
 * no OS than to hand a Linux user a button that opens an Apple settings pane.
 *
 * A UA is still a guess. The host knows for certain (the sidecar is Go, and
 * `runtime.GOOS` is right there); if this ever needs to be reliable rather than
 * merely careful, that is where the answer should come from.
 */
export function detectDesktop(uaOrPlatform: string): Desktop {
  if (/x11|linux|android|cros/i.test(uaOrPlatform)) return "other";
  if (/mac|iphone|ipad/i.test(uaOrPlatform)) return "mac";
  if (/windows|win32|win64/i.test(uaOrPlatform)) return "windows";
  return "other";
}

/** Does this user-agent (or legacy platform string) describe a Mac? */
export function detectMac(uaOrPlatform: string): boolean {
  return detectDesktop(uaOrPlatform) === "mac";
}

/** Write a modifier shortcut the way the given platform writes it. */
export function modKeyFor(key: string, isMac: boolean): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

const HOST_UA =
  typeof navigator !== "undefined"
    ? navigator.userAgent || (navigator as { platform?: string }).platform || ""
    : "";

/** What this app is running on, as best a user-agent can say. */
export const DESKTOP: Desktop = detectDesktop(HOST_UA);
export const IS_MAC = DESKTOP === "mac";

/**
 * The Option/Alt modifier, which is a DIFFERENT key from the one above — worth
 * its own function rather than a parameter, because the bell's shortcut is
 * `altKey` and reaching for `modKey` there would have written ⌘/Ctrl over a key
 * that is neither.
 */
export function altKeyFor(key: string, isMac: boolean): string {
  return isMac ? `⌥${key}` : `Alt+${key}`;
}

/** `⌥N` on a Mac, `Alt+N` everywhere else. */
export function altKey(key: string): string {
  return altKeyFor(key, IS_MAC);
}

/**
 * The bare Control glyph, for shortcuts written as "<key>+click" rather than as
 * a combination. `⌃` is a Mac keyboard's marking and means nothing on a PC
 * keycap, which just reads "Ctrl".
 */
export function ctrlLabelFor(isMac: boolean): string {
  return isMac ? "⌃" : "Ctrl";
}
export const CTRL_LABEL = ctrlLabelFor(IS_MAC);

/** `⌘J` on a Mac, `Ctrl+J` everywhere else. */
export function modKey(key: string): string {
  return modKeyFor(key, IS_MAC);
}
