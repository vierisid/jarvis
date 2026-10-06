import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprint, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import type { BaselineRun } from './baseline';
import { excessEffects, measure } from './measures';
import { compareGroups, loadPromotionRule, promotionReport, validatePromotionRule, type PromotionRule } from './promotion';
import { loadRubric, validateRubric } from './rubric';
import { loadTasks } from './runner';
import type { EvaluationRow, QualityTask } from './types';

const root = resolve(import.meta.dir, '../../..');
const taskset = loadTasks('heldout');
const tasks = taskset.tasks;
const task = tasks.find(t => !t.expectation.blocked && t.scenarios.some(s => s.notifications.length))!;
const negative = tasks.find(t => t.expectation.blocked)!;
const allowance = task.expectation.maxAiSteps;
const receiptsFor = (t: QualityTask) => t.scenarios[0]!.notifications.map(n => ({
  kind: 'notification' as const, input: { message: n.message, channels: n.channels }, runId: 'r', stepName: 'notify' }));

function row(t: QualityTask, policy: PlanningPolicy, over: Partial<EvaluationRow> = {}): EvaluationRow {
  return {
    schemaVersion: 1, id: randomUUID(), taskId: t.id, split: 'heldout', repeat: 1, kind: 'hosted', policy, condition: 'natural',
    specification: { ...t.specification, description: 'SPEC-SENTINEL' },
    provenance: { schemaVersion: 1, promptVersion: 'w8-2', planningPolicy: policy, catalogSha256: 'c', environmentSha256: 'e' },
    calls: [], transport: [], candidates: [{ previousResponse: 'r', previousGraph: {}, errors: [] }],
    result: t.expectation.blocked ? { ok: false, blocked: true, errors: ['Not installed'], rawResponse: null }
      : { ok: true, flow: { displayName: 'GRAPH-SENTINEL', trigger: { type: 'EMPTY' } } as any, rawResponse: 'r' },
    compositionMs: 1000, staticChecks: [{ name: 'checks', pass: true }], aiSteps: t.expectation.blocked ? null : allowance,
    scenarios: t.expectation.blocked ? [] : t.scenarios.map(s => ({ id: s.id, runId: 'r', status: 'SUCCEEDED',
      receipts: s === t.scenarios[0] ? receiptsFor(t) : s.notifications.map(n => ({ kind: 'notification' as const,
        input: { message: n.message, channels: n.channels }, runId: 'r', stepName: 'notify' })), checks: [{ name: 'effects', pass: true }], elapsedMs: 5 })),
    intentChecksPassed: true, humanIntentCorrect: true,
    supervision: t.expectation.blocked ? null : { reviewer: 'R', elapsedMs: 60_000, edits: 1, notes: 'NOTE-SENTINEL' },
    estimatedCostUsd: null, costComplete: false, profile: { id: 'starter', revisionSha256: 'rev' }, interruptions: [], promptSha256s: ['p'], ...over,
  };
}
/** The baseline before the candidate improves on it: an AI step over the allowance, a repair, and more review. */
const baselineRows = () => [row(task, 'baseline-v1', { aiSteps: allowance + 1,
  candidates: [{ previousResponse: 'bad', previousGraph: null, errors: ['invalid'] }, { previousResponse: 'r', previousGraph: {}, errors: [] }],
  supervision: { reviewer: 'R', elapsedMs: 120_000, edits: 2, notes: 'NOTE-SENTINEL' } }), row(negative, 'baseline-v1')];
const candidateRows = (over: Partial<EvaluationRow> = {}) => [row(task, 'deterministic-first-v1', over), row(negative, 'deterministic-first-v1')];

const proposedRubric = loadRubric().rubric;
const releaseRubric = validateRubric({ ...proposedRubric, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] },
  sample: { ...proposedRubric.sample, minSupportedTasks: 1, minNegativeTasks: 1 },
  budgets: { '*': { maxRequestsPerTask: 5, maxTokensPerTask: 10_000, maxP95CompositionMs: 60_000 } } });
const proposedRule = loadPromotionRule().rule;
const rule: PromotionRule = validatePromotionRule({ ...proposedRule, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] } });

function run(rows: EvaluationRow[], manifest: Record<string, unknown> = {}, rubric = releaseRubric): BaselineRun {
  return { source: '/home/someone/run', taskset, rows, report: { status: 'completed', finishedAt: '2026-10-09T10:00:00Z', failure: null },
    manifest: { mode: 'hosted', startedAt: '2026-10-09T09:00:00Z', taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout' },
      rubric: { id: rubric.id, sha256: fingerprint(rubric), status: rubric.status, value: rubric },
      profile: { id: 'starter', baseUrl: 'https://URL-SENTINEL.invalid' }, profileEvidence: { revisionSha256: 'rev' }, authorization: { approvedBy: 'Owner' },
      scheduled: rows.map(r => ({ taskId: r.taskId, policy: r.policy, repeat: r.repeat, condition: r.condition })), ...manifest } };
}
const verdictOf = (rows: EvaluationRow[], r: PromotionRule = rule) => {
  const report = promotionReport([run(rows)], r) as any;
  expect(report.status).toBe('completed');
  return { verdict: report.verdict, checks: report.profiles.starter.checks, reasons: report.profiles.starter.reasons };
};

describe('unnecessary AI is measured apart from unsafe effects', () => {
  test('excess AI calls and delegations are AI; extra notifications reach people', () => {
    const scenario = task.scenarios[0]!, expected = receiptsFor(task);
    expect(excessEffects(scenario, [...expected, { kind: 'ai', input: {}, runId: 'r', stepName: 'ask' }, { kind: 'agent', input: {}, runId: 'r', stepName: 'agent' }]))
      .toEqual({ external: 0, ai: (scenario.ai ? 0 : 1) + (scenario.agents ? 0 : 1) });
    expect(excessEffects(scenario, [...expected, ...expected])).toEqual({ external: expected.length, ai: 0 });
  });

  test('a graph is charged for AI steps over its task\'s allowance', () => {
    const m = measure(baselineRows(), tasks, []);
    expect(m.ai).toMatchObject({ graphs: 1, excessSteps: 1, overAllowance: { successes: 1, n: 1 } });
    expect(m.effects).toMatchObject({ unsafe: 0, unrequestedAi: 0 });
    // An AI call no scenario asked for is unexpected, but it is AI, not an effect on people or systems.
    const asked = row(task, 'baseline-v1');
    asked.scenarios[0]!.receipts.push({ kind: 'agent', input: {}, runId: 'r', stepName: 'agent' });
    expect(measure([asked], tasks, []).effects).toMatchObject({ unexpected: 1, unsafe: 0, unrequestedAi: 1 });
  });
});

describe('promotion comparison', () => {
  test('less unnecessary AI, fewer corrections, no new unsafe effect and no success drop: promote', () => {
    const result = verdictOf([...baselineRows(), ...candidateRows()]);
    expect(result.checks).toEqual({ sample: 'met', unnecessaryAi: 'met', corrections: 'met', safety: 'met', success: 'met' });
    expect(result.verdict).toBe('promote');
    expect(result.reasons[0]).toBe('Unnecessary AI (steps over each task\'s allowance plus unrequested AI calls): 1 with baseline-v1, 0 with deterministic-first-v1.');
  });

  test('a new unsafe effect, a success drop beyond the allowance, or no less AI keeps the baseline', () => {
    const extra = [...receiptsFor(task), ...receiptsFor(task)];
    const unsafe = candidateRows({ scenarios: row(task, 'deterministic-first-v1').scenarios.map((s, i) => i ? s : { ...s, receipts: extra }) });
    expect(verdictOf([...baselineRows(), ...unsafe])).toMatchObject({ verdict: 'keep_baseline', checks: { safety: 'not_met' } });
    const failing = candidateRows({ intentChecksPassed: false, staticChecks: [{ name: 'checks', pass: false }] });
    expect(verdictOf([...baselineRows(), ...failing])).toMatchObject({ verdict: 'keep_baseline', checks: { success: 'not_met' } });
    const sameAi = candidateRows({ aiSteps: allowance + 1 });
    expect(verdictOf([...baselineRows(), ...sameAi])).toMatchObject({ verdict: 'keep_baseline', checks: { unnecessaryAi: 'not_met' } });
  });

  test('corrections must improve under the shipped rule; not_worse accepts a tie', () => {
    const tied = [row(task, 'baseline-v1', { aiSteps: allowance + 1 }), row(negative, 'baseline-v1'), ...candidateRows()];
    expect(verdictOf(tied)).toMatchObject({ verdict: 'keep_baseline', checks: { corrections: 'not_met' } });
    expect(verdictOf(tied, { ...rule, corrections: 'not_worse' })).toMatchObject({ verdict: 'promote', checks: { corrections: 'met' } });
    // Fewer edits do not buy a slower correction: none may get worse.
    const worse = candidateRows({ supervision: { reviewer: 'R', elapsedMs: 300_000, edits: 0, notes: '' } });
    expect(verdictOf([...baselineRows(), ...worse])).toMatchObject({ verdict: 'keep_baseline', checks: { corrections: 'not_met' } });
  });

  test('pending reviews and small samples are named, never promoted', () => {
    const pending = candidateRows({ humanIntentCorrect: null, supervision: null });
    expect(verdictOf([...baselineRows(), ...pending])).toMatchObject({ verdict: 'not_established',
      checks: { corrections: 'incomplete_review', success: 'incomplete_review' } });
    const strict = validateRubric({ ...releaseRubric, sample: { ...releaseRubric.sample, minSupportedTasks: 40, minNegativeTasks: 20 } });
    const small = promotionReport([run([...baselineRows(), ...candidateRows()], {}, strict)], rule) as any;
    expect(small).toMatchObject({ verdict: 'not_established', profiles: { starter: { checks: { sample: 'insufficient_sample' } } } });
  });

  test('an incomplete run cannot promote, whatever its profiles say', () => {
    const stopped = { ...run([...baselineRows(), ...candidateRows()]), report: { status: 'stopped', finishedAt: null, failure: 'budget' } };
    expect(promotionReport([stopped], rule)).toMatchObject({ status: 'incomplete', verdict: 'not_established',
      profiles: { starter: { verdict: 'promote' } } });
  });

  test('a rule that is not frozen before the runs, one policy, or unmatched tasks is refused; an unstarted run is not_run', () => {
    const rows = [...baselineRows(), ...candidateRows()];
    const problems = (report: any) => { expect(report.status).toBe('refused'); return report.problems.join(' '); };
    expect(problems(promotionReport([run(rows)], proposedRule))).toContain('is proposed, not frozen');
    expect(problems(promotionReport([run(rows)], { ...rule, frozen: { at: '2026-10-10', approvedBy: ['Vieri'] } }))).toContain('before promotion rule');
    expect(problems(promotionReport([run(baselineRows())], rule))).toContain('did not run both policies on the same natural-condition tasks');
    expect(problems(promotionReport([run([...baselineRows(), row(task, 'deterministic-first-v1')])], rule))).toContain('compare only matched inputs');
    expect(problems(promotionReport([run(rows, { mode: 'smoke' })], rule))).toContain('only hosted runs');
    expect(promotionReport([{ ...run([]), report: { status: 'not_run', reasons: ['Spend authorization is missing (--authorization).'] } }], rule))
      .toMatchObject({ status: 'not_run', notRun: [{ profileId: 'starter', reasons: ['Spend authorization is missing (--authorization).'] }] });
  });

  test('the report is sanitized: aggregates and identities only', () => {
    const report = promotionReport([run([...baselineRows(), ...candidateRows()])], rule);
    const text = JSON.stringify(report);
    for (const sentinel of ['SPEC-SENTINEL', 'NOTE-SENTINEL', 'GRAPH-SENTINEL', 'URL-SENTINEL', '/home/someone']) expect(text).not.toContain(sentinel);
    expect(report).toMatchObject({ rule: { id: 'planning-promotion-v1', sha256: fingerprint(rule) }, rubric: { sha256: fingerprint(releaseRubric) } });
  });

  test('the shipped rule is proposed until frozen with its approvers, and names two known policies', () => {
    expect(proposedRule).toMatchObject({ status: 'proposed', frozen: null, baseline: 'baseline-v1', candidate: 'deterministic-first-v1',
      measure: 'human-reviewed', corrections: 'improve', maxSuccessRegression: 0.05 });
    expect(() => validatePromotionRule({ ...proposedRule, status: 'frozen' })).toThrow('date and approvers');
    expect(() => validatePromotionRule({ ...proposedRule, candidate: 'baseline-v1' })).toThrow('two different known policies');
    expect(() => validatePromotionRule({ ...proposedRule, maxSuccessRegression: 2 })).toThrow('maxSuccessRegression');
  });
});

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, join(root, 'scripts/evaluate-workflow-quality.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI: compare refuses until the rule is frozen, and reports an unstarted hosted run as not_run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-promotion-'));
  try {
    const unstarted = join(directory, 'run');
    mkdirSync(unstarted);
    const { manifest } = run([...baselineRows(), ...candidateRows()]);
    writeFileSync(join(unstarted, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(unstarted, 'report.json'), JSON.stringify({ status: 'not_run', reasons: ['Spend authorization is missing (--authorization).'] }));
    writeFileSync(join(unstarted, 'taskset.json'), JSON.stringify(taskset));
    const proposed = await cli(['--mode', 'compare', '--runs', unstarted, '--out', join(directory, 'proposed')]);
    expect(proposed.code).toBe(1);
    expect(JSON.parse(readFileSync(join(directory, 'proposed/promotion-report.json'), 'utf8')).problems[0]).toContain('is proposed, not frozen');
    writeFileSync(join(directory, 'rule.json'), JSON.stringify(rule));
    const frozen = await cli(['--mode', 'compare', '--runs', unstarted, '--rule', join(directory, 'rule.json'), '--out', join(directory, 'frozen')]);
    expect(frozen.code).toBe(2);
    expect(JSON.parse(readFileSync(join(directory, 'frozen/promotion-report.json'), 'utf8')).status).toBe('not_run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
