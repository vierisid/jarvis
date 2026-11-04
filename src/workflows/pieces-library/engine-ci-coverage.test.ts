/**
 * Every provider engine qualification runs in the required `test` job (#1235).
 *
 * Each pieces-library/*-engine.test.ts skips unless its gate is set, so a file
 * that no required job runs with that gate passes everywhere while testing
 * nothing. Trello and GitHub used to run only in their own qualification
 * workflows, which branch protection does not require, so a break could merge.
 * The gate is JARVIS_TEST_ENGINE_BUILD=1 for all of them, and test.yml's
 * engine step lists each file.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DIR = 'src/workflows/pieces-library';
const STEP = 'JARVIS_TEST_ENGINE_BUILD=1 bun test';
const engineTests = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('-engine.test.ts')).sort();

type Step = { run?: string; if?: unknown; 'continue-on-error'?: unknown };
type Job = { if?: unknown; needs?: unknown; 'continue-on-error'?: unknown; steps?: Step[] };

function testJob(): Job {
  const yml = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')) as { jobs: Record<string, Job> };
  return yml.jobs.test!;
}

function engineSteps(): Step[] {
  return (testJob().steps ?? []).filter((s) => typeof s.run === 'string' && s.run.trimStart().startsWith(STEP));
}

/** The test files the engine step runs. */
function engineStepFiles(): string[] {
  return engineSteps().flatMap((s) => s.run!.split(/\s+/).filter((w) => w.endsWith('.test.ts')));
}

describe('provider engine qualifications in the required job (#1235)', () => {
  test('there are engine qualifications to check', () => {
    // Guards against a rename or move making the checks below vacuous. 16 is
    // the count as of #1235; lower it only when one is deliberately removed.
    expect(engineTests).toContain('trello-engine.test.ts');
    expect(engineTests).toContain('github-engine.test.ts');
    expect(engineTests.length).toBeGreaterThanOrEqual(16);
  });

  test('the engine step always runs in the required job and can fail it', () => {
    // `test` is the one required check. A condition or continue-on-error on
    // the job or the step would let it go green without these files.
    const job = testJob();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    const steps = engineSteps();
    expect(steps.length).toBe(1);
    expect(steps[0]!.if).toBeUndefined();
    expect(steps[0]!['continue-on-error']).toBeUndefined();
  });

  test("each is listed in test.yml's engine step, and every listed file exists", () => {
    const listed = engineStepFiles();
    expect(listed.length).toBeGreaterThan(0);
    expect(engineTests.filter((f) => !listed.includes(`${DIR}/${f}`))).toEqual([]);
    // bun test treats a path as a filter: a renamed file would just match nothing.
    expect(listed.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  test('each runs when JARVIS_TEST_ENGINE_BUILD=1, the gate that step sets', () => {
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
