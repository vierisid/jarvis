/**
 * Coverage for `JarvisTelegramConnectionSource`. Mirrors the shape of the
 * google-source tests: canResolve predicate + resolve happy/null paths.
 */

import { describe, expect, test } from "bun:test";
import { JarvisTelegramConnectionSource, JARVIS_TELEGRAM_PREFIX } from "./telegram-source";

describe("JarvisTelegramConnectionSource", () => {
  test("canResolve matches jarvis:telegram and any jarvis:telegram:<sub>", () => {
    const src = new JarvisTelegramConnectionSource(() => "abc");
    expect(src.canResolve(JARVIS_TELEGRAM_PREFIX)).toBe(true);
    expect(src.canResolve(`${JARVIS_TELEGRAM_PREFIX}:bot_a`)).toBe(true);
    expect(src.canResolve("jarvis:google")).toBe(false);
    expect(src.canResolve("custom-id")).toBe(false);
  });

  test("resolve returns the token wrapped as SECRET_TEXT when configured", async () => {
    const src = new JarvisTelegramConnectionSource(() => "12345:abcdef");
    const out = await src.resolve(JARVIS_TELEGRAM_PREFIX);
    expect(out).toEqual({
      type: "SECRET_TEXT",
      value: { value: "12345:abcdef" },
    });
  });

  test("resolve returns null when no token is configured", async () => {
    const src = new JarvisTelegramConnectionSource(() => null);
    expect(await src.resolve(JARVIS_TELEGRAM_PREFIX)).toBeNull();
  });

  test("resolve returns null when the token is empty string", async () => {
    const src = new JarvisTelegramConnectionSource(() => "");
    expect(await src.resolve(JARVIS_TELEGRAM_PREFIX)).toBeNull();
  });

  test("token closure reads live (rotation is picked up without rebuilding the source)", async () => {
    let current: string | null = "old-token";
    const src = new JarvisTelegramConnectionSource(() => current);
    const first = await src.resolve(JARVIS_TELEGRAM_PREFIX);
    expect((first?.value as { value?: string } | undefined)?.value).toBe("old-token");
    current = "rotated-token";
    const second = await src.resolve(JARVIS_TELEGRAM_PREFIX);
    expect((second?.value as { value?: string } | undefined)?.value).toBe("rotated-token");
  });
});
