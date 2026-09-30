/**
 * #591: the pebble points at a browser action that runs on a sidecar, and says
 * so honestly when it cannot.
 *
 * These drive the real decision and the real reply decoder against a fake
 * sidecar, so no Chromium and no Go binary are involved -- the question is
 * entirely what the daemon does with a routing situation and a reply. The
 * sidecar's own half (can this RPC do more than read, is the coordinate
 * current) is tested in Go, in sidecar/browser_element_point_test.go.
 *
 * The cases worth naming are the ones that would let a WRONG pointer through,
 * because the feature's whole premise is that a wrong pointer is worse than
 * none: an ambiguous inventory, a pebble on a different machine from the
 * browser, a coerced coordinate, and an unrecognised coordinate space.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarInfo } from '../../sidecar/types.ts';
import {
  getSidecarManager, setSidecarManagerRef, routeBrowserElementPointToSidecar,
} from '../tools/sidecar-route.ts';
import { SidecarRPCError } from '../../sidecar/rpc.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import {
  remoteBrowserElementPoint,
  remoteBrowserNarration,
  remoteBrowserPebbleTarget,
  type RemotePointRouting,
} from './remote-element-point.ts';

const sidecar = (over: Partial<SidecarInfo> = {}): SidecarInfo => ({
  id: 'sc-pc', name: 'Desk PC', enrolled_at: '2026-01-01', last_seen_at: '2026-01-02',
  status: 'enrolled', connected: true, hostname: 'desk-pc', os: 'linux', platform: 'amd64',
  capabilities: ['browser'],
  ...over,
});

/** A sidecar that answers `browser_element_point` with `reply`. */
function fakeSidecar(
  reply: (params: Record<string, unknown>) => unknown,
  sidecars: SidecarInfo[] = [sidecar()],
) {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  setSidecarManagerRef({
    listSidecars: () => sidecars,
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      seen.push({ method, params });
      return reply(params);
    },
  } as unknown as SidecarManager);
  return seen;
}

const routing = (over: Partial<RemotePointRouting> = {}): RemotePointRouting => ({
  pebbleSidecarId: 'sc-pc',
  sidecars: [sidecar()],
  machineScoped: false,
  args: {},
  ...over,
});

const GOOD = { x: 437, y: 484, space: 'screen_dip', loader_id: 'L1' };

// Capture and RESTORE, rather than nulling: `sidecarManager` is a module
// singleton and `bun test` shares the module registry across files, so putting
// back what was there is the only reset that cannot affect another suite.
const priorManager = getSidecarManager();
afterEach(() => {
  setSidecarManagerRef(priorManager as unknown as SidecarManager);
});

describe('which sidecar may be asked (#591)', () => {
  test('the single connected browser sidecar that also draws the pebble', () => {
    expect(remoteBrowserPebbleTarget(routing())).toBe('sc-pc');
  });

  test('refuses an explicitly named target rather than resolving it a second way', () => {
    // findSidecar's last resort is a SUBSTRING match on the name, so honouring
    // a named target would mean a second, looser resolution of which machine
    // serves the call -- resolved at a different instant than the tool's own.
    expect(remoteBrowserPebbleTarget(routing({ args: { target: 'Desk' } }))).toBeNull();
    expect(remoteBrowserPebbleTarget(routing({ args: { target: 'sc-pc' } }))).toBeNull();
  });

  test('a blank target is no target at all', () => {
    expect(remoteBrowserPebbleTarget(routing({ args: { target: '   ' } }))).toBe('sc-pc');
  });

  test('refuses while a workflow machine binding is in force', () => {
    expect(remoteBrowserPebbleTarget(routing({ machineScoped: true }))).toBeNull();
  });

  test('refuses when TWO sidecars could serve the browser', () => {
    // The router takes whichever comes first in listSidecars() order; this
    // module must not guess at that.
    expect(remoteBrowserPebbleTarget(routing({
      sidecars: [sidecar(), sidecar({ id: 'sc-mac', name: 'Mac', hostname: 'mac' })],
    }))).toBeNull();
  });

  test('refuses when the browser sidecar is NOT the one drawing the pebble', () => {
    // The coordinate is a position on the browser sidecar's screen. Pointing at
    // it on another machine's screen is a confident mark where the user is not
    // looking -- the exact failure #585 exists to remove.
    expect(remoteBrowserPebbleTarget(routing({
      sidecars: [sidecar({ id: 'sc-mac' })],
      pebbleSidecarId: 'sc-pc',
    }))).toBeNull();
  });

  test('refuses a disconnected sidecar, and one whose browser capability is unavailable', () => {
    expect(remoteBrowserPebbleTarget(routing({ sidecars: [sidecar({ connected: false })] }))).toBeNull();
    expect(remoteBrowserPebbleTarget(routing({
      sidecars: [sidecar({ unavailable_capabilities: [{ name: 'browser', reason: 'no chromium' }] })],
    }))).toBeNull();
  });

  test('refuses a sidecar that does not advertise the browser capability', () => {
    expect(remoteBrowserPebbleTarget(routing({ sidecars: [sidecar({ capabilities: ['terminal'] })] }))).toBeNull();
  });
});

describe('what is sent (#591)', () => {
  test('only element_id -- not the tool arguments, and never headless or target', async () => {
    const seen = fakeSidecar(() => GOOD);
    const out = await remoteBrowserNarration(
      routing({ args: { element_id: 5, headless: true, text: 'secret' } }), 5,
    );
    expect(out).toEqual({ kind: 'point', x: 437, y: 484 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('browser_element_point');
    // `headless` on a sibling browser method tears the running browser down and
    // relaunches it. Nothing a model writes may reach this call.
    expect(seen[0]!.params).toEqual({ element_id: 5 });
  });
});

describe('reading the reply (#591)', () => {
  test('accepts the documented shape', async () => {
    fakeSidecar(() => GOOD);
    expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
      .toEqual({ kind: 'point', x: 437, y: 484, loaderId: 'L1' });
  });

  test('rounds a fractional coordinate rather than passing it on', async () => {
    fakeSidecar(() => ({ ...GOOD, x: 436.6, y: 483.4 }));
    expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
      .toEqual({ kind: 'point', x: 437, y: 483, loaderId: 'L1' });
  });

  // BOTH axes, parameterised. Varying only `x` left every `y` check
  // untested -- deleting all three of them kept the suite green, which is the
  // exact regression a later "simplify the guard" edit would introduce, over
  // the one value the whole feature exists to get right.
  test('refuses a coordinate that is a STRING or an ARRAY, which arithmetic would coerce', async () => {
    // The reply crossed a machine boundary through a validator that preserves
    // arrays verbatim, and Math.round(["431"]) is 431. A `number` annotation is
    // erased at runtime, so only the check stops this.
    for (const key of ['x', 'y'] as const) {
      for (const bad of ['437', ['437'], null, undefined, {}, true] as unknown[]) {
        fakeSidecar(() => ({ ...GOOD, [key]: bad }));
        expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
          .toEqual({ kind: 'none', why: 'unusable_reply' });
      }
    }
  });

  test('refuses NaN and Infinity on either axis', async () => {
    for (const key of ['x', 'y'] as const) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
        fakeSidecar(() => ({ ...GOOD, [key]: bad }));
        expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
          .toEqual({ kind: 'none', why: 'unusable_reply' });
      }
    }
  });

  test('accepts the widest coordinate it will pass on, and refuses one past it', async () => {
    // Pins the BOUNDARY, not a value far beyond it: widening the bound by five
    // orders of magnitude otherwise leaves the suite green.
    fakeSidecar(() => ({ ...GOOD, x: 1 << 20, y: -(1 << 20) }));
    expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
      .toEqual({ kind: 'point', x: 1 << 20, y: -(1 << 20), loaderId: 'L1' });

    for (const key of ['x', 'y'] as const) {
      for (const bad of [(1 << 20) + 1, -((1 << 20) + 1), (1 << 20) + 0.4, 1e12]) {
        fakeSidecar(() => ({ ...GOOD, [key]: bad }));
        expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
          .toEqual({ kind: 'none', why: 'unusable_reply' });
      }
    }
  });

  test('a polluted Object.prototype cannot fabricate a point out of an empty reply', async () => {
    // Every field is read as an OWN property. Dotted access walks the prototype
    // chain, so without that an empty reply would answer a complete, confident
    // point -- the one outcome this feature exists to prevent.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.x = 999;
      proto.y = 999;
      proto.space = 'screen_dip';
      proto.loader_id = 'INHERITED';
      fakeSidecar(() => ({}));
      expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
        .toEqual({ kind: 'none', why: 'unusable_reply' });
    } finally {
      delete proto.x;
      delete proto.y;
      delete proto.space;
      delete proto.loader_id;
    }
  });

  test('refuses an UNRECOGNISED coordinate space instead of reinterpreting it', async () => {
    // This is what makes the Windows DPI gap closable later without a flag day:
    // a measured conversion ships under a new space name, and a brain that does
    // not know it shows "(location unknown)" rather than misplacing the pointer.
    for (const space of ['screen_physical', 'css', '', 42, null, undefined]) {
      fakeSidecar(() => ({ ...GOOD, space }));
      expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
        .toEqual({ kind: 'none', why: 'unusable_reply' });
    }
  });

  test('refuses a coordinate with no loader id, or an over-long one', async () => {
    // #594's pairing rule transposed: no coordinate without the identity of the
    // document it describes.
    for (const loader_id of [undefined, '', null, 7, ['L1'], 'x'.repeat(129)] as unknown[]) {
      fakeSidecar(() => ({ ...GOOD, loader_id }));
      expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
        .toEqual({ kind: 'none', why: 'unusable_reply' });
    }
  });

  test('refuses a reply that is a bare string, an array, or null', async () => {
    for (const reply of ['437,484', [437, 484], null, 42] as unknown[]) {
      fakeSidecar(() => reply);
      expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
        .toEqual({ kind: 'none', why: 'unusable_reply' });
    }
  });
});

describe('version pairing (#591)', () => {
  test('an OLDER sidecar is detected by the error CODE, not by its message', async () => {
    // The message for METHOD_NOT_FOUND asserts the browser capability is
    // disabled, which for a sidecar that merely predates the method is the
    // wrong diagnosis. Classified structurally instead.
    fakeSidecar(() => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'Unknown method: browser_element_point'); });
    expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
      .toEqual({ kind: 'none', why: 'sidecar_too_old' });
  });

  test("the sidecar's own coded refusals read as a refusal, not as a missing method", async () => {
    for (const code of ['BROWSER_NOT_RUNNING', 'BROWSER_SNAPSHOT_STALE', 'BROWSER_GEOMETRY_UNAVAILABLE']) {
      fakeSidecar(() => { throw new SidecarRPCError(code, 'nope'); });
      expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
        .toEqual({ kind: 'none', why: 'refused' });
    }
  });

  test('an offline or unknown sidecar reads as no reply', async () => {
    fakeSidecar(() => GOOD, [sidecar({ connected: false })]);
    expect(await routeBrowserElementPointToSidecar('sc-pc', 1))
      .toEqual({ kind: 'none', why: 'no_reply' });
    fakeSidecar(() => GOOD, []);
    expect(await routeBrowserElementPointToSidecar('sc-nope', 1))
      .toEqual({ kind: 'none', why: 'no_reply' });
  });

  test('nothing ever falls back to browser_evaluate or to a second RPC', async () => {
    const seen = fakeSidecar(() => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'Unknown method'); });
    await remoteBrowserNarration(routing(), 5);
    // One dispatch, and it is the read-only one. browser_evaluate is
    // execute_command authority and could launch a headed Chromium.
    expect(seen.map((s) => s.method)).toEqual(['browser_element_point']);
  });
});

describe('the reason a narration carries when there is no pointer (#591)', () => {
  test('names the machine that would not give one, so the caller can log it', async () => {
    // The caller writes "no pebble pointer for <tool>: <reason>", so the reason
    // is what has to carry the machine -- and this module keeps no log sink of
    // its own to duplicate that line or to leave untested.
    fakeSidecar(() => { throw new SidecarRPCError('METHOD_NOT_FOUND', 'Unknown method'); });
    const out = await remoteBrowserElementPoint('sc-pc', 5);
    expect(out.kind).toBe('unplaced');
    if (out.kind !== 'unplaced') return;
    expect(out.reason).toContain('sc-pc');
    expect(out.reason).toContain('predates');
  });

  test("never carries the sidecar's own message, which can hold a page URL", async () => {
    // The local-content refusal's shared wording interpolates the page URL, and
    // #594 refused to put a URL in a log line: a refused URL is the value most
    // likely to be carrying the characters that must not reach one.
    fakeSidecar(() => {
      throw new SidecarRPCError('BROWSER_SNAPSHOT_STALE',
        'Refusing to read file:///home/someone/secret-plans.html: ...');
    });
    const out = await remoteBrowserElementPoint('sc-pc', 5);
    expect(out.kind).toBe('unplaced');
    if (out.kind !== 'unplaced') return;
    expect(out.reason).not.toContain('secret-plans');
    expect(out.reason).not.toContain('file://');
    expect(out.reason).not.toContain('Refusing');
  });

  test('a distinct reason per refusal, all four of them', async () => {
    const reasons = new Set<string>();
    for (const err of [
      new SidecarRPCError('METHOD_NOT_FOUND', 'x'),
      new SidecarRPCError('BROWSER_NOT_RUNNING', 'x'),
    ]) {
      fakeSidecar(() => { throw err; });
      const out = await remoteBrowserElementPoint('sc-pc', 5);
      if (out.kind === 'unplaced') reasons.add(out.reason);
    }
    fakeSidecar(() => ({ ...GOOD, space: 'nonsense' }));
    const bad = await remoteBrowserElementPoint('sc-pc', 5);
    if (bad.kind === 'unplaced') reasons.add(bad.reason);
    fakeSidecar(() => GOOD, [sidecar({ connected: false })]);
    const off = await remoteBrowserElementPoint('sc-pc', 5);
    if (off.kind === 'unplaced') reasons.add(off.reason);
    expect(reasons.size).toBe(4);
  });

  test('a dispatch that THROWS is turned into words, not propagated', async () => {
    // The dispatch resolves a workflow machine binding before its own try
    // block, so a blocked binding throws past it. A cosmetic narration must not
    // fail the turn.
    setSidecarManagerRef({
      listSidecars: () => {
        throw new ActionOutcomeError({
          status: 'blocked', code: 'WORKFLOW_RETARGET_REQUIRED',
          message: 'bound elsewhere', effect: 'not_started',
        });
      },
    } as unknown as SidecarManager);
    const out = await remoteBrowserElementPoint('sc-pc', 5);
    expect(out.kind).toBe('unplaced');
    if (out.kind !== 'unplaced') return;
    // The CODE, which is brain-authored; never the message.
    expect(out.reason).toContain('WORKFLOW_RETARGET_REQUIRED');
    expect(out.reason).not.toContain('bound elsewhere');
  });
});

describe('the routing predicate is a gate, not a hint (#591)', () => {
  test('when there is no askable sidecar, NO RPC is sent', async () => {
    const seen = fakeSidecar(() => GOOD, [sidecar({ id: 'sc-mac' })]);
    const out = await remoteBrowserNarration(routing({ sidecars: [sidecar({ id: 'sc-mac' })] }), 5);
    expect(out.kind).toBe('unplaced');
    // The property that makes the predicate a gate: nothing was asked.
    expect(seen).toEqual([]);
  });

  test('an element_id that is not a snapshot id is refused without an RPC', async () => {
    // Checked here too because this is an exported boundary and `number` is
    // erased -- and `routing` carries `args`, so passing `args.element_id`
    // straight through is the natural mistake for a second caller.
    for (const bad of [0, -1, 1.5, Number.NaN, '5' as unknown as number]) {
      const seen = fakeSidecar(() => GOOD);
      const out = await remoteBrowserNarration(routing(), bad);
      expect(out.kind).toBe('unplaced');
      expect(seen).toEqual([]);
    }
  });
});
