import { describe, expect, test } from "bun:test";
import { altKeyFor, ctrlLabelFor, detectDesktop, detectMac, modKeyFor } from "./platform";

/**
 * The onboarding tour told every Windows user to press a key their keyboard
 * does not have. It survived because the BINDING accepts either modifier
 * (AppShell: `metaKey || ctrlKey`), so the wrong label still worked for anyone
 * who guessed Ctrl — nothing failed loudly enough to notice.
 *
 * Asserted against real user-agent strings rather than the module's own
 * `IS_MAC`. Under `bun test` navigator.userAgent is "Bun/1.3.14", so `IS_MAC`
 * is false on every host including a Mac: a test written against it agrees with
 * whatever the implementation decided and never executes the ⌘ branch at all.
 */
const MAC_WEBVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("detectMac", () => {
  test("recognises the hosts this app actually runs in", () => {
    expect(detectMac(MAC_WEBVIEW)).toBe(true);
    expect(detectMac(WINDOWS_WEBVIEW2)).toBe(false);
    expect(detectMac(LINUX)).toBe(false);
  });

  test("an empty or unknown agent is NOT a Mac", () => {
    // The regression this exists for: a stray alternation (/mac|ipad|/i) makes
    // the pattern match everything, IS_MAC becomes true on every platform, and
    // Windows silently gets ⌘ back. A test keyed on IS_MAC cannot see that;
    // this one fails immediately.
    expect(detectMac("")).toBe(false);
    expect(detectMac("Bun/1.3.14")).toBe(false);
  });
});

describe("detectDesktop", () => {
  test("names an OS only when it can positively identify one", () => {
    expect(detectDesktop(MAC_WEBVIEW)).toBe("mac");
    expect(detectDesktop(WINDOWS_WEBVIEW2)).toBe("windows");
    expect(detectDesktop(LINUX)).toBe("other");
    // Unknown is "other", never Windows by elimination — the screen that names
    // an OS has to be sure, or it tells a Linux user about Windows settings.
    expect(detectDesktop("")).toBe("other");
    expect(detectDesktop("Bun/1.3.14")).toBe("other");
  });

  test("a Linux marker beats a mac-shaped agent string", () => {
    // Some WebKit builds on Linux carry a macOS-looking UA. Falling through to
    // OS-neutral copy is recoverable; handing a Linux user a button that opens
    // an Apple settings pane is the exact failure this file exists to stop.
    expect(detectDesktop("Mozilla/5.0 (X11; Linux x86_64) ... Macintosh; Intel Mac OS X 10_15")).toBe("other");
  });
});

describe("modKeyFor", () => {
  test("both branches, neither inferred from the running platform", () => {
    expect(modKeyFor("J", true)).toBe("⌘J");
    expect(modKeyFor("J", false)).toBe("Ctrl+J");
    expect(modKeyFor("K", false)).not.toContain("⌘");
  });
});

describe("the other two modifiers", () => {
  test("Option/Alt is its own key, not Command/Control", () => {
    // The notifications bell binds `altKey`; labelling it with modKey would
    // have written ⌘/Ctrl over a key that is neither.
    expect(altKeyFor("N", true)).toBe("⌥N");
    expect(altKeyFor("N", false)).toBe("Alt+N");
  });

  test("the bare Control glyph is a Mac keycap marking", () => {
    expect(ctrlLabelFor(true)).toBe("⌃");
    expect(ctrlLabelFor(false)).toBe("Ctrl");
  });
});
