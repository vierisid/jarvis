/**
 * The thin layer between the surface and the desktop app that hosts it.
 *
 * The desktop app puts a few functions on `window` (see docs/notch/README.md):
 * the page calls `__notch_set_outline`, `__notch_focus`, `__notch_send` and
 * `__notch_log`, and defines `__notch_receive` and `__notch_cursor` for the
 * desktop app to call. Opened in a plain browser none of them is there, so
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
  __notch_receive?: (message: NotchToPage) => void;
  __notch_cursor?: (x: number, y: number, down?: number | boolean) => void;
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

/** Polygons in the window's own pixels: CSS pixels times the display scale, two decimals. */
export function devicePolygons(polygons: readonly (readonly [number, number])[][], scale: number): Polygons {
  return polygons.map((polygon) => polygon.map(([x, y]) => [Math.round(x * scale * 100) / 100, Math.round(y * scale * 100) / 100]));
}

/** Wires a surface to the desktop app, then says hello to the brain. */
export function connectNotch(surface: NotchSurface, host: NotchWindow = window as unknown as NotchWindow): void {
  let sent = '';
  const report = (): void => {
    const scale = window.devicePixelRatio || 1;
    const shapes = devicePolygons(surface.outlines(0), scale);
    const cuts = devicePolygons(surface.outlines(NOTCH_CUT_INSET), scale);
    const key = JSON.stringify(shapes);
    // The same outline again is not worth a call across two processes.
    if (key === sent) return;
    sent = key;
    quietly(() => host.__notch_set_outline?.(shapes, cuts));
  };
  surface.onOutline(report);
  host.__notch_receive = (message) => surface.receive(message);
  host.__notch_cursor = (x, y, down) => surface.pointer(x, y, !!down);
  // A new display scale changes every number of the outline.
  window.addEventListener('resize', () => { sent = ''; report(); });
  quietly(() => host.__notch_log?.(`page ready: scale ${window.devicePixelRatio || 1}, window ${window.innerWidth}x${window.innerHeight} css px`));
  notchSend(host)({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
}
