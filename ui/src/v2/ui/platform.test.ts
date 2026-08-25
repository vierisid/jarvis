import { describe, expect, test } from "bun:test";
import { IS_MAC, modKey } from "./platform";

/**
 * The onboarding tour told every Windows user to press a key their keyboard
 * does not have. It survived because the BINDING accepts either modifier
 * (AppShell: `metaKey || ctrlKey`), so the wrong label still worked for anyone
 * who guessed Ctrl — nothing failed loudly enough to notice.
 */
describe("modKey", () => {
  test("writes the modifier the way this platform writes it", () => {
    expect(modKey("J")).toBe(IS_MAC ? "\u2318J" : "Ctrl+J");
  });

  test("never shows the Mac glyph off a Mac", () => {
    if (IS_MAC) return;
    expect(modKey("K")).not.toContain("\u2318");
    expect(modKey("K")).toBe("Ctrl+K");
  });
});
