/**
 * The thin layer between the surface and the desktop app that hosts it.
 *
 * The desktop app puts a few functions on `window` (see docs/notch/README.md):
 * the page calls `__notch_set_outline`, `__notch_focus`, `__notch_send`,
 * `__notch_esc`, `__notch_keys` and `__notch_log`, and defines `__notch_receive`,
 * `__notch_cursor`, `__notch_key` and `__notch_pairs` for the desktop app to
 * call. Opened in a plain browser none of them is there, so
 * every call is guarded and the page simply shows nothing.
 */
import { NOTCH_PROTOCOL_VERSION } from '../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchToPage } from '../../../src/notch/protocol.ts';
import type { NotchSurface } from './surface/index.ts';

type Polygons = number[][][];

interface NotchWindow {
  __notch_set_outline?: (shapes: Polygons, cuts: Polygons) => unknown;
  __notch_focus?: (take: boolean) => unknown;
  __notch_send?: (text: string) => unknown;
  __notch_log?: (text: string) => unknown;
  __notch_esc?: (want: boolean) => unknown;
  __notch_keys?: () => unknown;
  __notch_receive?: (message: NotchToPage) => void;
  __notch_cursor?: (x: number, y: number, down?: number | boolean) => void;
  __notch_key?: (name: string) => void;
  __notch_pairs?: (pairs: unknown) => void;
}

/** How far inside the true outline the page's window is cut, in CSS pixels. */
export const NOTCH_CUT_INSET = 1.5;

/** A call into the desktop app that may fail, or not be there, without consequence. */
function quietly(call: () => unknown): void {
  try {
    const result = call();
    if (result instanceof Promise) result.catch(() => {});
  } catch { /* the desktop app is not there, or refused: nothing to do about it here */ }
}

export function notchSend(host: NotchWindow): (message: NotchFromPage) => void {
  return (message) => quietly(() => host.__notch_send?.(JSON.stringify(message)));
}

export function notchFocus(host: NotchWindow): (take: boolean) => void {
  return (take) => quietly(() => host.__notch_focus?.(take));
}

/** How far past the window's edge a point may be sent, in CSS pixels. */
const PAST_EDGE = 8;

/**
 * Keeps an outline to the window it is for. A bump that comes in along the
 * top edge starts well outside the window; nothing of it out there can be
 * drawn, and the desktop app refuses an outline with a point far outside (the
 * whole outline, not just that polygon). So points are held to just past the
 * edge, and a polygon that is wholly outside is left out.
 */
export function withinWindow(polygons: readonly (readonly [number, number])[][], width: number, height: number): [number, number][][] {
  const out: [number, number][][] = [];
  for (const polygon of polygons) {
    if (polygon.every(([x]) => x <= 0) || polygon.every(([x]) => x >= width) || polygon.every(([, y]) => y >= height)) continue;
    out.push(polygon.map(([x, y]): [number, number] => [
      Math.max(-PAST_EDGE, Math.min(width + PAST_EDGE, x)),
      Math.max(-PAST_EDGE, Math.min(height + PAST_EDGE, y)),
    ]));
  }
  return out;
}

/** Polygons in the window's own pixels: CSS pixels times the display scale, two decimals. */
export function devicePolygons(polygons: readonly (readonly [number, number])[][], scale: number): Polygons {
  return polygons.map((polygon) => polygon.map(([x, y]) => [Math.round(x * scale * 100) / 100, Math.round(y * scale * 100) / 100]));
}

/** Wires a surface to the desktop app, then says hello to the brain. */
export function connectNotch(surface: NotchSurface, host: NotchWindow = window as unknown as NotchWindow): void {
  let sent = '';
  const report = (): void => {
    const scale = window.devicePixelRatio || 1;
    const width = window.innerWidth, height = window.innerHeight;
    const shapes = devicePolygons(withinWindow(surface.outlines(0), width, height), scale);
    const cuts = devicePolygons(withinWindow(surface.outlines(NOTCH_CUT_INSET), width, height), scale);
    const key = JSON.stringify(shapes);
    // The same outline again is not worth a call across two processes.
    if (key === sent) return;
    sent = key;
    quietly(() => host.__notch_set_outline?.(shapes, cuts));
  };
  surface.onOutline(report);
  host.__notch_receive = (message) => surface.receive(message);
  host.__notch_cursor = (x, y, down) => surface.pointer(x, y, !!down);
  // The keys: what they said, which they are on this machine, and whether Esc
  // would do anything here right now (only then is it taken from the app).
  host.__notch_key = (name) => surface.key(String(name));
  host.__notch_pairs = (pairs) => surface.setPairs(pairs);
  surface.onWantEsc((want) => quietly(() => host.__notch_esc?.(want)));
  // Ask once which keys this machine uses, so the hints show them from the
  // first line. A change made in the settings later arrives by __notch_pairs.
  try {
    const asked = host.__notch_keys?.();
    if (asked instanceof Promise) asked.then((pairs) => surface.setPairs(pairs), () => {});
  } catch { /* no desktop app here: the hints keep this system's usual keys */ }
  // A new display scale changes every number of the outline.
  window.addEventListener('resize', () => { sent = ''; report(); });
  quietly(() => host.__notch_log?.(`page ready: scale ${window.devicePixelRatio || 1}, window ${window.innerWidth}x${window.innerHeight} css px`));
  notchSend(host)({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
}
