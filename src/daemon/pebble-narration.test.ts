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
  localBrowserWillServe,
  pebbleIsOnThisHost,
  snapshotElementId,
  unplacedLabel,
  type BrowserNarrationDeps,
  type NarrationRouting,
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

/**
 * The routing predicate is the one security-relevant decision here: it is what
 * stands between a narration and a confident pointer built from a cache that
 * belongs to another browser or another machine. `PEBBLE` is the sidecar the
 * pebble is drawn on, co-located with this process.
 */
const PEBBLE = { id: 'peb-1', connected: true, hostname: 'workbench', capabilities: ['pebble'] };

function routing(over: Partial<NarrationRouting> = {}): NarrationRouting {
  return {
    pebbleSidecarId: 'peb-1',
    sidecars: [PEBBLE],
    selfHostname: 'workbench',
    machineScoped: false,
    args: {},
    ...over,
  };
}

describe('pebbleIsOnThisHost', () => {
  test('true only when the pebble is drawn on this process\'s machine', () => {
    expect(pebbleIsOnThisHost(routing())).toBe(true);
    expect(pebbleIsOnThisHost(routing({ selfHostname: 'laptop' }))).toBe(false);
  });

  test('tolerates the case and trailing-dot differences two runtimes can report', () => {
    expect(pebbleIsOnThisHost(routing({ selfHostname: 'WORKBENCH' }))).toBe(true);
    expect(pebbleIsOnThisHost(routing({
      sidecars: [{ ...PEBBLE, hostname: 'workbench.' }],
    }))).toBe(true);
  });

  test('an unknown machine is not evidence of the same machine', () => {
    for (const hostname of [null, undefined, '', '   ']) {
      expect(pebbleIsOnThisHost(routing({ sidecars: [{ ...PEBBLE, hostname }] }))).toBe(false);
    }
    // A pebble sidecar missing from the inventory entirely.
    expect(pebbleIsOnThisHost(routing({ sidecars: [] }))).toBe(false);
    expect(pebbleIsOnThisHost(routing({ selfHostname: '' }))).toBe(false);
  });
});

describe('localBrowserWillServe', () => {
  test('true when nothing suggests a browser anywhere else', () => {
    expect(localBrowserWillServe(routing())).toBe(true);
  });

  test('false when the model named a target explicitly', () => {
    expect(localBrowserWillServe(routing({ args: { target: 'laptop' } }))).toBe(false);
    // A blank target is no target at all, matching the router.
    expect(localBrowserWillServe(routing({ args: { target: '  ' } }))).toBe(true);
  });

  test('false when any connected sidecar advertises a browser', () => {
    // This is the DEFAULT deployment: a sidecar ships `browser` in its default
    // capability set, so the pebble's own sidecar trips this and browser
    // actions narrate without a pointer. The router really does send the click
    // there, and its coordinates are not ours to read.
    expect(localBrowserWillServe(routing({
      sidecars: [{ ...PEBBLE, capabilities: ['pebble', 'browser'] }],
    }))).toBe(false);
    // Or some other sidecar entirely.
    expect(localBrowserWillServe(routing({
      sidecars: [PEBBLE, { id: 'other', connected: true, hostname: 'laptop', capabilities: ['browser'] }],
    }))).toBe(false);
  });

  test('a disconnected browser sidecar is not a browser somewhere else', () => {
    expect(localBrowserWillServe(routing({
      sidecars: [PEBBLE, { id: 'other', connected: false, hostname: 'laptop', capabilities: ['browser'] }],
    }))).toBe(true);
  });

  test('false under a workflow machine binding, which picks the machine itself', () => {
    expect(localBrowserWillServe(routing({ machineScoped: true }))).toBe(false);
  });

  test('false when the pebble is on another machine, whatever the routing says', () => {
    // The local cache holds positions on THIS host's screen. Off-host it would
    // be a confident mark at coordinates that mean nothing where the user is.
    expect(localBrowserWillServe(routing({ selfHostname: 'build-server' }))).toBe(false);
  });
});

describe('snapshotElementId', () => {
  test('accepts the 1-based integers a snapshot mints, and nothing else', () => {
    expect(snapshotElementId(1)).toBe(1);
    expect(snapshotElementId(42)).toBe(42);
    // Not coerced: the tools key a number Map with this, so "5" misses there
    // and the action fails. Narrating a pointer for it would be a confident
    // preview of something that will not happen.
    for (const bad of ['5', '', 0, -3, 2.5, Number.NaN, Infinity, null, undefined, {}, [4]]) {
      expect(snapshotElementId(bad)).toBeNull();
    }
  });
});
