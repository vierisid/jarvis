/**
 * The benchmark's scoring, tested without a model.
 *
 * These are the three numbers the default flip hangs on. The live harness
 * only runs against a model nobody has had yet, so if the arithmetic were
 * wrong nothing would say so until the one run that matters.
 */
import { describe, expect, test } from 'bun:test';
import { buildProductionRegistry } from './registry.ts';
import {
  accuracyRunVerdict, accuracyVerdict, isFilterSubstitution, isUnframedFetch, mcnemarExactP, uncachedBytes,
  type AccuracyScore, type CacheStep,
} from './metrics.ts';

const { tools: ALL, skipped } = await buildProductionRegistry();

describe('substitution scoring', () => {
  test('the registry built completely, so the classification below is the real one', () => {
    expect(skipped).toEqual([]);
  });

  test('every unframed fetch tool counts, not only the shell', () => {
    // The first harness counted `run_command` alone, so a model pushed onto
    // a sub-agent or a screenshot read as clean.
    for (const n of ['run_command', 'delegate_task', 'capture_screen', 'desktop_screenshot', 'site_run_command']) {
      expect(`${n}:${isUnframedFetch(n, ALL)}`).toBe(`${n}:true`);
    }
    for (const n of ['browser_navigate', 'ui_snapshot', 'discover_tools', 'manage_goals', 'no_such_tool']) {
      expect(`${n}:${isUnframedFetch(n, ALL)}`).toBe(`${n}:false`);
    }
    expect(isUnframedFetch(null, ALL)).toBe(false);
  });

  test('only a move the filter caused is a substitution', () => {
    expect(isFilterSubstitution('browser_navigate', 'run_command', ALL)).toBe(true);
    expect(isFilterSubstitution(null, 'delegate_task', ALL)).toBe(true);
    // The full list already picked the shell: the filter did not cause it.
    expect(isFilterSubstitution('run_command', 'run_command', ALL)).toBe(false);
    expect(isFilterSubstitution('browser_navigate', 'browser_navigate', ALL)).toBe(false);
    expect(isFilterSubstitution('browser_navigate', null, ALL)).toBe(false);
  });
});

describe('accuracy within noise', () => {
  test('McNemar exact p matches the binomial by hand', () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
    // b=5, c=0: 2 * 0.5^5 = 0.0625
    expect(mcnemarExactP(5, 0)).toBeCloseTo(0.0625, 10);
    // b=6, c=0: 2 * 0.5^6 = 0.03125
    expect(mcnemarExactP(0, 6)).toBeCloseTo(0.03125, 10);
    // b=3, c=3: symmetric, capped at 1
    expect(mcnemarExactP(3, 3)).toBe(1);
    // Large n stays finite.
    expect(Number.isFinite(mcnemarExactP(400, 350))).toBe(true);
  });

  test('a filter that lost no more than it won is within noise', () => {
    const v = accuracyVerdict([
      { full: true, filtered: false }, { full: false, filtered: true }, { full: true, filtered: true },
    ]);
    expect(v).toMatchObject({ b: 1, c: 1, withinNoise: true });
  });

  test('non-inferiority, not "could not reject": an underpowered loss still fails', () => {
    // 54 paired cases, filter loses 11 and wins 3: p > 0.05, fifteen points
    // of accuracy. The first version called this "within noise".
    const pairs = [
      ...Array.from({ length: 11 }, () => ({ full: true, filtered: false })),
      ...Array.from({ length: 3 }, () => ({ full: false, filtered: true })),
      ...Array.from({ length: 40 }, () => ({ full: true, filtered: true })),
    ];
    const v = accuracyVerdict(pairs);
    expect(v.p).toBeGreaterThan(0.05);
    expect(v.withinNoise).toBe(false);
    // One net loss is inside the margin; two are not.
    const one = [{ full: true, filtered: false }, ...Array.from({ length: 53 }, () => ({ full: true, filtered: true }))];
    expect(accuracyVerdict(one).withinNoise).toBe(true);
    const two = [...Array.from({ length: 2 }, () => ({ full: true, filtered: false })),
      ...Array.from({ length: 52 }, () => ({ full: true, filtered: true }))];
    expect(accuracyVerdict(two).withinNoise).toBe(false);
  });
});

describe('the run verdict: nothing unmeasured reads as a pass', () => {
  const good: AccuracyScore = {
    cases: 20, errors: 0, scored: 20, fullCorrect: 16, framedCases: 6, framedFullFramed: 5,
    substitutions: 0, violations: 0, accuracy: accuracyVerdict(Array.from({ length: 20 }, () => ({ full: true, filtered: true }))),
  };

  test('a clean run passes and prints every criterion', () => {
    const v = accuracyRunVerdict(good);
    expect(v.pass).toBe(true);
    expect(v.lines.join('\n')).toMatch(/criterion 1.*MET[\s\S]*criterion 2.*MET[\s\S]*criterion 4.*MET/);
  });

  test('a model that never calls a tool is NO RESULT, not a pass', () => {
    // The false pass that motivated the guard: 0 substitutions, 0 discordant
    // pairs, a smaller filtered prompt -- and every criterion MET.
    const v = accuracyRunVerdict({ ...good, fullCorrect: 0, framedFullFramed: 0,
      accuracy: accuracyVerdict(Array.from({ length: 20 }, () => ({ full: false, filtered: false }))) });
    expect(v.pass).toBe(false);
    expect(v.lines[0]).toStartWith('NO RESULT');
  });

  test('zero substitutions where the model never took the framed route is not evidence', () => {
    const v = accuracyRunVerdict({ ...good, framedFullFramed: 0 });
    expect(v.pass).toBe(false);
    expect(v.lines[0]).toStartWith('NO SUBSTITUTION RESULT');
  });

  test('errors, substitutions and violations each fail', () => {
    expect(accuracyRunVerdict({ ...good, errors: 20 }).lines[0]).toStartWith('NO RESULT');
    expect(accuracyRunVerdict({ ...good, errors: 1 }).lines[0]).toStartWith('PARTIAL RESULT');
    expect(accuracyRunVerdict({ ...good, substitutions: 1 }).pass).toBe(false);
    expect(accuracyRunVerdict({ ...good, violations: 1 }).pass).toBe(false);
  });
});

describe('the cache estimate', () => {
  const step = (tools: string[], messageBytes: number[], newConversation = false): CacheStep => ({
    tools, toolSizes: tools.map(() => 100), systemBytes: 1000, messageBytes, newConversation,
  });

  test('an unchanged tool list pays only for the new messages', () => {
    expect(uncachedBytes([
      step(['a', 'b'], [10], true),
      step(['a', 'b'], [10, 20, 30]),
    ])).toEqual([200 + 1000 + 10, 50]);
  });

  test('a changed tool list is a full miss, including the history behind it', () => {
    expect(uncachedBytes([
      step(['a', 'b'], [10], true),
      step(['a', 'b', 'c'], [10, 20, 30]),
    ])).toEqual([1210, 300 + 1000 + 60]);
  });

  test('the tool-prefix bound reuses only the leading tools the lists share', () => {
    expect(uncachedBytes([
      step(['a', 'b'], [10], true),
      step(['a', 'c', 'b'], [10, 20, 30]),
    ], 'tools-first-exact')).toEqual([1210, 300 + 1000 + 60 - 100]);
  });

  test('system-first keeps the system prompt across a tool change', () => {
    expect(uncachedBytes([
      step(['a', 'b'], [10], true),
      step(['a', 'b', 'c'], [10, 20, 30]),
    ], 'system-first')).toEqual([1210, 300 + 60]);
  });

  test('tools-last pays for the tools on every request, changed or not', () => {
    // Tools ride in the last user message, so they are never in the cached
    // prefix; the previous last user message is re-prefilled without them.
    expect(uncachedBytes([
      step(['a', 'b'], [10], true),
      step(['a', 'b'], [10, 20, 30]),
    ], 'tools-last')).toEqual([1210, 200 + 10 + 20 + 30]);
  });

  test('a changed system prompt is a full miss under every model', () => {
    for (const m of ['tools-first', 'tools-first-exact', 'system-first', 'tools-last'] as const) {
      const other = { ...step(['a'], [10]), systemBytes: 999 };
      expect(uncachedBytes([step(['a'], [10], true), other], m)[1]).toBe(100 + 999 + 10);
    }
  });

  test('a new conversation on the same tools reuses tools and system prompt', () => {
    expect(uncachedBytes([
      step(['a'], [10], true),
      step(['a'], [40], true),
    ])).toEqual([1110, 40]);
  });
});
