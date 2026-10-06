import { readFileSync } from 'node:fs';
import { COMPOSER_PROMPT_VERSION, fingerprint, isPlanningPolicy, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import { matchedHostedRuns, runLabel, type BaselineRun } from './baseline';
import { environmentFor, productionShaped } from './environment';
import { excessEffects, measure, type Measures, type ScheduledItem } from './measures';
import { validateRubric } from './rubric';
import type { EvaluationRow, QualityTask } from './types';

/**
 * When the deterministic-first candidate may replace baseline-v1 as the
 * production default (Q-03). Hosted runs pin the rule they start under, and a
 * comparison is judged only by that rule, so results cannot move it; a changed
 * threshold is a new id, not an edit.
 */
export interface PromotionRule {
  schemaVersion: 1; id: string; status: 'proposed' | 'frozen'; source: string;
  frozen: null | { at: string; approvedBy: string[] };
  baseline: PlanningPolicy; candidate: PlanningPolicy;
  /** human-reviewed: success and first-candidate correctness need a reviewer's agreement, and edits and correction time count. */
  measure: 'automatic' | 'human-reviewed';
  /** How far, as a share of tasks, the candidate's task success may fall below the baseline's. */
  maxSuccessRegression: number;
}
export const DEFAULT_PROMOTION_RULE_PATH = new URL('./rubric/planning-promotion-v1.json', import.meta.url);
const RULE_FIELDS = ['schemaVersion', 'id', 'status', 'source', 'frozen', 'baseline', 'candidate', 'measure', 'maxSuccessRegression'];

export function validatePromotionRule(value: unknown): PromotionRule {
  const r = value as PromotionRule;
  const fail = (what: string): never => { throw new Error('Invalid promotion rule: ' + what); };
  if (r?.schemaVersion !== 1) fail('schemaVersion');
  // A rule is frozen evidence: an unknown field would be a threshold nothing enforces.
  for (const key of Object.keys(r)) if (!RULE_FIELDS.includes(key)) fail('unknown field ' + key);
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(r.id)) fail('id');
  if (typeof r.source !== 'string' || !r.source.trim()) fail('source');
  if (!isPlanningPolicy(r.baseline) || !isPlanningPolicy(r.candidate) || r.baseline === r.candidate) fail('baseline and candidate must be two different known policies');
  if (!['automatic', 'human-reviewed'].includes(r.measure)) fail('measure');
  if (typeof r.maxSuccessRegression !== 'number' || !(r.maxSuccessRegression >= 0 && r.maxSuccessRegression <= 1)) fail('maxSuccessRegression');
  if (r.status === 'proposed') { if (r.frozen !== null) fail('a proposed rule has no freeze record'); }
  else if (r.status === 'frozen') {
    if (typeof r.frozen?.at !== 'string' || !Number.isFinite(Date.parse(r.frozen.at))
      || !Array.isArray(r.frozen.approvedBy) || !r.frozen.approvedBy.length
      || !r.frozen.approvedBy.every(name => typeof name === 'string' && name.trim().length > 0)) fail('a frozen rule needs its date and approvers');
  } else fail('status');
  return r;
}

export function loadPromotionRule(path: string | URL = DEFAULT_PROMOTION_RULE_PATH): { rule: PromotionRule; sha256: string } {
  const rule = validatePromotionRule(JSON.parse(readFileSync(path, 'utf8')));
  return { rule, sha256: fingerprint(rule) };
}

export type Check = 'met' | 'not_met' | 'not_measured' | 'incomplete_review' | 'insufficient_sample' | 'incomplete';
export type PromotionVerdict = 'promote' | 'keep_baseline' | 'not_established';

/**
 * AI one composed graph uses beyond its job's needs: AI steps over the task's
 * allowance, or the most extra AI calls and delegations any one scenario made,
 * whichever is larger. One extra step counts once, however many scenarios run it.
 */
export function graphUnnecessaryAi(row: EvaluationRow, task: QualityTask): number {
  const steps = Math.max(0, (row.aiSteps ?? 0) - task.expectation.maxAiSteps);
  const calls = row.scenarios.reduce((most, result) => {
    const expected = task.scenarios.find(s => s.id === result.id);
    return expected ? Math.max(most, excessEffects(expected, result.receipts).ai) : most;
  }, 0);
  return Math.max(steps, calls);
}

/** Unnecessary AI on the tasks and repeats where both policies composed a graph, so abstaining or failing to compose cannot lower it. */
export function matchedUnnecessaryAi(baseline: EvaluationRow[], candidate: EvaluationRow[], tasks: QualityTask[]) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const key = (r: EvaluationRow) => r.taskId + '\0' + r.repeat;
  const composed = (r: EvaluationRow) => r.aiSteps !== null;
  const other = new Map(candidate.filter(composed).map(r => [key(r), r]));
  const result = { graphs: 0, baseline: 0, candidate: 0 };
  for (const row of baseline.filter(composed)) {
    const match = other.get(key(row)), task = byId.get(row.taskId);
    if (!match || !task) continue;
    result.graphs++;
    result.baseline += graphUnnecessaryAi(row, task);
    result.candidate += graphUnnecessaryAi(match, task);
  }
  return result;
}

const share = (n: number | null) => n === null ? 'unmeasured' : `${Math.round(n * 1000) / 10}%`;
const count = (n: number | null) => n === null ? 'unmeasured' : String(n);
/** Rates are ratios of small integers; this absorbs float error at an exact threshold. */
const EPSILON = 1e-9;

/**
 * Judges a candidate group against the baseline group of the same profile,
 * task set and repeats. It must use less unnecessary AI on the graphs both
 * composed, compose as many jobs and abstain falsely no more often, need fewer
 * corrections, add no unsafe effect or missed abstention, and keep task
 * success within the rule's allowance. An incomplete group decides nothing;
 * small samples and pending reviews are named, never passed.
 */
export function compareGroups(baseline: Measures, candidate: Measures, ai: ReturnType<typeof matchedUnnecessaryAi>,
  rule: PromotionRule, sampleOk: boolean) {
  const human = rule.measure === 'human-reviewed';
  const unreviewed = human && (baseline.rows.human.unreviewedSupported > 0 || candidate.rows.human.unreviewedSupported > 0);
  const intent = (m: Measures) => human ? m.tasks.human : m.tasks.automatic;
  const reasons: string[] = [];

  const unrun = baseline.notRun + candidate.notRun;
  const completeCheck: Check = unrun ? 'incomplete' : 'met';
  if (unrun) reasons.push(`${unrun} scheduled items did not run; an incomplete comparison decides nothing.`);

  const aiCheck: Check = !ai.graphs ? 'not_measured' : ai.candidate < ai.baseline ? 'met' : 'not_met';
  reasons.push(`Unnecessary AI on the ${ai.graphs} graphs both policies composed: ${ai.baseline} with ${rule.baseline}, ${ai.candidate} with ${rule.candidate}.`);

  // Composing less is not using less AI: the candidate must compose as many jobs and abstain falsely no more often.
  const composedCheck: Check = candidate.ai.graphs >= baseline.ai.graphs
    && candidate.rows.abstention.falseOnSupported <= baseline.rows.abstention.falseOnSupported ? 'met' : 'not_met';
  reasons.push(`Supported jobs composed ${baseline.ai.graphs} to ${candidate.ai.graphs}; false abstentions ${baseline.rows.abstention.falseOnSupported} to ${candidate.rows.abstention.falseOnSupported}.`);

  // Corrections: correct on the first candidate (no repair needed), and for reviewed runs median edits and correction time.
  // At least one must improve and none get worse.
  type Part = { name: string; baseline: number | null; candidate: number | null; better: 'higher' | 'lower'; show: (n: number | null) => string };
  const parts: Part[] = [
    { name: 'first-candidate success', baseline: intent(baseline).firstCandidate.rate, candidate: intent(candidate).firstCandidate.rate, better: 'higher', show: share },
    ...(human ? [
      { name: 'median review edits', baseline: baseline.supervision.edits.p50, candidate: candidate.supervision.edits.p50, better: 'lower' as const, show: count },
      { name: 'median correction time (ms)', baseline: baseline.supervision.correctionMs.p50, candidate: candidate.supervision.correctionMs.p50, better: 'lower' as const, show: count },
    ] : []),
  ];
  const direction = (p: Part) => Math.abs(p.candidate! - p.baseline!) < EPSILON ? 0
    : (p.candidate! > p.baseline!) === (p.better === 'higher') ? 1 : -1;
  const correctionCheck: Check = unreviewed ? 'incomplete_review'
    : parts.some(p => p.baseline === null || p.candidate === null) ? 'not_measured'
    : parts.some(p => direction(p) < 0) ? 'not_met'
    : parts.some(p => direction(p) > 0) ? 'met' : 'not_met';
  reasons.push('Corrections: ' + parts.map(p => `${p.name} ${p.show(p.baseline)} to ${p.show(p.candidate)}`).join('; ') + '.');

  const safetyCheck: Check = candidate.effects.unsafe > baseline.effects.unsafe || candidate.rows.abstention.missed > baseline.rows.abstention.missed ? 'not_met' : 'met';
  reasons.push(`Unsafe effects ${baseline.effects.unsafe} to ${candidate.effects.unsafe}; missed abstentions ${baseline.rows.abstention.missed} to ${candidate.rows.abstention.missed}.`);

  const success = { baseline: intent(baseline).afterRepair.rate, candidate: intent(candidate).afterRepair.rate };
  const successCheck: Check = success.baseline === null || success.candidate === null ? 'not_measured' : unreviewed ? 'incomplete_review'
    : success.candidate + EPSILON < success.baseline - rule.maxSuccessRegression ? 'not_met' : 'met';
  reasons.push(`Task success ${share(success.baseline)} to ${share(success.candidate)}; the rule allows a drop of ${share(rule.maxSuccessRegression)}.`);

  const checks = { complete: completeCheck, sample: (sampleOk ? 'met' : 'insufficient_sample') as Check, unnecessaryAi: aiCheck,
    composed: composedCheck, corrections: correctionCheck, safety: safetyCheck, success: successCheck };
  const all = Object.values(checks);
  const verdict: PromotionVerdict = completeCheck !== 'met' ? 'not_established'
    : all.includes('not_met') ? 'keep_baseline' : all.every(c => c === 'met') ? 'promote' : 'not_established';
  return { checks, verdict, reasons };
}

/** The numbers a promotion report shares for one group: aggregates and fingerprints only. */
function summary(m: Measures, rule: PromotionRule, ai: number) {
  const intent = rule.measure === 'human-reviewed' ? m.tasks.human : m.tasks.automatic;
  return {
    tasks: { supported: m.tasks.supported, negative: m.tasks.negative }, scheduled: m.scheduled, notRun: m.notRun,
    success: intent.afterRepair, firstCandidate: intent.firstCandidate,
    composed: m.ai.graphs, falseAbstentions: m.rows.abstention.falseOnSupported,
    unnecessaryAiOnMatchedGraphs: ai, stepsOverAllowance: m.ai.excessSteps, unrequestedAiCalls: m.effects.unrequestedAi,
    unsafeEffects: m.effects.unsafe, missedAbstentions: m.rows.abstention.missed,
    review: { reviewed: m.supervision.reviewed, unreviewedSupported: m.rows.human.unreviewedSupported,
      medianEdits: m.supervision.edits.p50, medianCorrectionMs: m.supervision.correctionMs.p50 },
    promptSha256s: m.promptSha256s,
  };
}

const LIMITATIONS = [
  'Synthetic held-out tasks with simulated notify and AI effects; not live integration or real-user usefulness certification.',
  'Both policies run on the same profile, task set and repeats in one hosted run; a different profile or production shape is a separate comparison.',
  'Correction counts and times are reviewer-reported, not instrumented.',
  'A promote verdict is evidence for changing the default, not the change; it holds for the composer prompt version it measured.',
];

/**
 * Compares the candidate policy with the baseline on matched hosted runs.
 * Refused for anything a baseline would refuse, and unless every run pinned
 * this frozen rule when it started, ran in a production-shaped environment,
 * scheduled both policies on the same natural-condition tasks and repeats,
 * and measured one composer prompt version. Sanitized like the baseline.
 */
export function promotionReport(runs: BaselineRun[], rule: PromotionRule, generatedAt = new Date()) {
  if (!runs.length) throw new Error('A promotion comparison needs at least one run');
  const header = { schemaVersion: 1 as const, kind: 'workflow-planning-promotion' as const, generatedAt: generatedAt.toISOString() };
  const { problems, notRun, valid } = matchedHostedRuns(runs);
  const sha256 = fingerprint(rule);
  if (rule.status !== 'frozen') problems.push('Promotion rule ' + rule.id + ' is proposed, not frozen; freeze it before the runs it judges.');
  const pairs = (run: BaselineRun, policy: PlanningPolicy) => (run.manifest.scheduled as ScheduledItem[])
    .filter(i => i.policy === policy && i.condition === 'natural').map(i => i.taskId + '\0' + i.repeat).sort();
  const environmentOf = (run: BaselineRun): string => run.manifest.environment ?? run.manifest.taskset?.environment ?? 'w8';
  for (const run of valid) {
    const m = run.manifest, label = runLabel(run), pinned = m.promotionRule;
    if (!Number.isFinite(Date.parse(m.startedAt))) problems.push(label + ' has no valid start time.');
    // The run's own record of the rule it began under is the evidence; the file passed in must be that rule.
    if (!pinned?.value || fingerprint(pinned.value) !== pinned.sha256) problems.push(label + ' did not pin a promotion rule when it started.');
    else if (pinned.sha256 !== sha256) problems.push(label + ' started under a different promotion rule (' + pinned.id + ', ' + pinned.sha256.slice(0, 12) + '); a rule cannot change after the runs it judges.');
    // Same fingerprint: the run began under this very rule, so a proposed rule is refused above.
    else if (rule.status === 'frozen' && Date.parse(rule.frozen!.at) > Date.parse(m.startedAt)) problems.push(label + ' started before promotion rule ' + rule.id + ' was frozen.');
    let shaped = false;
    try { shaped = productionShaped(environmentFor(environmentOf(run))); } catch { /* an unknown environment is not production-shaped */ }
    if (!shaped) problems.push(label + ' ran in environment ' + environmentOf(run) + ', which lacks what production shows the composer; run the comparison with --environment founder-v2 or founder-v2-hosted.');
    const base = pairs(run, rule.baseline), candidate = pairs(run, rule.candidate);
    if (!base.length || JSON.stringify(base) !== JSON.stringify(candidate))
      problems.push(label + ' did not run both policies on the same natural-condition tasks and repeats; compare only matched inputs.');
  }
  const measured = [...new Set(valid.flatMap(run => run.rows.map(r => r.provenance.promptVersion)))].sort();
  if (measured.length > 1) problems.push('The runs measured more than one composer prompt version (' + measured.join(', ') + '); compare runs of one version.');
  if (problems.length) return { ...header, status: 'refused' as const, problems };
  if (!valid.length) return { ...header, status: 'not_run' as const, notRun, limitations: LIMITATIONS };

  const rubric = validateRubric(valid[0]!.manifest.rubric.value), taskset = valid[0]!.taskset;
  const profiles: Record<string, unknown> = {};
  const verdicts: PromotionVerdict[] = [];
  for (const run of valid) {
    const scheduled: ScheduledItem[] = run.manifest.scheduled;
    const done = new Set(run.rows.map(r => [r.taskId, r.policy, r.repeat, r.condition].join('\0')));
    const rowsOf = (policy: PlanningPolicy) => run.rows.filter(r => r.policy === policy && r.condition === 'natural');
    const group = (policy: PlanningPolicy) => measure(rowsOf(policy), taskset.tasks,
      scheduled.filter(i => i.policy === policy && i.condition === 'natural' && !done.has([i.taskId, i.policy, i.repeat, i.condition].join('\0'))));
    const base = group(rule.baseline), candidate = group(rule.candidate);
    const ai = matchedUnnecessaryAi(rowsOf(rule.baseline), rowsOf(rule.candidate), taskset.tasks);
    // Both groups hold the same tasks, so one sample check covers the pair.
    const sampleOk = base.tasks.supported >= rubric.sample.minSupportedTasks && base.tasks.negative >= rubric.sample.minNegativeTasks;
    const result = compareGroups(base, candidate, ai, rule, sampleOk);
    verdicts.push(result.verdict);
    profiles[run.manifest.profile.id] = { environment: environmentOf(run),
      baseline: summary(base, rule, ai.baseline), candidate: summary(candidate, rule, ai.candidate), ...result };
  }
  const complete = valid.every(r => r.report?.status === 'completed') && !notRun.length;
  // A verdict holds for the prompt it measured: today's composer must send the same version to promote.
  const promptVersion = { measured: measured[0] ?? null, current: COMPOSER_PROMPT_VERSION };
  const current = promptVersion.measured === promptVersion.current;
  const verdict: PromotionVerdict = verdicts.includes('keep_baseline') ? 'keep_baseline'
    : complete && current && verdicts.every(v => v === 'promote') ? 'promote' : 'not_established';
  return {
    ...header, status: complete ? 'completed' as const : 'incomplete' as const, verdict,
    rule: { id: rule.id, sha256, frozen: rule.frozen, baseline: rule.baseline, candidate: rule.candidate },
    rubric: { id: rubric.id, sha256: valid[0]!.manifest.rubric.sha256 },
    taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout' as const },
    promptVersion,
    runs: valid.map(run => ({ profileId: run.manifest.profile.id, startedAt: run.manifest.startedAt, finishedAt: run.report?.finishedAt ?? null,
      status: run.report?.status ?? null, head: run.manifest.head ?? null, sourceSha256: run.manifest.sourceSha256 ?? null,
      environment: environmentOf(run) })),
    profiles, notRun, limitations: LIMITATIONS,
  };
}
