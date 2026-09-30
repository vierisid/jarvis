/**
 * #585 -- the narration either points at the element the click will take, or
 * says out loud that it cannot.
 *
 * The failure direction is the whole subject here. A pebble that quietly does
 * not move is indistinguishable from one the user blinked past, so every
 * branch that declines to point has to come back as `unplaced` with a reason,
 * and the bubble has to carry it.
 */
import { describe, test, expect } from 'bun:test';
import {
  browserElementNarration,
  unplacedLabel,
  type BrowserNarrationDeps,
} from './pebble-narration.ts';

/** Deps that would happily answer, so each test can break exactly one thing. */
function deps(over: Partial<BrowserNarrationDeps> = {}): BrowserNarrationDeps & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    localBrowserWillServe: () => true,
    snapshotElementPoint: (id) => {
      reads.push(id);
      return id === 4 ? { x: 70, y: 142 } : null;
    },
    viewportScreenOrigin: async () => ({ x: 100, y: 200 }),
    ...over,
  };
}

describe('browserElementNarration', () => {
  test('points at the cached element, offset into screen space', async () => {
    const d = deps();
    expect(await browserElementNarration(4, d)).toEqual({ kind: 'point', x: 170, y: 342 });
    expect(d.reads).toEqual([4]);
  });

  test('does not scale the coordinate, because the pebble space is not one space', async () => {
    // macOS reads the cursor in Cocoa points and Linux in GDK logical pixels,
    // so a devicePixelRatio multiply would throw the pebble most of a screen
    // away on both. The origin is returned and used unscaled.
    const d = deps({ viewportScreenOrigin: async () => ({ x: 100, y: 200 }) });
    expect(await browserElementNarration(4, d)).toEqual({ kind: 'point', x: 170, y: 342 });
  });

  test('a string element_id is unplaced: the tool would miss the number-keyed cache', async () => {
    const d = deps();
    const out = await browserElementNarration('4', d);
    expect(out.kind).toBe('unplaced');
    expect(d.reads).toEqual([]);
  });

  test('a sidecar-routed call is unplaced, and the local cache is never consulted', async () => {
    // The local controller may well hold a live snapshot of some OTHER page
    // the model visited locally. A hit on it would look exactly as
    // authoritative as a real one, so the routing check has to come first.
    const d = deps({ localBrowserWillServe: () => false });
    const out = await browserElementNarration(4, d);
    expect(out.kind).toBe('unplaced');
    expect(d.reads).toEqual([]);
  });

  test('an id no live snapshot minted is unplaced, not the nearest thing', async () => {
    const out = await browserElementNarration(5, deps());
    expect(out).toEqual({ kind: 'unplaced', reason: 'no live snapshot minted element [5]' });
  });

  test('ids the snapshot could never have minted are rejected before anything is read', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'four', '4', null, undefined]) {
      const d = deps();
      const out = await browserElementNarration(bad, d);
      expect(out.kind).toBe('unplaced');
      expect(d.reads).toEqual([]);
    }
  });

  test('an unreadable viewport position is unplaced, not a coordinate we cannot stand behind', async () => {
    const d = deps({ viewportScreenOrigin: async () => null });
    const out = await browserElementNarration(4, d);
    expect(out).toEqual({
      kind: 'unplaced',
      reason: 'could not read the viewport position on screen',
    });
  });

  test('every unplaced result carries a reason a log line can name', async () => {
    const cases = [
      await browserElementNarration(0, deps()),
      await browserElementNarration(4, deps({ localBrowserWillServe: () => false })),
      await browserElementNarration(5, deps()),
      await browserElementNarration(4, deps({ viewportScreenOrigin: async () => null })),
    ];
    for (const c of cases) {
      expect(c.kind).toBe('unplaced');
      if (c.kind === 'unplaced') expect(c.reason.length).toBeGreaterThan(0);
    }
    // Four distinct reasons, so a log line says which one happened.
    const reasons = new Set(cases.map((c) => (c.kind === 'unplaced' ? c.reason : '')));
    expect(reasons.size).toBe(4);
  });
});

describe('unplacedLabel', () => {
  test('states the absence in plain ASCII, short enough for the bubble', () => {
    const label = unplacedLabel('Clicking element [12]');
    expect(label).toBe('Clicking element [12] (location unknown)');
    expect(label).toMatch(/^[\x20-\x7e]+$/);
    expect(label.length).toBeLessThanOrEqual(48);
  });

  test('names the element, so the amended bubble still ties to the list the user read', () => {
    // "Clicking element (location unknown)" would name nothing at all; the id
    // is what cross-references the snapshot.
    expect(unplacedLabel('Typing into element [3]')).toContain('[3]');
  });

  test('is idempotent, so a second amendment cannot stack the suffix', () => {
    const once = unplacedLabel('Clicking element [1]');
    expect(unplacedLabel(once)).toBe(once);
  });
});
