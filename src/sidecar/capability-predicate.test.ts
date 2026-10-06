/**
 * Guards the shared capability predicate and the import-free property that
 * made sharing it a design decision rather than an extraction (#611).
 *
 * Two different kinds of assertion live here on purpose.
 *
 * The BEHAVIOURAL ones pin the three terms, and particularly the fail-closed
 * answer for an absent `capabilities` array -- because the one call site in the
 * tree that is NOT on this helper answers the opposite there, and a future
 * reader who moves it mechanically needs a test that says which way this one
 * goes.
 *
 * The STRUCTURAL ones pin the import graph. #611's whole premise is that a
 * comment asking people to remember something does not hold, so the constraint
 * it names -- `pebble-narration.ts` must stay testable with no daemon, no
 * sidecar and no browser -- is checked rather than requested. Note what that
 * property is and is not: it is about the SHIPPED modules' imports, not about
 * what a test costs to stand up. `pebble-narration.test.ts` imports plenty.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { servesCapability, type CapabilityBearer } from './capability-predicate.ts';

/** A connected sidecar that advertises `browser` and reports nothing unavailable. */
const ok: CapabilityBearer = { connected: true, capabilities: ['browser', 'desktop'] };

describe('#611 servesCapability answers all three terms', () => {
  test('yes when connected, advertised and not unavailable', () => {
    expect(servesCapability(ok, 'browser')).toBe(true);
    expect(servesCapability(ok, 'desktop')).toBe(true);
  });

  test('no when disconnected, whatever it advertises', () => {
    expect(servesCapability({ ...ok, connected: false }, 'browser')).toBe(false);
    expect(servesCapability({ capabilities: ['browser'] }, 'browser')).toBe(false);
  });

  test('no for a capability it does not advertise', () => {
    expect(servesCapability(ok, 'filesystem')).toBe(false);
  });

  test('no when advertised but reported unavailable', () => {
    // The term that is easy to drop, and the one whose absence #590 found: a
    // sidecar with no Chromium advertises `browser` AND lists it unavailable.
    // Matching on the advertisement alone answers "a browser lives elsewhere"
    // for a call that is about to run locally.
    expect(servesCapability(
      { ...ok, unavailable_capabilities: [{ name: 'browser' }] },
      'browser',
    )).toBe(false);
    // Unavailability is per capability, not a blanket.
    expect(servesCapability(
      { ...ok, unavailable_capabilities: [{ name: 'browser' }] },
      'desktop',
    )).toBe(true);
  });

  test('FAIL-CLOSED on an absent capabilities array', () => {
    // The deliberate divergence from the dispatch gate in sidecar-route.ts,
    // whose `if (sidecar.capabilities && !...includes(cap))` ALLOWS this case.
    // An inventory entry that has not said what it serves is not evidence that
    // it serves this. Anyone moving that gate onto this helper is changing
    // behaviour, and this test is where they find that out.
    expect(servesCapability({ connected: true }, 'browser')).toBe(false);
    expect(servesCapability({ connected: true, capabilities: [] }, 'browser')).toBe(false);
  });

  test('a missing connected flag is not a connected sidecar', () => {
    expect(servesCapability({ capabilities: ['browser'] }, 'browser')).toBe(false);
  });

  test('it answers exactly what the copies it replaced answered, and what the router answers', () => {
    // The property the whole change rests on, so it is measured rather than
    // argued. An earlier draft used `=== true` instead of truthiness and
    // diverged on 6 of these inputs -- and it diverged in the UNSAFE
    // direction: `localBrowserWillServe` returns false when ANY sidecar serves
    // the capability, so a predicate WEAKER than the router's makes the
    // narration read this process's local coordinate cache for a click the
    // router sends elsewhere. That is #585.
    // THESE THREE ARE TRANSCRIPTIONS of the pre-#611 source (the two replaced
    // copies and the router's loop body). Do NOT "tidy" them into calls to
    // servesCapability -- that would make this test assert that a function
    // equals itself, which is exactly the coverage it exists to provide.
    const wasPebbleNarration = (s: any) => !!s.connected
      && !!s.capabilities?.includes('browser')
      && !s.unavailable_capabilities?.some((u: any) => u.name === 'browser');
    const wasRemoteElementPoint = (s: any) => !!(s.connected
      && s.capabilities?.includes('browser')
      && !s.unavailable_capabilities?.some((u: any) => u.name === 'browser'));
    // src/actions/tools/sidecar-route.ts autoTargetForCapability, as a loop
    // body: skip unconnected, skip unavailable, accept when advertised.
    const router = (s: any) => {
      if (!s.connected) return false;
      if (s.unavailable_capabilities?.some((u: any) => u.name === 'browser')) return false;
      return !!(s.capabilities && s.capabilities.includes('browser'));
    };

    const connectedValues = [undefined, null, false, true, 0, 1, '', 'x', NaN, {}];
    const capabilityLists = [undefined, [], ['browser'], ['other'], ['browser', 'x']];
    const unavailableLists = [undefined, [], [{ name: 'browser' }], [{ name: 'other' }]];

    let checked = 0;
    for (const connected of connectedValues) {
      for (const capabilities of capabilityLists) {
        for (const unavailable_capabilities of unavailableLists) {
          const s: any = { connected, capabilities, unavailable_capabilities };
          const got = servesCapability(s, 'browser');
          const where = JSON.stringify({ connected: String(connected), capabilities, unavailable_capabilities });
          expect(got, `vs pebble-narration copy at ${where}`).toBe(wasPebbleNarration(s));
          expect(got, `vs remote-element-point copy at ${where}`).toBe(wasRemoteElementPoint(s));
          expect(got, `vs autoTargetForCapability at ${where}`).toBe(router(s));
          checked++;
        }
      }
    }
    expect(checked).toBe(200);
  });
});

describe('#611 the leaf stays a leaf, and its caller stays assertable alone', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  /** Every static import/export-from specifier in a source file. */
  const specifiers = (src: string): string[] => [
    ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]!).concat(
    [...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
  );

  test('capability-predicate.ts imports nothing at all', () => {
    // If this file ever grows a dependency, it stops being usable from
    // pebble-narration.ts and the sharing in #611 has to be undone.
    expect(specifiers(read('./capability-predicate.ts'))).toEqual([]);
  });

  test('capability-predicate.ts has no runtime requires or dynamic imports either', () => {
    const src = read('./capability-predicate.ts');
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });

  test('pebble-narration.ts imports only this leaf', () => {
    // The constraint #611 names. It imported nothing before; it may now import
    // this one module and nothing else, because this module costs nothing to
    // stand up. A second entry here means the fail-closed routing decision is
    // no longer provable by reading that one file.
    expect(specifiers(read('../daemon/pebble-narration.ts')))
      .toEqual(['../sidecar/capability-predicate.ts']);
  });

  test('pebble-narration.ts has no dynamic imports', () => {
    const src = read('../daemon/pebble-narration.ts');
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});

describe('#611 no copy of the predicate is left in the files that moved', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const MOVED = ['../daemon/pebble-narration.ts', '../actions/browser/remote-element-point.ts'];

  for (const file of MOVED) {
    test(`${file} has no hand-rolled capability test of any shape`, () => {
      const src = read(file);
      // Two patterns, because one is not enough. A verbatim copy-paste brings
      // back the `unavailable_capabilities?.some(...)` scan -- but the drift
      // the header calls DANGEROUS is a copy that keeps `connected &&
      // capabilities.includes(X)` and drops the unavailability term entirely,
      // which the first pattern cannot see. Matching the advertisement test
      // catches both, and is safe here because neither file has any remaining
      // reason to call `.includes` on a capability list.
      expect(src).not.toMatch(/unavailable_capabilities\s*\)?\s*\??\.\s*(some|find|filter)\s*\(/);
      expect(src).not.toMatch(/capabilities\s*\)?\s*\??\.\s*includes\s*\(/);
    });

    test(`${file} routes the question through the shared predicate exactly once`, () => {
      // An inline check can sit happily NEXT TO a shared call, so presence is
      // not enough; the count is what says the shared call is the only answer.
      const calls = read(file).match(/servesCapability\s*\(/g) ?? [];
      expect(calls.length).toBe(1);
    });
  }
});

describe('#611 the record of the remaining copies is complete and enforced', () => {
  const header = readFileSync(new URL('./capability-predicate.ts', import.meta.url), 'utf8');

  test('it names every site that still holds its own version', () => {
    // The one place #611 asked for, instead of comments each asking the reader
    // to remember the others. A follow-up that moves one edits this list.
    for (const site of [
      'autoTargetForCapability',
      'src/actions/tools/sidecar-route.ts',
      'resolveTarget',
      'assertDispatch',
      'src/workflows/runtime/machine-binding.ts',
      'dispatchToSidecar',
    ]) {
      expect(header, `the header stopped naming ${site}`).toContain(site);
    }
  });

  test('it keeps flagging the one copy whose semantics differ', () => {
    // Loose match: this must survive a comment reflow, because the thing being
    // pinned is that the warning still exists, not its exact wording.
    expect(header).toMatch(/does not match/i);
    expect(header).toMatch(/fail[- ]open|absent `?capabilities`? array/i);
  });

  test('it states the drift rule in the non-inverted direction', () => {
    // An earlier draft said "stricter is the safe direction", which is
    // backwards: localBrowserWillServe treats "nobody serves it" as licence to
    // read the LOCAL cache, so matching too FEW sidecars is the #585 failure.
    // Pinned because this paragraph is what a future editor will key off.
    //
    // Asserted positively only. A negative match on the old wording is not
    // usable here: the header QUOTES it in order to reject it, so banning the
    // phrase would ban the correction along with the mistake.
    expect(header).toMatch(/never match FEWER/i);
    expect(header).toMatch(/DIRECTION THE DRIFT IS DANGEROUS/i);
    // And the reason the one real divergence is inert must stay reachability,
    // not strictness -- that was the substance of the error.
    // Single token: comment reflow puts a "\n * " inside any longer phrase.
    expect(header).toMatch(/ALREADY-RESOLVED/i);
    expect(header).toMatch(/reachability, not strictness/i);
  });
});

describe('#611 no seventh copy appears elsewhere in the tree', () => {
  // The risk #611 actually names is "the fourth copy", i.e. a NEW file. The
  // two-file guard above cannot see that, so this one sweeps src/ and holds an
  // allowlist of the sites the header records. A new file answering this
  // question fails here, which is what turns the header from advisory into
  // enforced.
  const ALLOWED = new Set([
    // The four recorded copies, pending the follow-up that moves them.
    'src/actions/tools/sidecar-route.ts',
    'src/workflows/runtime/machine-binding.ts',
    // Declares the field; routes nothing.
    'src/sidecar/types.ts',
    // Displays the reasons to an operator; asks which, not whether.
    'src/actions/tools/sidecar-list.ts',
    // F09 carries unavailable names into Q13's live qualification facts; no routing predicate.
    'src/daemon/index.ts',
    // Carries the field across the wire.
    'src/sidecar/manager.ts',
    // The shared predicate and its own test.
    'src/sidecar/capability-predicate.ts',
    'src/sidecar/capability-predicate.test.ts',
    // Declares the field on its routing type on purpose; no longer tests it.
    'src/daemon/pebble-narration.ts',
    'src/actions/browser/remote-element-point.ts',
  ]);

  test('every file touching unavailable_capabilities is one we know about', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const out = Bun.spawnSync({
      // Production sources only. Test files legitimately build inventory
      // fixtures carrying this field, and a fixture routes nothing.
      cmd: [
        'grep', '-rl', '--include=*.ts', '--exclude=*.test.ts',
        'unavailable_capabilities', 'src/',
      ],
      cwd: root,
      // Git-spawning tests must strip GIT_*; grep does not spawn git, but the
      // same hygiene keeps a hook-inherited env from reaching a subprocess.
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    });
    const files = new TextDecoder().decode(out.stdout).split('\n').filter(Boolean).sort();
    expect(files.length).toBeGreaterThan(0);
    const unknown = files.filter((f) => !ALLOWED.has(f));
    expect(
      unknown,
      `new file(s) read unavailable_capabilities: either call servesCapability() `
      + `or add them to the allowlist AND to the header's record in `
      + `src/sidecar/capability-predicate.ts`,
    ).toEqual([]);
  });
});
