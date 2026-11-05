/**
 * Every engine suite runs in the required `test` job (#1235, #1256).
 *
 * An engine suite skips unless JARVIS_TEST_ENGINE_BUILD=1 is set or an engine
 * bundle (and the pieces it needs) happens to be built already, so a file that
 * no required job runs with that gate passes everywhere while testing nothing.
 *
 * Two ways that went wrong. The provider qualifications in pieces-library ran
 * in a second step that listed each file by hand (#1235: Trello and GitHub were
 * once left to workflows branch protection does not require). And the
 * engine-runtime and runtime suites ran in the full run only because an
 * ungated *-engine test sorted earlier and built the bundle and pieces first,
 * so a rename or a reorder would have made them skip without a word (#1256).
 *
 * So the full `bun test` run of the required job sets the gate itself, and
 * every suite whose skip depends on built engine artifacts honours it.
 *
 * What this cannot see: a suite is found by its text (a skip, plus the gate,
 * findCachedBundle or the staging esbuild), so one that skips through a shared
 * helper, or only on built pieces, or that returns early instead of skipping,
 * is not found; and "honours" means the gate is read outside a comment, not
 * that it reaches the skip. Two engine qualifications sit behind a gate of
 * their own on purpose and are not found either: the Q13 ones in
 * src/brief/opportunity-activation.test.ts and
 * src/awareness/prepared-opportunities.test.ts (JARVIS_TEST_PREPARED_Q13).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DIR = 'src/workflows/pieces-library';
const GATE = 'JARVIS_TEST_ENGINE_BUILD';
const engineTests = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('-engine.test.ts')).sort();

type Step = { run?: string; if?: unknown; env?: Record<string, unknown>; 'continue-on-error'?: unknown };
type Job = { if?: unknown; needs?: unknown; 'continue-on-error'?: unknown; env?: Record<string, unknown>; steps?: Step[] };

function testJob(): Job {
  const yml = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, Job> };
  return yml.jobs.test!;
}

/** Steps of the required job that run `bun test`, in any form. */
function bunTestSteps(): Step[] {
  return (testJob().steps ?? []).filter((s) => typeof s.run === 'string' && /\bbun test\b/.test(s.run));
}

/** Every test file under src/, relative to the repository root. */
function allTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts')) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'src'));
  return out.sort();
}

/**
 * The source without the comments that start a line, block or line: enough
 * that a gate named only in a header or a comment line does not count. Only
 * at the start of a line, so a glob like 'src/**' in code is never read as
 * the start of a comment.
 */
const code = (src: string): string => src.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
const readsGate = (src: string): boolean => new RegExp(`process\\.env(?:\\.${GATE}\\b|\\[\\s*['"]${GATE}['"]\\s*\\])`).test(code(src));

/**
 * A suite whose skip can depend on built engine artifacts: it has a skip, and
 * it reads the gate, looks for a cached bundle, or looks for the staging
 * install. Over-inclusive on purpose; the exemptions below say why each extra
 * one is fine.
 */
function engineGated(src: string): boolean {
  if (!/\.(?:skipIf|skip|if)\s*\(/.test(src)) return false;
  return readsGate(src) || /\bfindCachedBundle\s*\(/.test(src) || /\bstagingEsbuild\b/.test(src);
}

/** Detected as engine-gated, but correctly not opted in by the gate alone. */
const EXEMPT: Record<string, string> = {
  // Its skips are platform checks; it calls findCachedBundle in a test body.
  'src/workflows/runner/engine-runtime/bundle-integrity.test.ts': 'skips only by platform',
  // Reads the gate, but also needs JARVIS_TEST_ENGINE_EXTRACT_PIECE=1: it bun
  // installs the 165 MB gmail piece, so it stays a deliberate opt-in.
  'src/workflows/pieces-library/engine-extract.test.ts': 'second opt-in gate (gmail install)',
};

describe('engine suites in the required job (#1235, #1256)', () => {
  test('the full bun test run sets the engine gate, always runs, and can fail the job', () => {
    // `test` is the one required check. A condition or continue-on-error on
    // the job or the step would let it go green without the engine suites.
    const job = testJob();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    const steps = bunTestSteps();
    expect(steps.length).toBe(1);
    const step = steps[0]!;
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    // String "1", as the suites compare it; a YAML number would still arrive
    // as "1", but the step should say what it means.
    expect(step.env?.[GATE]).toBe('1');
    // The whole suite: `--retry=N` and nothing else, so no path filter, no
    // name filter (--test-name-pattern, -t, --only) and no inline override of
    // the gate in the command itself.
    const words = step.run!.trim().split(/\s+/);
    expect(words.slice(0, 2)).toEqual(['bun', 'test']);
    expect(words.slice(2).filter((w) => !/^--retry=\d+$/.test(w))).toEqual([]);
    expect(step.run).not.toContain(GATE);
    // On the step, not the job: the job's other steps (the .test.sh guards,
    // tsc) have no use for it, and one place to look keeps this check simple.
    expect(job.env?.[GATE]).toBeUndefined();
  });

  test('there are engine suites to check', () => {
    // Guards against a rename or move making the checks below vacuous. 16 is
    // the provider count as of #1235 and 20 the others as of #1256; lower them
    // only when a suite is deliberately removed.
    expect(engineTests).toContain('trello-engine.test.ts');
    expect(engineTests).toContain('github-engine.test.ts');
    expect(engineTests.length).toBeGreaterThanOrEqual(16);
    const others = allTestFiles().filter((f) => !f.startsWith(`${DIR}/`) && engineGated(readFileSync(join(ROOT, f), 'utf8')));
    expect(others).toContain('src/workflows/runner/engine-runtime/engine-tls-guard.test.ts');
    expect(others).toContain('src/workflows/runtime/delegated-approval.test.ts');
    expect(others.length).toBeGreaterThanOrEqual(20);
  });

  test('every suite whose skip depends on built engine artifacts honours the gate', () => {
    const gated = allTestFiles().filter((f) => engineGated(readFileSync(join(ROOT, f), 'utf8')));
    const ignoring = gated.filter((f) => !(f in EXEMPT) && !readsGate(readFileSync(join(ROOT, f), 'utf8')));
    expect(ignoring).toEqual([]);
    // An exemption for a file that is gone or no longer matches is stale.
    expect(Object.keys(EXEMPT).filter((f) => !gated.includes(f))).toEqual([]);
  });

  test('each provider qualification runs when JARVIS_TEST_ENGINE_BUILD=1', () => {
    // The whole gate, so an extra `&& ...` cannot make it unreachable; an
    // older provider-specific variable may stay as an alternative.
    const gate = /^const gate\s*=\s*(?:process\.env\.JARVIS_TEST_\w+\s*===\s*['"]1['"]\s*\|\|\s*)?process\.env\.JARVIS_TEST_ENGINE_BUILD\s*===\s*['"]1['"]\s*;?\s*$/m;
    const wrong = engineTests.filter((f) => {
      const src = readFileSync(join(ROOT, DIR, f), 'utf8');
      const skips = src.match(/\.(?:skipIf|skip|todo|if)\s*\(/g) ?? [];
      const gated = src.match(/\btest\.skipIf\(\s*!gate\s*\)/g) ?? [];
      return !gate.test(src) || gated.length === 0 || skips.length !== gated.length;
    });
    expect(wrong).toEqual([]);
  });
});
