/**
 * Now, to the minute, for widgets that put a clock reading in a URL.
 *
 * ── The bug this file exists to make impossible ──
 *
 * `useWidgetData(url)` re-runs its effect whenever `url` changes, and two of
 * the Now-room widgets built theirs from a time range:
 *
 *     const now = Date.now();
 *     useWidgetData(`/api/calendar?range_start=${now}&range_end=${now + 7d}`)
 *
 * `Date.now()` is read during RENDER, so the URL was different on every render.
 * The response called `setData` with a fresh array, which re-rendered, which
 * produced a new URL, which re-ran the effect, which fetched again. Measured in
 * the browser: 2,729 requests to `/api/calendar` in 53 seconds, about fifty a
 * second, sustained for as long as anyone sat on the home surface.
 *
 * That is the founder's own daemon, single-threaded, being asked to run fifty
 * SQLite queries a second while it relays a live voice conversation. During the
 * trial the home surface is where the whole opening happens, which is where it
 * was found.
 *
 * Quantising to the minute makes the URL stable between renders, so the effect
 * re-runs when the window it names actually moves and not before.
 */

export const WIDGET_CLOCK_STEP_MS = 60_000;

export function widgetClock(now: number = Date.now()): number {
  return Math.floor(now / WIDGET_CLOCK_STEP_MS) * WIDGET_CLOCK_STEP_MS;
}
