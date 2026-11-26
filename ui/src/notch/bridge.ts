/**
 * The thin layer between the surface and the desktop app that hosts it.
 *
 * The desktop app puts a few functions on `window` (see docs/notch/README.md):
 * the page calls `__notch_set_outline`, `__notch_focus`, `__notch_send`,
 * `__notch_esc`, `__notch_asking`, `__notch_keys`, `__notch_housing` and `__notch_log`, and defines
 * `__notch_receive`, `__notch_cursor`, `__notch_key`, `__notch_pairs` and `__notch_cam` for the desktop app to
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
  __notch_asking?: (asking: boolean) => unknown;
  __notch_keys?: () => unknown;
  __notch_housing?: () => unknown;
  __notch_cam?: (w: unknown, h: unknown) => void;
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

/** The most points one outline may have: the desktop app refuses, whole, one with more than 720. */
export const NOTCH_OUTLINE_POINTS_MAX = 700;
/** How far any point has to have moved, in the window's own pixels, for an outline to be worth sending again. */
export const NOTCH_OUTLINE_MOVED = 0.25;
/**
 * A small movement (the lip rippling while it works or thinks, for minutes)
 * is sent this often at the most. A large one, an arrival or a sheet
 * opening, is sent as it happens.
 */
export const NOTCH_OUTLINE_LARGE = 1.5;
export const NOTCH_OUTLINE_SMALL_EVERY_MS = 66;
/** How often the hello is said again while no state has come back, and how many times at most. */
export const NOTCH_HELLO_AGAIN_MS = 3000;
export const NOTCH_HELLO_TRIES = 20;

/**
 * Polygons held to a number of points in all, by leaving out every so many
 * of each. A curve is drawn with a point about every pixel and a half, so on
 * a display scaled to 300 % a wide shape had more points than the desktop
 * app takes (782 measured, 720 allowed) and the whole outline was refused.
 */
export function withinPoints(polygons: Polygons, most: number): Polygons {
  const total = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
  if (total <= most) return polygons;
  const every = Math.ceil(total / most);
  return polygons.map((polygon) => {
    const kept = polygon.filter((_, at) => at % every === 0);
    return kept.length >= 3 ? kept : polygon.slice(0, 3);
  });
}

/** Whether two outlines differ by more than a part of a pixel anywhere, or in how they are made up. */
export function outlineMoved(a: Polygons, b: Polygons | null, by: number): boolean {
  if (!b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (p.length !== q.length) return true;
    for (let j = 0; j < p.length; j++) {
      if (Math.abs(p[j]![0]! - q[j]![0]!) >= by || Math.abs(p[j]![1]! - q[j]![1]!) >= by) return true;
    }
  }
  return false;
}

/**
 * The display's camera housing, where it has one (a MacBook's): asked once, like the keys, so the first
 * thing drawn is already drawn round it. A change later (another display becomes the main one) arrives by
 * `__notch_cam`. What the desktop app says is checked by the surface, not here.
 */
export function connectHousing(surface: Pick<NotchSurface, 'setHousing'>, host: NotchWindow): void {
  host.__notch_cam = (w, h) => surface.setHousing(w, h);
  try {
    const asked = host.__notch_housing?.();
    const take = (size: unknown): void => { if (Array.isArray(size)) surface.setHousing(size[0], size[1]); };
    if (asked instanceof Promise) asked.then(take, () => {}); else take(asked);
  } catch { /* no desktop app here: no housing */ }
}

/** How many times a message that could not be read is written to the desktop app's log. A brain that is wrong is wrong often. */
export const NOTCH_DROPPED_LOGGED = 5;

/**
 * Wires a surface to the desktop app, then says hello to the brain.
 * `helloAgainMs` is how often the hello is said again while no state has
 * come: NOTCH_HELLO_AGAIN_MS when not given (the tests give less).
 */
export function connectNotch(surface: NotchSurface, host: NotchWindow = window as unknown as NotchWindow, options: { helloAgainMs?: number } = {}): void {
  const helloEvery = options.helloAgainMs ?? NOTCH_HELLO_AGAIN_MS;
  let sent: Polygons | null = null;
  let sentAt = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const report = (): void => {
    const scale = window.devicePixelRatio || 1;
    const width = window.innerWidth, height = window.innerHeight;
    const shapes = withinPoints(devicePolygons(withinWindow(surface.outlines(0), width, height), scale), NOTCH_OUTLINE_POINTS_MAX);
    // The same outline again is not worth a call across two processes, and neither is one that differs by
    // less than can be seen. A face with its eyes closed breathes by under a pixel, for as long as it is
    // closed (which can be all day): every frame was a new outline, 58 a second, each a new cut of the
    // window and a repaint of its edge.
    if (!outlineMoved(shapes, sent, NOTCH_OUTLINE_MOVED)) return;
    // A small movement so soon after the last one waits its turn. It is sent when that is over, so the last
    // shape of a movement is always the one the window is cut to.
    const since = performance.now() - sentAt;
    if (since < NOTCH_OUTLINE_SMALL_EVERY_MS && !outlineMoved(shapes, sent, NOTCH_OUTLINE_LARGE)) {
      if (trailing === null) trailing = setTimeout(() => { trailing = null; report(); }, NOTCH_OUTLINE_SMALL_EVERY_MS - since + 1);
      return;
    }
    if (trailing !== null) { clearTimeout(trailing); trailing = null; }
    sentAt = performance.now();
    const cuts = withinPoints(devicePolygons(withinWindow(surface.outlines(NOTCH_CUT_INSET), width, height), scale), NOTCH_OUTLINE_POINTS_MAX);
    sent = shapes;
    quietly(() => host.__notch_set_outline?.(shapes, cuts));
  };
  surface.onOutline(report);
  /** The brain has answered the hello with what the notch shows, and nothing it said since was dropped. */
  let stated = false;
  let tries = 0;
  let helloAt = -Infinity;
  let again: ReturnType<typeof setInterval> | null = null;
  const hello = (): void => {
    helloAt = performance.now();
    notchSend(host)({ type: 'hello', v: NOTCH_PROTOCOL_VERSION });
  };
  // The hello, or the state that answers it, can be lost on the way. The page then stayed unborn: it drew
  // nothing and dropped all that was said to it, while the brain counted it as listening. Said again until
  // a state has come.
  const keepAsking = (): void => {
    if (again !== null) return;
    again = setInterval(() => {
      if (stated || ++tries > NOTCH_HELLO_TRIES) { if (again !== null) clearInterval(again); again = null; return; }
      hello();
    }, helloEvery);
  };
  /** Said now, unless it was said a moment ago: a brain that answers with something unreadable is not asked in a loop. */
  const helloSoon = (): void => { if (performance.now() - helloAt >= helloEvery) hello(); };
  // Something the brain said could not be read, and was dropped whole. What the notch shows may no longer be
  // what the brain believes it shows, so the brain is asked for the whole of it again. (A line that could
  // not be drawn, told to a page that came up, used to leave that page drawing nothing and hearing nothing
  // until the desktop app was started again: the state had come, so the hello was never said a second time.)
  let dropped = 0, droppedNow = false;
  surface.onDropped((what) => {
    droppedNow = true;
    if (dropped++ < NOTCH_DROPPED_LOGGED) quietly(() => host.__notch_log?.(`a message from the brain could not be read and was dropped: ${what}`));
    stated = false;
    helloSoon();
    keepAsking();
  });
  host.__notch_receive = (message) => {
    droppedNow = false;
    surface.receive(message);
    if (droppedNow) return;
    if ((message as { type?: unknown } | null)?.type === 'state') {
      stated = true;
      // The next time the page is out of step it may ask as often again.
      tries = 0;
    } else if (!stated) {
      // The brain is speaking to a page that has no state from it: its tries may be long used up (a line
      // that could not be read stayed up for minutes), and this is the moment the brain may have one that can.
      helloSoon();
    }
  };
  host.__notch_cursor = (x, y, down) => surface.pointer(x, y, !!down);
  // The keys: what they said, which they are on this machine, and whether Esc
  // would do anything here right now (only then is it taken from the app).
  host.__notch_key = (name) => surface.key(String(name));
  host.__notch_pairs = (pairs) => surface.setPairs(pairs);
  surface.onWantEsc((want) => quietly(() => host.__notch_esc?.(want)));
  // Whether a question is waiting: the window does not hide behind a
  // fullscreen video while one is.
  surface.onAsking((asking) => quietly(() => host.__notch_asking?.(asking)));
  // Ask once which keys this machine uses, so the hints show them from the
  // first line. A change made in the settings later arrives by __notch_pairs.
  try {
    const asked = host.__notch_keys?.();
    if (asked instanceof Promise) asked.then((pairs) => surface.setPairs(pairs), () => {});
  } catch { /* no desktop app here: the hints keep this system's usual keys */ }
  connectHousing(surface, host);
  // A new display scale changes every number of the outline.
  window.addEventListener('resize', () => { sent = null; report(); });
  quietly(() => host.__notch_log?.(`page ready: scale ${window.devicePixelRatio || 1}, window ${window.innerWidth}x${window.innerHeight} css px`));
  // A page that was loaded again while it had the keyboard never gave it back: it is given back once, now.
  quietly(() => host.__notch_focus?.(false));
  hello();
  keepAsking();
}
