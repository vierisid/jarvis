import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMPOSER_PROMPT_VERSION, fingerprint, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import type { BaselineRun } from './baseline';
import { composerEnvironment, environmentFor, extendsEnvironment, productionShaped } from './environment';
import { excessEffects, measure, type Measures } from './measures';
import {
  compareGroups, graphUnnecessaryAi, loadPromotionRule, matchedUnnecessaryAi, promotionReport, validatePromotionRule, type PromotionRule,
} from './promotion';
import { loadRubric, validateRubric } from './rubric';
import { loadTasks } from './runner';
import type { EvaluationRow, QualityTask } from './types';

const root = resolve(import.meta.dir, '../../..');
const taskset = loadTasks('heldout');
const tasks = taskset.tasks;
const supported = tasks.filter(t => !t.expectation.blocked);
const task = supported.find(t => t.scenarios.filter(s => s.notifications.length).length >= 2)
  ?? supported.find(t => t.scenarios.some(s => s.notifications.length))!;
const second = supported.find(t => t !== task)!;
const negative = tasks.find(t => t.expectation.blocked)!;
const allowance = task.expectation.maxAiSteps;
const receiptsFor = (s: QualityTask['scenarios'][number]) => s.notifications.map(n => ({
  kind: 'notification' as const, input: { message: n.message, channels: n.channels }, runId: 'r', stepName: 'notify' }));
const ai = (stepName = 'ask') => ({ kind: 'ai' as const, input: {}, runId: 'r', stepName });

function row(t: QualityTask, policy: PlanningPolicy, over: Partial<EvaluationRow> = {}): EvaluationRow {
  return {
    schemaVersion: 1, id: randomUUID(), taskId: t.id, split: 'heldout', repeat: 1, kind: 'hosted', policy, condition: 'natural',
    specification: { ...t.specification, description: 'SPEC-SENTINEL' },
    provenance: { schemaVersion: 1, promptVersion: COMPOSER_PROMPT_VERSION, planningPolicy: policy, catalogSha256: 'c', environmentSha256: 'e' },
    calls: [], transport: [], candidates: [{ previousResponse: 'r', previousGraph: {}, errors: [] }],
    result: t.expectation.blocked ? { ok: false, blocked: true, errors: ['Not installed'], rawResponse: null }
      : { ok: true, flow: { displayName: 'GRAPH-SENTINEL', trigger: { type: 'EMPTY' } } as any, rawResponse: 'r' },
    compositionMs: 1000, staticChecks: [{ name: 'checks', pass: true }], aiSteps: t.expectation.blocked ? null : t.expectation.maxAiSteps,
    scenarios: t.expectation.blocked ? [] : t.scenarios.map(s => ({ id: s.id, runId: 'r', status: 'SUCCEEDED',
      receipts: [...receiptsFor(s), ...(s.ai ? [ai()] : [])], checks: [{ name: 'effects', pass: true }], elapsedMs: 5 })),
    intentChecksPassed: true, humanIntentCorrect: true,
    supervision: t.expectation.blocked ? null : { reviewer: 'R', elapsedMs: 60_000, edits: 1, notes: 'NOTE-SENTINEL' },
    estimatedCostUsd: null, costComplete: false, profile: { id: 'starter', revisionSha256: 'rev' }, interruptions: [], promptSha256s: ['p'], ...over,
  };
}
/** A graph with one AI step over its allowance, which every scenario then calls. */
const extraStep = (t: QualityTask, policy: PlanningPolicy, over: Partial<EvaluationRow> = {}) => {
  const r = row(t, policy, { aiSteps: t.expectation.maxAiSteps + 1, ...over });
  for (const s of r.scenarios) s.receipts.push(ai('extra'));
  return r;
};
/** The baseline before the candidate improves on it: an AI step over the allowance, a repair, and more review. */
const baselineRows = () => [extraStep(task, 'baseline-v1', {
  candidates: [{ previousResponse: 'bad', previousGraph: null, errors: ['invalid'] }, { previousResponse: 'r', previousGraph: {}, errors: [] }],
  supervision: { reviewer: 'R', elapsedMs: 120_000, edits: 2, notes: 'NOTE-SENTINEL' } }), row(negative, 'baseline-v1')];
const candidateRows = (over: Partial<EvaluationRow> = {}) => [row(task, 'deterministic-first-v1', over), row(negative, 'deterministic-first-v1')];

const proposedRubric = loadRubric().rubric;
const releaseRubric = validateRubric({ ...proposedRubric, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] },
  sample: { ...proposedRubric.sample, minSupportedTasks: 1, minNegativeTasks: 1 },
  budgets: { '*': { maxRequestsPerTask: 5, maxTokensPerTask: 10_000, maxP95CompositionMs: 60_000 } } });
const proposedRule = loadPromotionRule().rule;
const rule: PromotionRule = validatePromotionRule({ ...proposedRule, status: 'frozen', frozen: { at: '2026-10-08', approvedBy: ['Vieri', 'Lapo'] } });
const pin = (r: PromotionRule) => ({ id: r.id, sha256: fingerprint(r), status: r.status, value: r });

/** One hosted run of both policies in a production-shaped environment that pinned `pinned` when it started. */
function run(rows: EvaluationRow[], { manifest = {}, rubric = releaseRubric, pinned = rule, profile = 'starter' }:
  { manifest?: Record<string, unknown>; rubric?: typeof releaseRubric; pinned?: PromotionRule; profile?: string } = {}): BaselineRun {
  return { source: '/home/someone/run', taskset, rows, report: { status: 'completed', finishedAt: '2026-10-09T10:00:00Z', failure: null },
    manifest: { mode: 'hosted', startedAt: '2026-10-09T09:00:00Z', head: 'abc123', sourceSha256: 'src',
      taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout', environment: 'w8' }, environment: 'founder-v2',
      rubric: { id: rubric.id, sha256: fingerprint(rubric), status: rubric.status, value: rubric }, promotionRule: pin(pinned),
      profile: { id: profile, baseUrl: 'https://URL-SENTINEL.invalid' }, profileEvidence: { revisionSha256: 'rev' }, authorization: { approvedBy: 'Owner' },
      scheduled: rows.map(r => ({ taskId: r.taskId, policy: r.policy, repeat: r.repeat, condition: r.condition })), ...manifest } };
}
const verdictOf = (rows: EvaluationRow[], r: PromotionRule = rule) => {
  const report = promotionReport([run(rows, { pinned: r })], r) as any;
  expect(report.status).toBe('completed');
  return { verdict: report.verdict, checks: report.profiles.starter.checks, reasons: report.profiles.starter.reasons };
};
const problems = (report: any) => { expect(report.status).toBe('refused'); return report.problems.join(' '); };

describe('unnecessary AI is measured apart from unsafe effects', () => {
  test('excess AI calls and delegations are AI; extra notifications reach people', () => {
    const scenario = task.scenarios[0]!, expected = [...receiptsFor(scenario), ...(scenario.ai ? [ai()] : [])];
    expect(excessEffects(scenario, [...expected, ai(), { kind: 'agent', input: {}, runId: 'r', stepName: 'agent' }]))
      .toEqual({ external: 0, ai: 1 + (scenario.agents ? 0 : 1) });
    expect(excessEffects(scenario, [...expected, ...receiptsFor(scenario)])).toEqual({ external: receiptsFor(scenario).length, ai: 0 });
  });

  test('a graph is charged for AI steps over its task\'s allowance; unrequested AI is not an unsafe effect', () => {
    const m = measure(baselineRows(), tasks, []);
    expect(m.ai).toMatchObject({ graphs: 1, excessSteps: 1, overAllowance: { successes: 1, n: 1 } });
    expect(m.effects).toMatchObject({ unsafe: 0, unrequestedAi: task.scenarios.length });
  });

  test('one extra AI step counts once, however many scenarios run it; extra calls beyond the steps count too', () => {
    expect(graphUnnecessaryAi(extraStep(task, 'baseline-v1'), task)).toBe(1);
    const looped = row(task, 'baseline-v1');
    looped.scenarios[0]!.receipts.push(ai('loop'), ai('loop'));
    expect(graphUnnecessaryAi(looped, task)).toBe(2);
  });

  test('only graphs both policies composed are compared, so abstaining cannot lower the count', () => {
    const abstained = row(task, 'deterministic-first-v1', { aiSteps: null, scenarios: [], intentChecksPassed: false,
      result: { ok: false, blocked: true, errors: ['Not supported'], rawResponse: null } });
    expect(matchedUnnecessaryAi([extraStep(task, 'baseline-v1')], [abstained], tasks)).toEqual({ graphs: 0, baseline: 0, candidate: 0 });
  });
});

describe('promotion comparison', () => {
  test('less unnecessary AI, as many jobs composed, fewer corrections, no new unsafe effect and no success drop: promote', () => {
    const result = verdictOf([...baselineRows(), ...candidateRows()]);
    expect(result.checks).toEqual({ complete: 'met', sample: 'met', unnecessaryAi: 'met', composed: 'met', corrections: 'met', safety: 'met', success: 'met' });
    expect(result.verdict).toBe('promote');
    expect(result.reasons).toContain('Unnecessary AI on the 1 graphs both policies composed: 1 with baseline-v1, 0 with deterministic-first-v1.');
  });

  test('a candidate that avoids AI by abstaining is not credited, and its false abstention keeps the baseline', () => {
    // The baseline's extra AI step fails the task anyway; the candidate reports a blocker on the same supported task.
    const failing = extraStep(task, 'baseline-v1', { intentChecksPassed: false, staticChecks: [{ name: 'AI steps within task allowance', pass: false }] });
    const abstained = row(task, 'deterministic-first-v1', { aiSteps: null, scenarios: [], intentChecksPassed: false, supervision: null, humanIntentCorrect: null,
      result: { ok: false, blocked: true, errors: ['Not supported'], rawResponse: null } });
    const result = verdictOf([failing, row(negative, 'baseline-v1'), abstained, row(negative, 'deterministic-first-v1')]);
    expect(result.checks).toMatchObject({ unnecessaryAi: 'not_measured', composed: 'not_met' });
    expect(result.verdict).toBe('keep_baseline');
  });

  test('a new unsafe effect, a missed abstention, a success drop beyond the allowance, or no less AI keeps the baseline', () => {
    const unsafe = candidateRows();
    unsafe[0]!.scenarios[0]!.receipts.push(...receiptsFor(task.scenarios[0]!));
    expect(verdictOf([...baselineRows(), ...unsafe])).toMatchObject({ verdict: 'keep_baseline', checks: { safety: 'not_met' } });
    const missed = [row(task, 'deterministic-first-v1'), row(negative, 'deterministic-first-v1', { intentChecksPassed: false,
      result: { ok: true, flow: { displayName: 'x', trigger: { type: 'EMPTY' } } as any, rawResponse: 'r' } })];
    expect(verdictOf([...baselineRows(), ...missed])).toMatchObject({ verdict: 'keep_baseline', checks: { safety: 'not_met' } });
    const failing = candidateRows({ intentChecksPassed: false, staticChecks: [{ name: 'checks', pass: false }] });
    expect(verdictOf([...baselineRows(), ...failing])).toMatchObject({ verdict: 'keep_baseline', checks: { success: 'not_met' } });
    expect(verdictOf([...baselineRows(), extraStep(task, 'deterministic-first-v1'), row(negative, 'deterministic-first-v1')]))
      .toMatchObject({ verdict: 'keep_baseline', checks: { unnecessaryAi: 'not_met' } });
  });

  test('the success allowance holds at its boundary, exactly, with float rates', () => {
    const base = [extraStep(task, 'baseline-v1'), row(second, 'baseline-v1'), row(negative, 'baseline-v1')];
    const half = [row(task, 'deterministic-first-v1'), row(second, 'deterministic-first-v1', { intentChecksPassed: false, staticChecks: [{ name: 'checks', pass: false }] }),
      row(negative, 'deterministic-first-v1')];
    expect(verdictOf([...base, ...half], validatePromotionRule({ ...rule, maxSuccessRegression: 0.5 })).checks.success).toBe('met');
    expect(verdictOf([...base, ...half], validatePromotionRule({ ...rule, maxSuccessRegression: 0.49 })).checks.success).toBe('not_met');
    // 40 tasks at the rubric minimum: 16 to 14 successes is exactly a 5-point drop, which 0.4 - 0.05 in floats would reject.
    const at = (success: number) => ({ notRun: 0, rows: { human: { unreviewedSupported: 0 }, abstention: { missed: 0, falseOnSupported: 0 } },
      tasks: { human: { firstCandidate: { rate: 0.5 }, afterRepair: { rate: success } }, automatic: { firstCandidate: { rate: 0.5 }, afterRepair: { rate: success } } },
      supervision: { edits: { p50: 1 }, correctionMs: { p50: 60_000 } }, effects: { unsafe: 0 }, ai: { graphs: 40 } }) as unknown as Measures;
    const counts = { graphs: 40, baseline: 1, candidate: 0 };
    expect(compareGroups(at(16 / 40), at(14 / 40), counts, rule, true).checks.success).toBe('met');
    expect(compareGroups(at(16 / 40), at(13 / 40), counts, rule, true).checks.success).toBe('not_met');
  });

  test('corrections must improve: a tie or any measure getting worse keeps the baseline', () => {
    const tied = [extraStep(task, 'baseline-v1'), row(negative, 'baseline-v1'), ...candidateRows()];
    expect(verdictOf(tied)).toMatchObject({ verdict: 'keep_baseline', checks: { corrections: 'not_met' } });
    // Fewer edits do not buy a slower correction: none may get worse.
    const worse = candidateRows({ supervision: { reviewer: 'R', elapsedMs: 300_000, edits: 0, notes: '' } });
    expect(verdictOf([...baselineRows(), ...worse])).toMatchObject({ verdict: 'keep_baseline', checks: { corrections: 'not_met' } });
  });

  test('an automatic rule judges first-candidate correctness and success without waiting for review', () => {
    const automatic = validatePromotionRule({ ...rule, measure: 'automatic' });
    const unreviewed = [...baselineRows(), ...candidateRows()].map(r => ({ ...r, humanIntentCorrect: null, supervision: null }));
    const result = verdictOf(unreviewed, automatic);
    expect(result.checks).toMatchObject({ corrections: 'met', success: 'met' });
    expect(result.reasons.find((r: string) => r.startsWith('Corrections:'))).not.toContain('median');
    expect(verdictOf(unreviewed).checks).toMatchObject({ corrections: 'incomplete_review', success: 'incomplete_review' });
  });

  test('pending reviews and small samples are named, never promoted', () => {
    const pending = candidateRows({ humanIntentCorrect: null, supervision: null });
    expect(verdictOf([...baselineRows(), ...pending])).toMatchObject({ verdict: 'not_established',
      checks: { corrections: 'incomplete_review', success: 'incomplete_review' } });
    const strict = validateRubric({ ...releaseRubric, sample: { ...releaseRubric.sample, minSupportedTasks: 40, minNegativeTasks: 20 } });
    const small = promotionReport([run([...baselineRows(), ...candidateRows()], { rubric: strict })], rule) as any;
    expect(small).toMatchObject({ verdict: 'not_established', profiles: { starter: { checks: { sample: 'insufficient_sample' } } } });
  });

  test('unrun items decide nothing: a cut-off candidate half is not_established, not keep_baseline', () => {
    const rows = [...baselineRows(), ...candidateRows()];
    const cut = run(rows.slice(0, 2), { manifest: { scheduled: rows.map(r => ({ taskId: r.taskId, policy: r.policy, repeat: r.repeat, condition: r.condition })) } });
    const report = promotionReport([{ ...cut, report: { status: 'stopped', finishedAt: null, failure: 'budget' } }], rule) as any;
    expect(report).toMatchObject({ status: 'incomplete', verdict: 'not_established',
      profiles: { starter: { verdict: 'not_established', checks: { complete: 'incomplete' } } } });
  });

  test('an incomplete run cannot promote, whatever its profiles say', () => {
    const stopped = { ...run([...baselineRows(), ...candidateRows()]), report: { status: 'stopped', finishedAt: null, failure: 'budget' } };
    expect(promotionReport([stopped], rule)).toMatchObject({ status: 'incomplete', verdict: 'not_established',
      profiles: { starter: { verdict: 'promote' } } });
  });

  test('several profiles: any keep_baseline keeps it; promotion needs every profile to promote', () => {
    const good = [...baselineRows(), ...candidateRows()];
    const pending = [...baselineRows(), ...candidateRows({ humanIntentCorrect: null, supervision: null })];
    const unsafe = candidateRows();
    unsafe[0]!.scenarios[0]!.receipts.push(...receiptsFor(task.scenarios[0]!));
    const of = (...runs: BaselineRun[]) => (promotionReport(runs, rule) as any).verdict;
    expect(of(run(good), run(good, { profile: 'plus' }))).toBe('promote');
    expect(of(run(good), run(pending, { profile: 'plus' }))).toBe('not_established');
    expect(of(run(good), run([...baselineRows(), ...unsafe], { profile: 'plus' }))).toBe('keep_baseline');
  });

  test('the report says which prompt version and runs it measured; another version cannot promote', () => {
    const report = promotionReport([run([...baselineRows(), ...candidateRows()])], rule) as any;
    expect(report.promptVersion).toEqual({ measured: COMPOSER_PROMPT_VERSION, current: COMPOSER_PROMPT_VERSION });
    expect(report.runs).toEqual([expect.objectContaining({ profileId: 'starter', head: 'abc123', sourceSha256: 'src', environment: 'founder-v2' })]);
    const older = [...baselineRows(), ...candidateRows()].map(r => ({ ...r, provenance: { ...r.provenance, promptVersion: 'w8-1' } }));
    expect(promotionReport([run(older)], rule)).toMatchObject({ verdict: 'not_established', promptVersion: { measured: 'w8-1' },
      profiles: { starter: { verdict: 'promote' } } });
    const mixed = [...baselineRows(), ...candidateRows()];
    mixed[0] = { ...mixed[0]!, provenance: { ...mixed[0]!.provenance, promptVersion: 'w8-1' } };
    expect(problems(promotionReport([run(mixed)], rule))).toContain('more than one composer prompt version');
  });

  test('refused: a rule that is proposed, changed after the run, or frozen late; a run without a pin, a valid start or a production shape; unmatched policies', () => {
    const rows = [...baselineRows(), ...candidateRows()];
    expect(problems(promotionReport([run(rows, { pinned: proposedRule })], proposedRule))).toContain('is proposed, not frozen');
    // The threshold edited after the results, keeping the id and freeze date.
    const edited = validatePromotionRule({ ...rule, maxSuccessRegression: 0.07 });
    expect(problems(promotionReport([run(rows)], edited))).toContain('started under a different promotion rule');
    const late = validatePromotionRule({ ...rule, frozen: { at: '2026-10-10', approvedBy: ['Vieri'] } });
    expect(problems(promotionReport([run(rows, { pinned: late })], late))).toContain('started before promotion rule');
    expect(problems(promotionReport([run(rows, { manifest: { promotionRule: undefined } })], rule))).toContain('did not pin a promotion rule');
    expect(problems(promotionReport([run(rows, { manifest: { startedAt: undefined } })], rule))).toContain('has no valid start time');
    expect(problems(promotionReport([run(rows, { manifest: { environment: 'founder-v1' } })], rule))).toContain('lacks what production shows the composer');
    expect(problems(promotionReport([run(baselineRows())], rule))).toContain('did not run both policies on the same natural-condition tasks');
    expect(problems(promotionReport([run([...baselineRows(), row(task, 'deterministic-first-v1')])], rule))).toContain('compare only matched inputs');
    expect(problems(promotionReport([run(rows, { manifest: { mode: 'smoke' } })], rule))).toContain('only hosted runs');
    expect(promotionReport([{ ...run([]), report: { status: 'not_run', reasons: ['Spend authorization is missing (--authorization).'] } }], rule))
      .toMatchObject({ status: 'not_run', notRun: [{ profileId: 'starter', reasons: ['Spend authorization is missing (--authorization).'] }] });
  });

  test('reports are sanitized: aggregates, identities and run names only', () => {
    const report = promotionReport([run([...baselineRows(), ...candidateRows()])], rule);
    const refused = promotionReport([run(baselineRows())], rule);
    for (const text of [JSON.stringify(report), JSON.stringify(refused)])
      for (const sentinel of ['SPEC-SENTINEL', 'NOTE-SENTINEL', 'GRAPH-SENTINEL', 'URL-SENTINEL', '/home/someone']) expect(text).not.toContain(sentinel);
    expect(report).toMatchObject({ rule: { id: 'planning-promotion-v1', sha256: fingerprint(rule) }, rubric: { sha256: fingerprint(releaseRubric) } });
  });

  test('the shipped rule is proposed until frozen with its approvers, names two known policies, and has no unknown fields', () => {
    expect(proposedRule).toMatchObject({ status: 'proposed', frozen: null, baseline: 'baseline-v1', candidate: 'deterministic-first-v1',
      measure: 'human-reviewed', maxSuccessRegression: 0.05 });
    expect(() => validatePromotionRule({ ...proposedRule, status: 'frozen' })).toThrow('date and approvers');
    expect(() => validatePromotionRule({ ...proposedRule, candidate: 'baseline-v1' })).toThrow('two different known policies');
    expect(() => validatePromotionRule({ ...proposedRule, maxSuccessRegression: 2 })).toThrow('maxSuccessRegression');
    // Corrections must improve, as the card says; there is no option to accept a tie.
    expect(() => validatePromotionRule({ ...proposedRule, corrections: 'not_worse' })).toThrow('unknown field corrections');
  });
});

describe('production-shaped environments', () => {
  test('founder-v2 adds the shipped specialist roles and the pieces library; the hosted shape has roles only', () => {
    const v1 = environmentFor('founder-v1'), v2 = environmentFor('founder-v2'), hosted = environmentFor('founder-v2-hosted');
    expect(v2.specialistRoles!.map(r => r.id)).toContain('research-analyst');
    expect(v2.library!.length).toBeGreaterThan(0);
    expect(hosted.library).toBeUndefined();
    expect([productionShaped(v1), productionShaped(v2), productionShaped(hosted)]).toEqual([false, true, true]);
    expect([extendsEnvironment(v2, v1), extendsEnvironment(hosted, v1), extendsEnvironment(v1, environmentFor('w8')), extendsEnvironment(environmentFor('w8'), v1)])
      .toEqual([true, true, true, false]);
  });

  test('the composer gets roles and library as production passes them', () => {
    const v2 = environmentFor('founder-v2');
    expect(composerEnvironment(v2)).toMatchObject({ tools: v2.tools, executionTargets: v2.targets, specialistRoles: v2.specialistRoles, library: v2.library });
    expect(Object.keys(composerEnvironment(environmentFor('w8')))).toEqual([]);
  });
});

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, join(root, 'scripts/evaluate-workflow-quality.ts'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI: runs pin the promotion rule and interleave the policies; compare refuses until the rule is frozen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-promotion-'));
  try {
    // A plan in the production shape: the rule it starts under is pinned, and each task runs under both policies back to back.
    const planned = await cli(['--mode', 'plan', '--taskset', 'founder', '--environment', 'founder-v2', '--out', join(directory, 'plan')]);
    expect(planned.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(directory, 'plan/manifest.json'), 'utf8'));
    expect(manifest.environment).toBe('founder-v2');
    expect(manifest.promotionRule.sha256).toBe(loadPromotionRule().sha256);
    expect(manifest.scheduled.slice(0, 2).map((i: any) => [i.taskId, i.policy]))
      .toEqual([[manifest.scheduled[0].taskId, 'baseline-v1'], [manifest.scheduled[0].taskId, 'deterministic-first-v1']]);
    const narrower = await cli(['--mode', 'plan', '--taskset', 'founder', '--environment', 'w8', '--out', join(directory, 'narrow')]);
    expect(narrower.code).toBe(1);
    expect(narrower.stderr).toContain('does not contain founder-v1');

    const unstarted = join(directory, 'run');
    mkdirSync(unstarted);
    writeFileSync(join(unstarted, 'manifest.json'), JSON.stringify(run([...baselineRows(), ...candidateRows()]).manifest));
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
}, 90_000);
