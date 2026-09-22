/**
 * The coupling invariant from #483 requirement 4, tested against the real
 * registry rather than a hand-written fixture.
 *
 * #475's filter shipped a hand-written 28-tool fixture that included
 * `ask_for_clarification` as though it were registered -- which it never is.
 * That fixture hid the off-by-one in its fail-open guard AND meant that
 * adding a real tool into a droppable group would have been caught by
 * nothing. Every fixture here is derived from BUILTIN_TOOLS, so a new tool
 * is covered the day it is registered.
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../builtin.ts';
import type { ToolDefinition } from '../registry.ts';
import { isUntrustedSourceTool } from '../../../roles/untrusted.ts';
import {
  outsideReach,
  authorityRank,
  hasExplicitAction,
  isFloorEligible,
  isFramedPerception,
  isInvariantTrigger,
  PERCEPTION_RANK_CEILING,
  FLOOR_RANK_CEILING,
} from './authority-classes.ts';
import { normalizeToolSet, checkFramingInvariant } from './invariant.ts';

const A = BUILTIN_TOOLS;
const byName = (n: string): ToolDefinition => {
  const t = A.find((x) => x.name === n);
  if (!t) throw new Error(`no such builtin tool: ${n}`);
  return t;
};
const names = (ts: readonly ToolDefinition[]) => ts.map((t) => t.name).sort();

describe('classification', () => {
  test('every browser-category tool classifies as framed', () => {
    // The trap this guards: `isUntrustedSourceTool` makes browser tools
    // framed ONLY via `category === 'browser'` -- not one browser_* name is
    // in UNTRUSTED_TOOL_NAMES. `LLMTool` has no `category` field, so a filter
    // written against the mapped LLM tool list would classify every browser
    // tool as NOT framed, drop them all for a research turn, keep
    // run_command, and its own invariant check would pass. This test and the
    // ToolDefinition-typed signature are what stop that.
    const browsers = A.filter((t) => t.category === 'browser');
    expect(browsers.length).toBeGreaterThan(0);
    for (const t of browsers) expect(outsideReach(t)).toBe('framed');
  });

  test('framed is derived from isUntrustedSourceTool, never declared', () => {
    for (const t of A) {
      expect(outsideReach(t) === 'framed').toBe(isUntrustedSourceTool(t.name, t.category));
    }
  });

  test('an unmapped tool gets rank Infinity, so it can never reach the floor', () => {
    // This filter does not trust `getActionForTool`'s default for an unmapped
    // tool, whatever that default is. #503 mapped `manage_workflow` and the
    // eight site-builder tools (and made the default fail closed), so the
    // stand-in here is a name in no map at all -- the property under test is
    // "unmapped", not "site-builder".
    const unmapped: ToolDefinition = {
      name: 'some_unregistered_shell', description: 'shell', category: 'site-builder',
      parameters: {}, execute: async () => '',
    };
    expect(hasExplicitAction(unmapped)).toBe(false);
    expect(authorityRank(unmapped)).toBe(Number.POSITIVE_INFINITY);
    expect(isFloorEligible(unmapped)).toBe(false);
    expect(isInvariantTrigger(unmapped)).toBe(true);
  });

  test('an undeclared tool defaults to fetch, the conservative class', () => {
    const novel: ToolDefinition = {
      name: 'some_future_tool', description: 'x', category: 'general',
      parameters: {}, execute: async () => '',
    };
    expect(outsideReach(novel)).toBe('fetch');
    expect(isFloorEligible(novel)).toBe(false);
    expect(isInvariantTrigger(novel)).toBe(true);
  });

  test('run_command is a trigger and is never floor-eligible', () => {
    const shell = byName('run_command');
    expect(outsideReach(shell)).toBe('fetch');
    expect(isInvariantTrigger(shell)).toBe(true);
    expect(isFloorEligible(shell)).toBe(false);
  });

  test('the floor is low-authority, explicitly mapped and carries no outside text', () => {
    // #483 requirement 4's "better still": the always-set is the LOW-authority
    // tools and the privileged ones are what gets filtered.
    const floor = A.filter(isFloorEligible);
    expect(floor.length).toBeGreaterThan(0);
    for (const t of floor) {
      expect(outsideReach(t)).toBe('inert');
      expect(hasExplicitAction(t)).toBe(true);
      expect(authorityRank(t)).toBeLessThanOrEqual(FLOOR_RANK_CEILING);
      expect(isInvariantTrigger(t)).toBe(false);
    }
  });

  test('no framed or fetch tool is ever floor-eligible', () => {
    for (const t of A) {
      if (outsideReach(t) === 'framed' || outsideReach(t) === 'fetch') {
        expect(isFloorEligible(t)).toBe(false);
      }
    }
  });

  test('replay tools are droppable but never floor-eligible', () => {
    // An earlier draft pinned these into the always-set, which is strictly
    // worse than the status quo: a tool that echoes stored outside text in
    // every single turn, removable by nothing.
    for (const t of A.filter((x) => outsideReach(x) === 'replay')) {
      expect(isFloorEligible(t)).toBe(false);
      expect(isInvariantTrigger(t)).toBe(false);
    }
  });

  test('perception is the framed readers, actors excluded, regardless of rank', () => {
    const perception = names(A.filter(isFramedPerception));
    for (const n of ['browser_navigate', 'ui_snapshot', 'desktop_snapshot', 'read_file', 'get_clipboard']) {
      expect(perception).toContain(n);
    }
    // Framed ACTORS are excluded by name, not by rank.
    for (const n of ['run_skill', 'record_skill', 'browser_upload_file']) {
      expect(`${n}:${isFramedPerception(byName(n))}`).toBe(`${n}:false`);
    }
  });

  test('a framed reader above the rank ceiling is still perception', () => {
    // Rank lies about both of these, in opposite directions, which is why
    // membership is no longer a rank test.
    //
    // ui_act is 505 because that is the floor for its WORST action, but
    // `get_value` is in its own READ_ONLY_ACTIONS and its authorityGate
    // returns null for it, and `expand` / `scroll_into_view` are the only
    // way to reveal collapsed content for the next ui_snapshot. Without it
    // the desktop surface gets framed eyes and no framed hands, and the
    // model reaches for capture_screen instead -- which is `fetch`.
    //
    // browser_evaluate is execute_command/506, the SAME rank as
    // run_command. Dropping the framed one while keeping the unframed one
    // is a rank tie, not a step down.
    for (const n of ['ui_act', 'browser_evaluate']) {
      expect(`${n}:${isFramedPerception(byName(n))}`).toBe(`${n}:true`);
      expect(authorityRank(byName(n))).toBeGreaterThan(PERCEPTION_RANK_CEILING);
    }
  });

  test('browser_upload_file is framed but never force-added', () => {
    // It maps to write_data (302), so a `rank <= 504` rule swept this
    // exfiltration path into every turn that kept the shell.
    const up = byName('browser_upload_file');
    expect(outsideReach(up)).toBe('framed');
    expect(authorityRank(up)).toBeLessThan(PERCEPTION_RANK_CEILING);
    expect(isFramedPerception(up)).toBe(false);
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), byName('run_command')]);
    expect(r.repaired).not.toContain('browser_upload_file');
  });

  test('every above-access_browser tool is a trigger, framed or not', () => {
    // The clause that stops `FLOOR + desktop actuators, no perception` from
    // being invariant-clean.
    for (const t of A) {
      if (authorityRank(t) > PERCEPTION_RANK_CEILING) expect(isInvariantTrigger(t)).toBe(true);
    }
    expect(isInvariantTrigger(byName('desktop_click'))).toBe(true);
  });
});

describe('I1 - framing non-regression', () => {
  const PERCEPTION = A.filter(isFramedPerception);

  test('the #475 set is rejected: run_command with no framed perception', () => {
    // Literally the rejected behaviour: a "knowledge" turn keeps the shell
    // and drops every browser/desktop/ui perception tool.
    const bad = [...A.filter(isFloorEligible), byName('run_command')];
    const v = checkFramingInvariant(A, bad);
    expect(v).not.toBeNull();
    expect(v!.invariant).toBe('I1');
    expect(v!.detail).toContain('run_command');
  });

  test('normalize repairs it by union, and the result keeps the shell', () => {
    const bad = [...A.filter(isFloorEligible), byName('run_command')];
    const r = normalizeToolSet(A, bad);
    expect(r.failedOpen).toBe(false);
    const got = new Set(r.tools.map((t) => t.name));
    // The capability is NOT removed -- union, never subtraction.
    expect(got.has('run_command')).toBe(true);
    for (const t of PERCEPTION) expect(got.has(t.name)).toBe(true);
    expect(r.repaired).toContain('browser_navigate');
  });

  test('no candidate set can yield run_command without the framed readers', () => {
    // Exhaustive over single-trigger candidates: for every trigger tool,
    // a floor+trigger candidate must come back with the whole perception set.
    for (const trigger of A.filter(isInvariantTrigger)) {
      const cand = [...A.filter(isFloorEligible), trigger];
      const r = normalizeToolSet(A, cand);
      expect(r.failedOpen).toBe(false);
      const got = new Set(r.tools.map((t) => t.name));
      for (const p of PERCEPTION) {
        expect(`${trigger.name}:${p.name}:${got.has(p.name)}`).toBe(`${trigger.name}:${p.name}:true`);
      }
    }
  });

  test('dropping the framed readers is allowed only when no trigger survives', () => {
    // The contrapositive: a set with no trigger may legitimately carry no
    // perception tool at all. This is where the token saving comes from.
    const quiet = A.filter((t) => isFloorEligible(t) || outsideReach(t) === 'replay');
    const r = normalizeToolSet(A, quiet);
    expect(r.failedOpen).toBe(false);
    expect(r.repaired).toEqual([]);
    expect(r.tools.some(isFramedPerception)).toBe(false);
    expect(r.tools.some(isInvariantTrigger)).toBe(false);
  });

  test('the repair preserves input order', () => {
    // A recompute that reshuffles the list invalidates the provider's cached
    // prefix for no reason.
    const bad = [byName('run_command'), ...A.filter(isFloorEligible)];
    const r = normalizeToolSet(A, bad);
    const order = r.tools.map((t) => t.name);
    const expected = A.filter((t) => order.includes(t.name)).map((t) => t.name);
    expect(order).toEqual(expected);
  });

  test('a partially-restored perception set still fails and is repaired', () => {
    // Someone re-adds only the browser tools and forgets ui_snapshot.
    const sneaky = [
      ...A.filter(isFloorEligible),
      byName('run_command'),
      ...A.filter((t) => t.category === 'browser' && isFramedPerception(t)),
    ];
    expect(checkFramingInvariant(A, sneaky)).not.toBeNull();
    const r = normalizeToolSet(A, sneaky);
    expect(r.failedOpen).toBe(false);
    expect(r.tools.map((t) => t.name)).toContain('ui_snapshot');
  });
});

describe('identity and shape of the returned set', () => {
  // These are regressions for probes that broke an earlier version of
  // normalizeToolSet. Each one was a real hole.

  test('duplicates in the candidate cannot reach the output', () => {
    // A tool list with a repeated name is an API error at most providers.
    const rc = byName('run_command');
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), rc, rc, rc]);
    expect(r.failedOpen).toBe(false);
    const out = r.tools.map((t) => t.name);
    expect(out.length).toBe(new Set(out).size);

    const doubledFloor = [...A.filter(isFloorEligible), ...A.filter(isFloorEligible)];
    const r2 = normalizeToolSet(A, doubledFloor);
    const out2 = r2.tools.map((t) => t.name);
    expect(out2.length).toBe(new Set(out2).size);
  });

  test('a stub object reusing a registered name cannot replace the real tool', () => {
    // Otherwise the model is shown a schema the registry will not honour.
    const stub: ToolDefinition = {
      name: 'browser_snapshot', description: 'STUB', category: 'general',
      parameters: {}, execute: async () => '',
    };
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), stub]);
    expect(r.failedOpen).toBe(false);
    const got = r.tools.find((t) => t.name === 'browser_snapshot');
    expect(got).toBe(byName('browser_snapshot'));
    expect(got!.description).not.toBe('STUB');
  });

  test('a stub named like a perception tool does not satisfy the invariant', () => {
    // The stub has category 'general', so it is not framed and cannot stand
    // in for the real browser tool the repair owes.
    const stubs = A.filter(isFramedPerception).map((t): ToolDefinition => ({
      name: t.name, description: 'STUB', category: 'general', parameters: {}, execute: async () => '',
    }));
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), byName('run_command'), ...stubs]);
    expect(r.failedOpen).toBe(false);
    for (const t of A.filter(isFramedPerception)) {
      expect(r.tools.find((x) => x.name === t.name)).toBe(t);
    }
  });

  test('every returned object is the registered one, in registry order', () => {
    const r = normalizeToolSet(A, [byName('run_command'), ...A.filter(isFloorEligible)]);
    for (const t of r.tools) expect(t).toBe(byName(t.name));
    const order = r.tools.map((t) => t.name);
    expect(order).toEqual(A.filter((t) => order.includes(t.name)).map((t) => t.name));
  });
});

describe('a scoped registry that never had perception tools', () => {
  test('keeping the shell is allowed when the call site offered no framed reader', () => {
    // The sub-agent case: `createScopedToolRegistry(['terminal','file-ops'])`
    // yields [run_command, read_file, write_file, list_directory]. I1 is
    // quantified over PERCEPTION(all), so there is nothing to restore beyond
    // read_file. This is the status quo for that agent, not a regression the
    // filter introduced -- and it must NOT be "fixed" by having the filter
    // add tools the call site never registered.
    const scoped = A.filter((t) => ['run_command', 'read_file', 'write_file', 'list_directory'].includes(t.name));
    const r = normalizeToolSet(scoped, scoped);
    expect(r.failedOpen).toBe(false);
    expect(r.tools.map((t) => t.name)).toContain('run_command');
    expect(r.tools.every((t) => scoped.includes(t))).toBe(true);
  });

  test('a registry with no framed reader at all still keeps the shell', () => {
    const shellOnly = A.filter((t) => isFloorEligible(t) || t.name === 'run_command');
    const r = normalizeToolSet(shellOnly, shellOnly);
    expect(r.failedOpen).toBe(false);
    expect(r.tools.filter(isFramedPerception)).toHaveLength(0);
    expect(r.tools.some((t) => t.name === 'run_command')).toBe(true);
  });
});

describe('I3 - subset and floor, the #475 off-by-one', () => {
  test('a floor tool dropped by the candidate fails open to the full list', () => {
    const floor = A.filter(isFloorEligible);
    expect(floor.length).toBeGreaterThan(0);
    const missingOne = A.filter((t) => t.name !== floor[0]!.name && isFloorEligible(t));
    const r = normalizeToolSet(A, missingOne);
    expect(r.failedOpen).toBe(true);
    expect(r.failures.some((f) => f.invariant === 'I3-floor')).toBe(true);
    expect(r.tools).toEqual([...A]);
  });

  test('a tool the call site never offered fails open rather than being laundered in', () => {
    const foreign: ToolDefinition = {
      name: 'not_registered', description: 'x', category: 'general',
      parameters: {}, execute: async () => '',
    };
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), foreign]);
    expect(r.failedOpen).toBe(true);
    expect(r.failures[0]!.invariant).toBe('I3-subset');
  });

  test('a synthetic tool in the candidate fails open rather than passing through', () => {
    // Synthetics are appended by the call site AFTER filtering, the way
    // `ask_for_clarification` already is. Nothing here accepts them, so
    // there is no name-exemption list for a caller to misuse.
    const synth: ToolDefinition = {
      name: 'discover_tools', description: 'x', category: 'general',
      parameters: {}, execute: async () => '',
    };
    const r = normalizeToolSet(A, [...A.filter(isFloorEligible), synth]);
    expect(r.failedOpen).toBe(true);
    expect(r.failures[0]!.invariant).toBe('I3-subset');
  });

  test('the guard does not depend on how many tools are registered', () => {
    // #475's guard was `filtered.length >= ALWAYS.size` against a 10-name
    // hard-coded list, so whether it engaged flipped on unrelated
    // registration config. Here a registry missing a conditionally-registered
    // tool simply has a smaller floor, and the check still holds.
    const reduced = A.filter((t) => t.name !== 'list_sidecars');
    const r = normalizeToolSet(reduced, reduced.filter(isFloorEligible));
    expect(r.failedOpen).toBe(false);
  });
});
