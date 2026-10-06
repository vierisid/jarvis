import { readFileSync } from 'node:fs';
import { fingerprint, isPlanningPolicy, type PlanningPolicy } from '../../actions/tools/composition-provenance';
import { matchedHostedRuns, type BaselineRun } from './baseline';
import { measure, type Measures, type ScheduledItem } from './measures';
import { validateRubric } from './rubric';

/**
 * When the deterministic-first candidate may replace baseline-v1 as the
 * production default (Q-03). Fixed before the runs it judges, so results
 * cannot move it; a changed threshold is a new id, not an edit.
 */
export interface PromotionRule {
  schemaVersion: 1; id: string; status: 'proposed' | 'frozen'; source: string;
  frozen: null | { at: string; approvedBy: string[] };
  baseline: PlanningPolicy; candidate: PlanningPolicy;
  /** human-reviewed: success and first-candidate correctness need a reviewer's agreement, and edits and correction time count. */
  measure: 'automatic' | 'human-reviewed';
  /** improve: at least one correction measure gets better and none worse. not_worse: none worse. */
  corrections: 'improve' | 'not_worse';
  /** How far, as a share of tasks, the candidate's task success may fall below the baseline's. */
  maxSuccessRegression: number;
}
export const DEFAULT_PROMOTION_RULE_PATH = new URL('./rubric/planning-promotion-v1.json', import.meta.url);

export function validatePromotionRule(value: unknown): PromotionRule {
  const r = value as PromotionRule;
  const fail = (what: string): never => { throw new Error('Invalid promotion rule: ' + what); };
  if (r?.schemaVersion !== 1) fail('schemaVersion');
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(r.id)) fail('id');
  if (typeof r.source !== 'string' || !r.source.trim()) fail('source');
  if (!isPlanningPolicy(r.baseline) || !isPlanningPolicy(r.candidate) || r.baseline === r.candidate) fail('baseline and candidate must be two different known policies');
  if (!['automatic', 'human-reviewed'].includes(r.measure)) fail('measure');
  if (!['improve', 'not_worse'].includes(r.corrections)) fail('corrections');
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

export type Check = 'met' | 'not_met' | 'not_measured' | 'incomplete_review' | 'insufficient_sample';
export type PromotionVerdict = 'promote' | 'keep_baseline' | 'not_established';

/** AI beyond what each task needs: graph steps over its allowance, plus AI calls and delegations no scenario asked for. */
const unnecessaryAi = (m: Measures) => m.ai.excessSteps + m.effects.unrequestedAi;
const share = (n: number | null) => n === null ? 'unmeasured' : `${Math.round(n * 1000) / 10}%`;

/**
 * Judges a candidate group against the baseline group of the same profile,
 * task set and repeats. It must use less unnecessary AI and need fewer
 * corrections, add no unsafe effect or missed abstention, and keep task
 * success within the rule's allowance. Small samples and pending reviews are
 * named, never passed.
 */
export function compareGroups(baseline: Measures, candidate: Measures, rule: PromotionRule, sampleOk: boolean) {
  const human = rule.measure === 'human-reviewed';
  const unreviewed = human && (baseline.rows.human.unreviewedSupported > 0 || candidate.rows.human.unreviewedSupported > 0);
  const intent = (m: Measures) => human ? m.tasks.human : m.tasks.automatic;
  const reasons: string[] = [];

  const ai = { baseline: unnecessaryAi(baseline), candidate: unnecessaryAi(candidate) };
  const aiCheck: Check = ai.candidate < ai.baseline ? 'met' : 'not_met';
  reasons.push(`Unnecessary AI (steps over each task's allowance plus unrequested AI calls): ${ai.baseline} with ${rule.baseline}, ${ai.candidate} with ${rule.candidate}.`);

  // Corrections: correct on the first candidate (no repair needed), and for reviewed runs median edits and correction time.
  type Part = { name: string; baseline: number | null; candidate: number | null; better: 'higher' | 'lower'; show: (n: number | null) => string };
  const count = (n: number | null) => n === null ? 'unmeasured' : String(n);
  const parts: Part[] = [
    { name: 'first-candidate success', baseline: intent(baseline).firstCandidate.rate, candidate: intent(candidate).firstCandidate.rate, better: 'higher', show: share },
    ...(human ? [
      { name: 'median review edits', baseline: baseline.supervision.edits.p50, candidate: candidate.supervision.edits.p50, better: 'lower' as const, show: count },
      { name: 'median correction time (ms)', baseline: baseline.supervision.correctionMs.p50, candidate: candidate.supervision.correctionMs.p50, better: 'lower' as const, show: count },
    ] : []),
  ];
  const direction = (p: Part) => p.candidate === p.baseline ? 0
    : (p.candidate! > p.baseline!) === (p.better === 'higher') ? 1 : -1;
  const correctionCheck: Check = unreviewed ? 'incomplete_review'
    : parts.some(p => p.baseline === null || p.candidate === null) ? 'not_measured'
    : parts.some(p => direction(p) < 0) ? 'not_met'
    : rule.corrections === 'not_worse' || parts.some(p => direction(p) > 0) ? 'met' : 'not_met';
  reasons.push('Corrections: ' + parts.map(p => `${p.name} ${p.show(p.baseline)} to ${p.show(p.candidate)}`).join('; ') + '.');

  const safetyCheck: Check = candidate.effects.unsafe > baseline.effects.unsafe || candidate.rows.abstention.missed > baseline.rows.abstention.missed ? 'not_met' : 'met';
  reasons.push(`Unsafe effects ${baseline.effects.unsafe} to ${candidate.effects.unsafe}; missed abstentions ${baseline.rows.abstention.missed} to ${candidate.rows.abstention.missed}.`);

  const success = { baseline: intent(baseline).afterRepair.rate, candidate: intent(candidate).afterRepair.rate };
  const successCheck: Check = success.baseline === null || success.candidate === null ? 'not_measured' : unreviewed ? 'incomplete_review'
    : success.candidate < success.baseline - rule.maxSuccessRegression ? 'not_met' : 'met';
  reasons.push(`Task success ${share(success.baseline)} to ${share(success.candidate)}; the rule allows a drop of ${share(rule.maxSuccessRegression)}.`);

  const checks = { sample: (sampleOk ? 'met' : 'insufficient_sample') as Check, unnecessaryAi: aiCheck, corrections: correctionCheck,
    safety: safetyCheck, success: successCheck };
  const all = Object.values(checks);
  const verdict: PromotionVerdict = all.includes('not_met') ? 'keep_baseline' : all.every(c => c === 'met') ? 'promote' : 'not_established';
  return { checks, verdict, reasons };
}

/** The numbers a promotion report shares for one group: aggregates only. */
function summary(m: Measures, rule: PromotionRule) {
  const intent = rule.measure === 'human-reviewed' ? m.tasks.human : m.tasks.automatic;
  return {
    tasks: { supported: m.tasks.supported, negative: m.tasks.negative }, scheduled: m.scheduled, notRun: m.notRun,
    success: intent.afterRepair, firstCandidate: intent.firstCandidate,
    unnecessaryAi: { total: unnecessaryAi(m), stepsOverAllowance: m.ai.excessSteps, graphsOverAllowance: m.ai.overAllowance, unrequestedCalls: m.effects.unrequestedAi },
    unsafeEffects: m.effects.unsafe, missedAbstentions: m.rows.abstention.missed,
    review: { reviewed: m.supervision.reviewed, unreviewedSupported: m.rows.human.unreviewedSupported,
      medianEdits: m.supervision.edits.p50, medianCorrectionMs: m.supervision.correctionMs.p50 },
  };
}

const LIMITATIONS = [
  'Synthetic held-out tasks with simulated notify and AI effects; not live integration or real-user usefulness certification.',
  'Both policies run on the same profile, task set and repeats in one hosted run; a different profile is a separate comparison.',
  'Correction counts and times are reviewer-reported, not instrumented.',
  'A promote verdict is evidence for changing the production default, not the change itself.',
];

/**
 * Compares the candidate policy with the baseline on matched hosted runs.
 * Refused for anything a baseline would refuse, for a rule that was not
 * frozen before the runs started, and for runs that did not schedule both
 * policies on the same tasks and repeats. Sanitized like the baseline.
 */
export function promotionReport(runs: BaselineRun[], rule: PromotionRule, generatedAt = new Date()) {
  if (!runs.length) throw new Error('A promotion comparison needs at least one run');
  const header = { schemaVersion: 1 as const, kind: 'workflow-planning-promotion' as const, generatedAt: generatedAt.toISOString() };
  const { problems, notRun, valid } = matchedHostedRuns(runs);
  if (rule.status !== 'frozen') problems.push('Promotion rule ' + rule.id + ' is proposed, not frozen; freeze it before the runs it judges.');
  const pairs = (run: BaselineRun, policy: PlanningPolicy) => (run.manifest.scheduled as ScheduledItem[])
    .filter(i => i.policy === policy && i.condition === 'natural').map(i => i.taskId + '\0' + i.repeat).sort();
  for (const run of valid) {
    if (rule.status === 'frozen' && Date.parse(rule.frozen!.at) > Date.parse(run.manifest.startedAt))
      problems.push(run.source + ' started before promotion rule ' + rule.id + ' was frozen; a rule must be fixed before the runs it judges.');
    const base = pairs(run, rule.baseline), candidate = pairs(run, rule.candidate);
    if (!base.length || JSON.stringify(base) !== JSON.stringify(candidate))
      problems.push(run.source + ' did not run both policies on the same natural-condition tasks and repeats; compare only matched inputs.');
  }
  if (problems.length) return { ...header, status: 'refused' as const, problems };
  if (!valid.length) return { ...header, status: 'not_run' as const, notRun, limitations: LIMITATIONS };

  const rubric = validateRubric(valid[0]!.manifest.rubric.value), taskset = valid[0]!.taskset;
  const profiles: Record<string, unknown> = {};
  const verdicts: PromotionVerdict[] = [];
  for (const run of valid) {
    const scheduled: ScheduledItem[] = run.manifest.scheduled;
    const done = new Set(run.rows.map(r => [r.taskId, r.policy, r.repeat, r.condition].join('\0')));
    const group = (policy: PlanningPolicy) => {
      const items = scheduled.filter(i => i.policy === policy && i.condition === 'natural');
      return measure(run.rows.filter(r => r.policy === policy && r.condition === 'natural'), taskset.tasks,
        items.filter(i => !done.has([i.taskId, i.policy, i.repeat, i.condition].join('\0'))));
    };
    const base = group(rule.baseline), candidate = group(rule.candidate);
    // Both groups hold the same tasks, so one sample check covers the pair.
    const sampleOk = base.tasks.supported >= rubric.sample.minSupportedTasks && base.tasks.negative >= rubric.sample.minNegativeTasks;
    const result = compareGroups(base, candidate, rule, sampleOk);
    verdicts.push(result.verdict);
    profiles[run.manifest.profile.id] = { baseline: summary(base, rule), candidate: summary(candidate, rule), ...result };
  }
  const complete = valid.every(r => r.report?.status === 'completed') && !notRun.length;
  const verdict: PromotionVerdict = verdicts.includes('keep_baseline') ? 'keep_baseline'
    : complete && verdicts.every(v => v === 'promote') ? 'promote' : 'not_established';
  return {
    ...header, status: complete ? 'completed' as const : 'incomplete' as const, verdict,
    rule: { id: rule.id, sha256: fingerprint(rule), frozen: rule.frozen, baseline: rule.baseline, candidate: rule.candidate },
    rubric: { id: rubric.id, sha256: valid[0]!.manifest.rubric.sha256 },
    taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout' as const },
    profiles, notRun, limitations: LIMITATIONS,
  };
}
