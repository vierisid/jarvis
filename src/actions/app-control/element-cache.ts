/**
 * Element Cache -- what a local desktop element id means, and the check every
 * action on one runs (#704).
 *
 * The local desktop path (`desktop.ts` over any AppController, and
 * `DesktopController`'s own snapshot/clickById for the WSL bridge) had the
 * defect #661 fixed in the sidecar: an id was a small integer counted from 1 on
 * every walk, resolved against whatever the cache held at action time with no
 * identity or recency check. So an id from an earlier snapshot -- of another
 * window, or of this one before a dialog changed -- named element N of the
 * LATEST walk, and an element that moved was clicked where it used to be.
 *
 * This is the TypeScript port of the sidecar's shape, not a second design
 * (sidecar/desktop_element_cache.go and desktop_element_identity.go, #661):
 *
 *  1. The id names ONE walk: `generation * ELEMENT_ID_STRIDE + index`. Every
 *     fill starts a new generation, and an id from any other fill is "not in
 *     the cache". A walk that fails retires the cache the same way (`forget`).
 *
 *  2. The element is still there: every action walks again with the SAME pid
 *     and depth -- what makes index N comparable across the two walks -- and
 *     refuses unless that element has the same role, name, automation id and
 *     rect. `elementChange` is the same comparison as `desktopElementChange`.
 *     The action is then dispatched with the element the read-back returned,
 *     never the cached copy: a legacy desktop bridge numbers elements per walk,
 *     so after the read-back only the live element's own id is the one it
 *     answers to.
 *
 * There is no time bound, for the reason given in desktop_element_identity.go:
 * a click is safe because its target is the element the model was shown, not
 * because the showing was recent.
 *
 * Every refusal is thrown before anything is dispatched, so all of them are
 * `not_started`.
 */

import { ActionOutcomeError } from '../action-outcome.ts';
import type { UIElement } from './interface.ts';

/**
 * Separates one fill's ids from the next. The same stride as the sidecar's
 * `desktopElementIDStride`; the generations differ (see
 * LOCAL_GENERATION_BASE), so the two paths never mint the same id. The legacy
 * bridge stops a walk once its cache passes 500 elements (ElementHandler.cs,
 * deleted in 28e43ed, checks `_elementCache.Count > 500` after each child's
 * subtree), and the descent already under way adds at most one element per
 * remaining level first, so a depth-5 walk stops a handful past 500: under the
 * stride. An element past it gets no id at all (see fill).
 */
export const ELEMENT_ID_STRIDE = 1000;

/**
 * Where a local cache's generations start, so a local id can never equal a
 * sidecar's (#704 review). A desktop tool without a `target` routes to a
 * sidecar while one is connected and runs locally when it is not, so an id the
 * model took from a sidecar snapshot can arrive at the local path after the
 * sidecar drops -- and with both counting generations from 1, sidecar id 1005
 * was element 5 of whatever local snapshot was last taken. The sidecar's ids
 * are gen*1000+index from gen 1 per process on Linux and macOS, and a counter
 * from 1 on Windows; to reach this range a sidecar process would have to take a
 * million snapshots, or cache a billion Windows elements. Local ids start at
 * 1000001000.
 */
export const LOCAL_GENERATION_BASE = 1_000_000;

/** What a snapshot told the model about one element: enough to recognise it again. */
export type ElementPrint = {
  name: string;
  role: string;
  autoID: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * How `live` differs from `snap`, as the clause a refusal uses, or '' when it is
 * still the element the snapshot listed. `positional` as in the sidecar: the
 * local path passes true, because the controllers that are not a bridge click
 * at the rect, and refusing a moved element costs at most a fresh snapshot.
 */
export function elementChange(snap: ElementPrint, live: ElementPrint, positional: boolean): string {
  if (snap.role !== live.role || snap.name !== live.name || snap.autoID !== live.autoID) return 'is a different element now';
  if (positional && (snap.x !== live.x || snap.y !== live.y || snap.w !== live.w || snap.h !== live.h)) return 'has moved';
  return '';
}

export const STALE_ELEMENT_CODE = 'DESKTOP_STALE_ELEMENT';
export const ELEMENT_NOT_CACHED_CODE = 'DESKTOP_ELEMENT_NOT_FOUND';

export function elementNotCached(id: number): ActionOutcomeError {
  return new ActionOutcomeError({ status: 'blocked', code: ELEMENT_NOT_CACHED_CODE, effect: 'not_started',
    message: `Error: element [${id}] is not in the current element cache, so nothing was done. Only ids from the most recent `
      + 'desktop_snapshot or desktop_find_element are valid: run desktop_snapshot again and use an id from that result.' });
}

export function elementStale(id: number, why: string): ActionOutcomeError {
  return new ActionOutcomeError({ status: 'blocked', code: STALE_ELEMENT_CODE, effect: 'not_started',
    message: `Error: element [${id}] ${why} since the snapshot that listed it, so nothing was done. `
      + 'Run desktop_snapshot again and use an id from that result.' });
}

function elementSuperseded(id: number): ActionOutcomeError {
  return new ActionOutcomeError({ status: 'blocked', code: STALE_ELEMENT_CODE, effect: 'not_started',
    message: `Error: a new snapshot replaced element [${id}] while this call was confirming it, so nothing was done. `
      + 'Run desktop_snapshot again and use an id from that result.' });
}

export type CachedElement<E> = {
  element: E;
  index: number;
  pid: number;
  depth: number;
  generation: number;
  /** Which window the walk read, when the walk can say (see WalkResult). */
  context: string | undefined;
};

/**
 * One walk: its elements in walk order, and -- when the controller can say --
 * which window it read. A legacy bridge walks "the largest named window of
 * that pid", not a window it was handed, so a read-back of the same pid can
 * read another window of the same app; `context` is what tells the two apart.
 */
export type WalkResult<E> = { elements: E[]; context?: string };

export class ElementCache<E> {
  private elements: E[] = [];
  private pid = 0;
  private depth = 0;
  private gen = LOCAL_GENERATION_BASE;
  private context: string | undefined;

  /**
   * Replace the cache with one walk's elements, in walk order, and return the
   * id each was given -- null for one nothing can address: past the stride, or
   * past `addressable`, the elements the snapshot actually showed the model.
   * `depth` must be the depth the walk used, or a read-back walks a different
   * tree.
   */
  fill(walk: WalkResult<E>, pid: number, depth: number, addressable = ELEMENT_ID_STRIDE): Array<number | null> {
    this.gen++;
    const limit = Math.min(addressable, ELEMENT_ID_STRIDE);
    this.elements = walk.elements.slice(0, limit);
    this.pid = pid;
    this.depth = depth;
    this.context = walk.context;
    return walk.elements.map((_, index) => (index < limit ? this.gen * ELEMENT_ID_STRIDE + index : null));
  }

  /** Empty the cache and retire every id it handed out (a walk that failed). */
  forget(): void {
    this.gen++;
    this.elements = [];
    this.pid = 0;
    this.depth = 0;
    this.context = undefined;
  }

  generation(): number {
    return this.gen;
  }

  /** The element an id names, with what is needed to re-check it, or null. */
  lookup(id: number): CachedElement<E> | null {
    if (!Number.isInteger(id) || id < 0 || Math.floor(id / ELEMENT_ID_STRIDE) !== this.gen) return null;
    const index = id % ELEMENT_ID_STRIDE;
    if (index >= this.elements.length) return null;
    return { element: this.elements[index]!, index, pid: this.pid, depth: this.depth, generation: this.gen, context: this.context };
  }
}

/**
 * The guard every action on a cached id runs before it dispatches anything.
 * Returns the element as the read-back just found it -- the one to act on -- or
 * throws a `not_started` refusal.
 */
export async function resolveElement<E>(
  cache: ElementCache<E>,
  id: number,
  walk: (pid: number, depth: number) => Promise<WalkResult<E>>,
  print: (element: E) => ElementPrint,
): Promise<E> {
  const cached = cache.lookup(id);
  if (!cached) throw elementNotCached(id);
  // An element with no size has no point to act at: the bridge reports a rect
  // it could not read as 0,0,0,0, and a click there lands in the screen's
  // corner. The sidecar never caches one (its walks keep only sized elements).
  const snap = print(cached.element);
  if (snap.w <= 0 || snap.h <= 0) {
    throw new ActionOutcomeError({ status: 'blocked', code: STALE_ELEMENT_CODE, effect: 'not_started',
      message: `Error: element [${id}] has no on-screen size to act at, so nothing was done. Pick another element from the snapshot.` });
  }
  let live: WalkResult<E>;
  try {
    live = await walk(cached.pid, cached.depth);
  } catch (err) {
    throw new ActionOutcomeError({ status: 'blocked', code: STALE_ELEMENT_CODE, effect: 'not_started',
      message: `Error: could not re-read the window to confirm element [${id}] is still the one the snapshot listed, so nothing was done `
        + `(${err instanceof Error ? err.message : String(err)}). Run desktop_snapshot again.` });
  }
  // The same pid can name another window of the same app on a read-back.
  if (cached.context !== undefined && live.context !== cached.context) throw elementStale(id, 'is in a different window now');
  const liveElement = live.elements[cached.index];
  if (liveElement === undefined) throw elementStale(id, 'has disappeared');
  const why = elementChange(snap, print(liveElement), true);
  if (why) throw elementStale(id, why);
  // A fill that landed during the read-back made this id one from an earlier
  // snapshot, which lookup would now refuse; refused here too.
  if (cache.generation() !== cached.generation) throw elementSuperseded(id);
  return liveElement;
}

/** The print of an AppController element, as every local walk reports one. */
export function uiElementPrint(element: UIElement): ElementPrint {
  const autoID = element.properties?.automationId;
  return {
    name: element.name ?? '',
    role: element.role ?? '',
    autoID: typeof autoID === 'string' ? autoID : '',
    x: element.bounds?.x ?? 0,
    y: element.bounds?.y ?? 0,
    w: element.bounds?.width ?? 0,
    h: element.bounds?.height ?? 0,
  };
}
