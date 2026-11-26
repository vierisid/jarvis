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
import { NOTCH_ESC_LEASE_MS, NOTCH_ESC_RENEW_MS, NOTCH_PROTOCOL_VERSION } from '../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchToPage } from '../../../src/notch/protocol.ts';
import { realNotchPageClock, type NotchPageClock } from './surface/dom.ts';
import type { NotchSurface } from './surface/index.ts';

type Polygons = number[][][];

interface NotchWindow {
  __notch_set_outline?: (shapes: Polygons, cuts: Polygons) => unknown;
  __notch_focus?: (take: boolean) => unknown;
  __notch_send?: (text: string) => unknown;
  __notch_log?: (text: string) => unknown;
  __notch_esc?: (want: boolean) => unknown;
  /**
   * Not in any desktop app yet (docs/notch/README.md, "The lease on Esc"):
   * one that has it is told here that this page says its claim on Esc again
   * every NOTCH_ESC_RENEW_MS, so that it may let a claim lapse that was not
   * said again for this many ms.
   */
  __notch_esc_lease?: (ms: number) => unknown;
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

/** How many times in one episode a message that could not be read is written to the desktop app's log. A brain that is wrong is wrong often. */
export const NOTCH_DROPPED_LOGGED = 5;
/**
 * How often a page that rests because the brain speaks another version says
 * hello all the same: the brain may have been changed for one that fits.
 */
export const NOTCH_HELLO_RESTING_MS = 300_000;
/** Where the page keeps, across one loading of itself again, that it has done so for a brain of another version. */
export const NOTCH_RELOADED_KEY = 'jarvis-notch-reloaded';

/** What `connectNotch` needs to load the page again once, and no more than once, for the same mismatch. */
export interface NotchReloader {
  /** What was kept, or null. May throw: then nothing can be kept, and the page is not loaded again. */
  get(): string | null;
  set(value: string): void;
  clear(): void;
  reload(): void;
}

const browserReloader: NotchReloader = {
  get: () => window.sessionStorage.getItem(NOTCH_RELOADED_KEY),
  set: (value) => window.sessionStorage.setItem(NOTCH_RELOADED_KEY, value),
  clear: () => window.sessionStorage.removeItem(NOTCH_RELOADED_KEY),
  reload: () => window.location.reload(),
};

/** A name for this loading of the page: the brain tells the answers of one loading from those of the next by it. */
export function notchPageName(): string {
  const bytes = new Uint8Array(8);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Wires a surface to the desktop app, then says hello to the brain.
 *
 * The page says hello once, and again while it is out of step with the brain:
 * until the first `state` has come, and from the moment something the brain
 * said was dropped. That is one episode. It ends when a `state` is read whole,
 * and in it the hello is said again NOTCH_HELLO_TRIES times at the most, never
 * closer together than NOTCH_HELLO_AGAIN_MS, however many messages are dropped
 * meanwhile: each hello makes the brain tell everything again, and lets what
 * was missed speak up. When the tries are spent the page asks no more. It is
 * still told every change, and a new episode begins only after a `state` that
 * could be read.
 *
 * A brain that speaks another version of the messages is not limped along
 * with. The page loads itself again, once: the brain serves the page, so
 * that brings the page that fits a brain which was updated under it. If the
 * brain still speaks another version after that (the page is the newer one,
 * reaching a brain that is still being updated), the page rests: it draws
 * nothing, holds no Esc, says so in the log, and says hello only every
 * NOTCH_HELLO_RESTING_MS until a `state` of its own version comes.
 *
 * The page's claim on Esc is a lease. It is said again every
 * NOTCH_ESC_RENEW_MS for as long as the notch wants Esc, and given up once
 * when it does not: a page that stops (it hangs, its timers stop) says
 * nothing more, and the desktop app stops believing a page that gives no
 * sign (its pulse, sidecar/notch_pulse.go).
 *
 * `clock`, `helloAgainMs` and `reloader` are for the tests.
 */
export function connectNotch(
  surface: NotchSurface,
  host: NotchWindow = window as unknown as NotchWindow,
  options: { helloAgainMs?: number; clock?: NotchPageClock; reloader?: NotchReloader } = {},
): void {
  const helloEvery = options.helloAgainMs ?? NOTCH_HELLO_AGAIN_MS;
  const clock = options.clock ?? realNotchPageClock;
  const reloader = options.reloader ?? browserReloader;
  const page = notchPageName();
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
  /** How often the hello was said again, and how many drops were logged, in this episode. */
  let tries = 0, logged = 0;
  let helloAt = -Infinity;
  let waiting: number | null = null;
  const hello = (): void => {
    helloAt = clock.now();
    notchSend(host)({ type: 'hello', v: NOTCH_PROTOCOL_VERSION, page });
  };
  /** The brain speaks another version, and loading the page again did not change that. */
  let resting = false;
  // The hello, or the state that answers it, can be lost on the way. The page then stayed unborn: it drew
  // nothing and dropped all that was said to it, while the brain counted it as listening. Said again until
  // a state has come.
  const keepAsking = (): void => {
    if (waiting !== null || stated || resting || tries >= NOTCH_HELLO_TRIES) return;
    waiting = clock.after(helloEvery, () => {
      waiting = null;
      if (stated || resting || tries >= NOTCH_HELLO_TRIES) return;
      tries++;
      hello();
      keepAsking();
    });
  };
  const restAsking = (): void => {
    clock.after(NOTCH_HELLO_RESTING_MS, () => {
      if (!resting) return;
      hello();
      restAsking();
    });
  };
  surface.onVersion((v) => {
    if (resting) return;
    const which = `page ${NOTCH_PROTOCOL_VERSION}, brain ${v}`;
    let before: string | null = which;
    let kept = false;
    // What cannot be kept cannot be told from the first time: then the page is not loaded again at all,
    // or it would be loaded again for ever.
    try { before = reloader.get(); reloader.set(which); kept = true; } catch { kept = false; }
    if (kept && before !== which) {
      quietly(() => host.__notch_log?.(`the brain speaks version ${v} of the messages and this page version ${NOTCH_PROTOCOL_VERSION}: the page loads itself again, once`));
      try { reloader.reload(); return; } catch { /* it cannot: it rests, below */ }
    }
    resting = true;
    if (waiting !== null) { clock.cancel(waiting); waiting = null; }
    surface.retire();
    quietly(() => host.__notch_log?.(`the brain speaks version ${v} of the messages and this page version ${NOTCH_PROTOCOL_VERSION}${kept ? ', also after the page was loaded again' : ', and the page cannot note that it loaded itself again'}: the notch rests and shows nothing until the brain speaks version ${NOTCH_PROTOCOL_VERSION}`));
    restAsking();
  });
  // Something the brain said could not be read, and was dropped. What the notch shows may no longer be
  // what the brain believes it shows, so the brain is asked for the whole of it again. (A line that could
  // not be drawn, told to a page that came up, used to leave that page drawing nothing and hearing nothing
  // until the desktop app was started again: the state had come, so the hello was never said a second time.)
  let droppedNow = false;
  surface.onDropped((what) => {
    droppedNow = true;
    if (resting) return;
    if (logged++ < NOTCH_DROPPED_LOGGED) quietly(() => host.__notch_log?.(`out of step with the brain, which is asked for everything again: ${what}`));
    stated = false;
    // At once, unless it was said a moment ago: a brain that answers with the same thing is not asked in a loop.
    if (tries < NOTCH_HELLO_TRIES && clock.now() - helloAt >= helloEvery) { tries++; hello(); }
    keepAsking();
  });
  host.__notch_receive = (message) => {
    droppedNow = false;
    surface.receive(message);
    const state = message as { type?: unknown; v?: unknown } | null;
    if (droppedNow || state?.type !== 'state' || state.v !== NOTCH_PROTOCOL_VERSION) return;
    // Read whole: the page is in step again, and the episode is over.
    stated = true;
    tries = 0;
    logged = 0;
    // And the brain speaks this page's version: the next mismatch is a new one.
    resting = false;
    try { reloader.clear(); } catch { /* nothing was kept */ }
  };
  host.__notch_cursor = (x, y, down) => surface.pointer(x, y, !!down);
  // The keys: what they said, which they are on this machine, and whether Esc
  // would do anything here right now (only then is it taken from the app).
  host.__notch_key = (name) => surface.key(String(name));
  host.__notch_pairs = (pairs) => surface.setPairs(pairs);
  // The claim is a lease: said again for as long as it stands, and given up once. A second argument is
  // never passed: the desktop app refuses a call with one more argument than it knows, and Esc would be lost.
  let escAgain: number | null = null;
  const renewEsc = (): void => {
    escAgain = clock.after(NOTCH_ESC_RENEW_MS, () => {
      quietly(() => host.__notch_esc?.(true));
      renewEsc();
    });
  };
  quietly(() => host.__notch_esc_lease?.(NOTCH_ESC_LEASE_MS));
  surface.onWantEsc((want) => {
    if (escAgain !== null) { clock.cancel(escAgain); escAgain = null; }
    quietly(() => host.__notch_esc?.(want));
    if (want) renewEsc();
  });
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
