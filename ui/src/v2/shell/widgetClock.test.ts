import { describe, expect, test } from "bun:test";
import { WIDGET_CLOCK_STEP_MS, widgetClock } from "./widgetClock";

/**
 * The Now-room widgets that name a time range fetch on `[url]`. If the URL
 * moves on every render the effect re-runs on every render, and since the
 * effect's own response triggers a render that is an unbounded fetch loop
 * against the founder's daemon. Fifty requests a second, measured.
 */
describe("widgetClock", () => {
  test("does not move between renders inside the same minute", () => {
    const t = 1_787_750_000_000;
    const first = widgetClock(t);
    // A handful of renders, milliseconds apart, as a poll response lands.
    expect(widgetClock(t + 1)).toBe(first);
    expect(widgetClock(t + 17)).toBe(first);
    expect(widgetClock(t + 999)).toBe(first);
  });

  test("the URL a widget builds from it is byte-identical across renders", () => {
    const t = 1_787_750_000_000;
    const url = (now: number) =>
      `/api/calendar?range_start=${now}&range_end=${now + 7 * 86_400_000}`;
    expect(url(widgetClock(t + 3))).toBe(url(widgetClock(t + 812)));
  });

  test("still moves, so a window pinned to it does not go stale", () => {
    const t = 1_787_750_000_000;
    expect(widgetClock(t + WIDGET_CLOCK_STEP_MS)).toBeGreaterThan(widgetClock(t));
  });

  test("lands on the step, never between two of them", () => {
    for (const t of [0, 1, 59_999, 60_000, 1_787_750_123_456]) {
      expect(widgetClock(t) % WIDGET_CLOCK_STEP_MS).toBe(0);
      expect(widgetClock(t)).toBeLessThanOrEqual(t);
    }
  });
});
