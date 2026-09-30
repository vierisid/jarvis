/**
 * #585 -- the narration either points at the element the click will take, or
 * says out loud that it cannot.
 *
 * The failure direction is the whole subject here. A pebble that quietly does
 * not move is indistinguishable from one the user blinked past, so every
 * branch that declines to point has to come back as `unplaced` with a reason,
 * and the bubble has to carry it.
 */
import { afterEach, describe, test, expect } from 'bun:test';
import {
  browserElementNarration,
  localBrowserWillServe,
  pebbleIsOnThisHost,
  snapshotElementId,
  unplacedLabel,
  type BrowserNarrationDeps,
  type NarrationRouting,
} from './pebble-narration.ts';
import { remoteBrowserNarration, remoteBrowserPebbleTarget } from '../actions/browser/remote-element-point.ts';
import { getSidecarManager, setSidecarManagerRef } from '../actions/tools/sidecar-route.ts';
import { SidecarRPCError } from '../sidecar/rpc.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import type { SidecarInfo } from '../sidecar/types.ts';

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

  test('a page that left the reviewed document is unplaced, with its own reason', async () => {
    // #592 made the action itself refuse on a document change, and the
    // narration resolves BEFORE the tool runs, so the cache still answers. This
    // is the branch that keeps the pebble from previewing an action that is
    // about to refuse -- and it reads differently from a geometry read that
    // failed, because that is the distinction a log line needs.
    const d = deps({ viewportScreenOrigin: async () => 'moved' });
    const out = await browserElementNarration(4, d);
    expect(out).toEqual({
      kind: 'unplaced',
      reason: 'the page left the document element [4] came from',
    });
    // It names the id, so the amended bubble still ties to the list the user
    // read, and it is not the geometry reason.
    if (out.kind === 'unplaced') expect(out.reason).not.toContain('viewport');
  });

  test('every unplaced result carries a reason a log line can name', async () => {
    const cases = [
      await browserElementNarration(0, deps()),
      await browserElementNarration(4, deps({ localBrowserWillServe: () => false })),
      await browserElementNarration(5, deps()),
      await browserElementNarration(4, deps({ viewportScreenOrigin: async () => null })),
      await browserElementNarration(4, deps({ viewportScreenOrigin: async () => 'moved' })),
    ];
    for (const c of cases) {
      expect(c.kind).toBe('unplaced');
      if (c.kind === 'unplaced') expect(c.reason.length).toBeGreaterThan(0);
    }
    // Five distinct reasons, so a log line says which one happened.
    const reasons = new Set(cases.map((c) => (c.kind === 'unplaced' ? c.reason : '')));
    expect(reasons.size).toBe(5);
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
    localBrowserEnabled: true,
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

  test('false where this host refuses local browser calls at all', () => {
    // `--no-local-tools`, or a hosted install's `browser.local: false`.
    // `browser_click` refuses outright there, so this process's browser is not
    // what will serve the call and the predicate's contract says false. It
    // outranks every other term, including an inventory with no sidecar at all.
    expect(localBrowserWillServe(routing({ localBrowserEnabled: false }))).toBe(false);
    expect(localBrowserWillServe(routing({ localBrowserEnabled: false, sidecars: [] }))).toBe(false);
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

/**
 * THE TEST THE HOLD WAS WAITING ON (#585 + #591).
 *
 * #590 was held in draft because on a default install every browser action
 * narrated "(location unknown)": `CapBrowser` is in the sidecar's default
 * capability set, so the click routes there, the coordinates live in that
 * process, and nothing carried them back. Fail-closed was the right answer to
 * that and both reviewers agreed -- but a feature that is correct and silent on
 * almost every deployment is not the fix #585 asked for.
 *
 * So these drive the REAL composition the daemon builds --
 * `browserElementNarration` over the real `remoteBrowserNarration`, over a fake
 * sidecar -- and the assertion that matters is a real point with real numbers.
 * Asserting the fail-closed string here would pass just as happily against the
 * held branch and prove nothing, which is exactly the trap.
 */
const PEBBLE_PC: SidecarInfo = {
  id: 'sc-pc', name: 'Desk PC', enrolled_at: '2026-01-01', last_seen_at: '2026-01-02',
  status: 'enrolled', connected: true, hostname: 'workbench', os: 'linux', platform: 'amd64',
  capabilities: ['browser', 'pebble'],
};

/** The sidecar's answer, in the one coordinate space this brain accepts. */
const SIDECAR_POINT = { x: 437, y: 484, space: 'screen_dip', loader_id: 'L1' };

/** A sidecar that answers `browser_element_point` with `reply`. */
function fakeBrowserSidecar(reply: (params: Record<string, unknown>) => unknown) {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  setSidecarManagerRef({
    listSidecars: () => [PEBBLE_PC],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      seen.push({ method, params });
      return reply(params);
    },
  } as unknown as SidecarManager);
  return seen;
}

/**
 * The default install: one connected sidecar, advertising `browser` because
 * that is in its default capability set, and it is the sidecar drawing the
 * pebble.
 */
const defaultInstall = (): NarrationRouting => ({
  pebbleSidecarId: 'sc-pc',
  sidecars: [PEBBLE_PC],
  selfHostname: 'workbench',
  machineScoped: false,
  localBrowserEnabled: true,
  args: {},
});

/** The deps exactly as `resolveToolNarration` assembles them. */
function wiredDeps(routing: NarrationRouting) {
  const localReads: number[] = [];
  // Both instruments are VERIFIED rather than hopeful: the last test in this
  // block drives the same fake down the local path and observes both of them
  // firing, so a zero here means "not read" and not "unreadable".
  let originReads = 0;
  const deps: BrowserNarrationDeps = {
    localBrowserWillServe: () => localBrowserWillServe(routing),
    // A live local snapshot of some OTHER page the model visited locally. If
    // anything ever falls back to it, these tests see the read.
    snapshotElementPoint: (id: number) => {
      localReads.push(id);
      return { x: 11, y: 22 };
    },
    // This machine's viewport origin. Adding it to a REMOTE coordinate would be
    // a position on the wrong machine, so the remote path must not read it.
    viewportScreenOrigin: async () => {
      originReads++;
      return { x: 1000, y: 2000 };
    },
    remoteElementPoint: (id: number) => remoteBrowserNarration(routing, id),
  };
  return { localReads, deps, origin: () => originReads };
}

// Capture and RESTORE: `sidecarManager` is a module singleton and `bun test`
// shares the module registry across files, so putting back what was there is
// the only reset that cannot affect another suite.
const priorNarrationManager = getSidecarManager();
afterEach(() => {
  setSidecarManagerRef(priorNarrationManager as unknown as SidecarManager);
});

describe('a browser action on a sidecar-served page narrates a REAL point (#585 unparked)', () => {
  test('the default install gets the sidecar\'s coordinate, not "(location unknown)"', async () => {
    const seen = fakeBrowserSidecar(() => SIDECAR_POINT);
    const routing = defaultInstall();
    // The precondition that held this PR: on this install the local cache is
    // NOT the click's input.
    expect(localBrowserWillServe(routing)).toBe(false);

    const { deps, localReads, origin } = wiredDeps(routing);
    const out = await browserElementNarration(5, deps);

    // A real point, with the sidecar's own numbers. This is the assertion the
    // hold was waiting on: it fails on the held branch, where the same input
    // produced `unplaced`.
    expect(out).toEqual({ kind: 'point', x: 437, y: 484 });

    // NO SCALE TERM and no local origin: the answer is the sidecar's coordinate
    // verbatim. #590's first version multiplied by devicePixelRatio, which is
    // right only on Windows at 100% DPI and would have thrown the pebble most
    // of a screen away on macOS and Linux. Asserted as "the local origin was
    // never even read", which is what actually fails if someone reintroduces
    // the term -- comparing against the offset value could not fail once the
    // equality above has passed.
    expect(origin()).toBe(0);

    // And it never touched this process's cache.
    expect(localReads).toEqual([]);
    // One read-only RPC, carrying the id and nothing else.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('browser_element_point');
    expect(seen[0]!.params).toEqual({ element_id: 5 });
  });

  test('an OLD sidecar still fails closed, and does not fall back to the local cache', async () => {
    // #591's version matrix: METHOD_NOT_FOUND means the sidecar predates the
    // RPC, and nothing may fall back to browser_evaluate, to this process's own
    // elementCoords, or to a fresh DOM query. "(location unknown)" stays the
    // correct answer for that pairing.
    const seen = fakeBrowserSidecar(() => {
      throw new SidecarRPCError('METHOD_NOT_FOUND', 'Unknown method: browser_element_point');
    });
    const { deps, localReads, origin } = wiredDeps(defaultInstall());
    const out = await browserElementNarration(5, deps);

    expect(out.kind).toBe('unplaced');
    if (out.kind !== 'unplaced') return;
    // The exact brain-authored sentence, so a misclassified refusal (read as
    // "refused" or "no reply") fails here rather than passing as "unplaced".
    expect(out.reason).toBe('sidecar "sc-pc" predates the element-coordinate RPC');
    // The bubble the user reads, built from that narration.
    expect(unplacedLabel(`Clicking element [5]`)).toBe('Clicking element [5] (location unknown)');
    // Nothing on this machine was consulted for a coordinate or an origin.
    expect(origin()).toBe(0);

    // THE POINT OF THIS TEST: the local cache would have answered {11, 22} and
    // it was never asked. The remote branch returns, so `snapshotElementPoint`
    // is structurally unreachable here rather than merely unused.
    expect(localReads).toEqual([]);
    // One dispatch, and it is the read-only one -- never browser_evaluate,
    // which is execute_command authority and can launch a headed Chromium.
    expect(seen.map((s) => s.method)).toEqual(['browser_element_point']);
  });

  test('a stale snapshot on the sidecar is unplaced, not the local page\'s geometry', async () => {
    const seen = fakeBrowserSidecar(() => {
      throw new SidecarRPCError('BROWSER_SNAPSHOT_STALE', 'element 5 is not in the current snapshot');
    });
    const { deps, localReads, origin } = wiredDeps(defaultInstall());
    const out = await browserElementNarration(5, deps);
    // A refusal, read as one -- not as a missing method and not as no reply.
    expect(out).toEqual({
      kind: 'unplaced',
      reason: 'sidecar "sc-pc" has no current coordinate for that element',
    });
    expect(localReads).toEqual([]);
    expect(origin()).toBe(0);
    expect(seen.map((s) => s.method)).toEqual(['browser_element_point']);
  });

  test('a coordinate in an unknown space is refused rather than misplaced', async () => {
    // When a measured per-platform conversion lands it ships under a NEW space
    // name, and this brain must then refuse instead of confidently misplacing
    // the pointer.
    fakeBrowserSidecar(() => ({ ...SIDECAR_POINT, space: 'screen_physical_v2' }));
    const { deps, localReads, origin } = wiredDeps(defaultInstall());
    const out = await browserElementNarration(5, deps);
    expect(out).toEqual({
      kind: 'unplaced',
      reason: 'sidecar "sc-pc" answered a coordinate this daemon will not use',
    });
    expect(localReads).toEqual([]);
    expect(origin()).toBe(0);
  });

  test('a local browser still answers from the local cache, unchanged', async () => {
    // The other half of the wiring: with no browser sidecar in the inventory
    // the click runs here, and the narration reads the coordinates it will
    // dispatch at, offset by the viewport origin. The remote dep is present and
    // must not be consulted.
    const seen = fakeBrowserSidecar(() => SIDECAR_POINT);
    const routing: NarrationRouting = {
      ...defaultInstall(),
      sidecars: [{ ...PEBBLE_PC, capabilities: ['pebble'] }],
    };
    expect(localBrowserWillServe(routing)).toBe(true);

    const { deps, localReads, origin } = wiredDeps(routing);
    expect(await browserElementNarration(5, deps)).toEqual({ kind: 'point', x: 1011, y: 2022 });
    // Both instruments the remote tests assert zero on DO fire when a read
    // happens, so those zeros mean "not read" rather than "unreadable".
    expect(localReads).toEqual([5]);
    expect(origin()).toBe(1);
    // No RPC at all: the coordinates were already here.
    expect(seen).toEqual([]);
  });
});

/**
 * The two predicates have to agree about the same inventory (#591 review).
 *
 * `localBrowserWillServe` decides whether to read THIS process's cache;
 * `remoteBrowserPebbleTarget` decides which sidecar to ask. Between them they
 * are supposed to cover every inventory, because the click itself lands in
 * exactly one place. The gap was an enabled-but-UNAVAILABLE `browser`
 * capability: one said "a browser lives elsewhere", the other filtered the same
 * sidecar out and found nothing to ask, and the user got "(location unknown)"
 * for a click that ran locally with honest coordinates already in the cache.
 */
describe('an unavailable browser capability is not a browser somewhere else', () => {
  /** Advertised, and reported unserviceable -- a sidecar with no Chromium. */
  const NO_CHROMIUM: SidecarInfo = {
    ...PEBBLE_PC,
    unavailable_capabilities: [{ name: 'browser', reason: 'no chromium installed' }],
  };
  const unavailableInstall = (): NarrationRouting => ({
    ...defaultInstall(),
    sidecars: [NO_CHROMIUM],
  });

  test('the local browser serves it, so the local cache IS the click\'s input', () => {
    // `autoTargetForCapability` skips a sidecar whose capability is
    // unavailable, so the call falls back to this process's browser. Matching
    // on the advertisement alone refused a pointer here.
    expect(localBrowserWillServe(unavailableInstall())).toBe(true);
    // And the advertisement alone is still enough when it is serviceable.
    expect(localBrowserWillServe(defaultInstall())).toBe(false);
  });

  test('a DIFFERENT unavailable capability does not excuse the browser', () => {
    // Only `browser` is being asked about. A sidecar that cannot do `terminal`
    // can still serve the click, so this must stay false. Declared as
    // `SidecarInfo`, which is what the daemon really hands over.
    const noShell: SidecarInfo = {
      ...PEBBLE_PC,
      unavailable_capabilities: [{ name: 'terminal', reason: 'no shell' }],
    };
    expect(localBrowserWillServe({ ...defaultInstall(), sidecars: [noShell] })).toBe(false);
    // An empty list is no exclusion at all.
    const nothingUnavailable: SidecarInfo = { ...PEBBLE_PC, unavailable_capabilities: [] };
    expect(localBrowserWillServe({
      ...defaultInstall(),
      sidecars: [nothingUnavailable],
    })).toBe(false);
  });

  test('the two predicates no longer both refuse the same inventory', () => {
    const routing = unavailableInstall();
    // The remote side filters it out and has nothing to ask...
    expect(remoteBrowserPebbleTarget(routing)).toBeNull();
    // ...which is only correct because the local side now claims it.
    expect(localBrowserWillServe(routing)).toBe(true);
  });

  test('and it narrates a real LOCAL point rather than "(location unknown)"', async () => {
    // The end of the disagreement, asserted as a coordinate: 11 + 1000 and
    // 22 + 2000, the cached element offset by the viewport origin.
    const seen = fakeBrowserSidecar(() => SIDECAR_POINT);
    const { deps, localReads, origin } = wiredDeps(unavailableInstall());
    expect(await browserElementNarration(5, deps)).toEqual({ kind: 'point', x: 1011, y: 2022 });
    expect(localReads).toEqual([5]);
    expect(origin()).toBe(1);
    // No RPC: the coordinates were here all along.
    expect(seen).toEqual([]);
  });

  test('the filter is reachable through NarrationRouting, not just through SidecarInfo', async () => {
    // `remote-element-point.ts` filters on `unavailable_capabilities`, and that
    // was sound only because the daemon passed `listSidecars()` through
    // verbatim -- the field was absent from `NarrationRouting`, so TypeScript
    // could not see it and any narrower literal silently disabled the filter.
    // Now it is declared, so this drives the filter at the narration's own type.
    const seen = fakeBrowserSidecar(() => SIDECAR_POINT);
    // A FRESH literal, not a `SidecarInfo` variable: TypeScript's
    // excess-property check applies only to literals, so writing it inline is
    // what makes this test fail to COMPILE if the declaration is reverted.
    // Through a variable it would keep compiling and keep passing, proving the
    // runtime filter but not the type it is named for.
    const routing: NarrationRouting = {
      ...unavailableInstall(),
      sidecars: [{
        id: 'sc-pc',
        connected: true,
        hostname: 'workbench',
        capabilities: ['browser'],
        unavailable_capabilities: [{ name: 'browser' }],
      }],
    };
    expect(remoteBrowserPebbleTarget(routing)).toBeNull();
    // The predicate is a GATE, not a hint, so drive the whole narration: no
    // coordinate may come from a machine the router would have skipped, and
    // asserting that on a call which never dispatches would assert nothing.
    const out = await remoteBrowserNarration(routing, 5);
    expect(out.kind).toBe('unplaced');
    expect(seen).toEqual([]);
  });
});
