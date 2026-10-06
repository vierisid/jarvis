import { fingerprint } from '../../actions/tools/composition-provenance';
import { budgetFor, validateRubric, type Budget, type ReleaseRubric } from './rubric';
import { measure, type Measures, type ScheduledItem } from './measures';
import type { Rate } from './statistics';
import type { EvaluationRow, QualityTask } from './types';

/** One run directory as written by the CLI: its manifest, task set, report and (reviewed) rows. */
export interface BaselineRun {
  source: string; manifest: any; report: any; rows: EvaluationRow[];
  taskset: { version: string; sha256: string; tasks: QualityTask[] };
}
export type Verdict = 'met' | 'not_met' | 'insufficient_sample' | 'incomplete_review' | 'not_measured' | 'not_agreed' | 'unknown_usage';

/** Judges one natural-condition group against a frozen rubric. Pending
 * reviews, missing budgets and small samples are named, never passed. */
export function verdicts(m: Measures, rubric: ReleaseRubric, budget: Budget | null) {
  const sampleOk = m.tasks.supported >= rubric.sample.minSupportedTasks && m.tasks.negative >= rubric.sample.minNegativeTasks;
  const unreviewed = m.rows.human.unreviewedSupported > 0;
  const threshold = (r: Rate, min: number, needsReview: boolean): Verdict => {
    if (r.rate === null) return 'not_measured';
    if (needsReview && unreviewed) return 'incomplete_review';
    // A small sample cannot certify a pass; it can still show a clear failure.
    if (!sampleOk) return r.ci95![1] < min ? 'not_met' : 'insufficient_sample';
    return (rubric.decision === 'lower-bound' ? r.ci95![0] : r.rate) >= min ? 'met' : 'not_met';
  };
  const ceiling = (observed: number, max: number): Verdict => observed > max ? 'not_met' : sampleOk ? 'met' : 'insufficient_sample';
  const human = rubric.intent.measure === 'human-reviewed', intent = human ? m.tasks.human : m.tasks.automatic;
  const median = (value: number | null, max: number): Verdict => value === null ? 'not_measured' : unreviewed ? 'incomplete_review'
    : value > max ? 'not_met' : sampleOk ? 'met' : 'insufficient_sample';
  const within = (value: number | null, max: number | null, unknown = false): Verdict =>
    max === null ? 'not_agreed' : unknown ? 'unknown_usage' : value === null ? 'not_measured' : value <= max ? 'met' : 'not_met';
  const result = {
    sample: (sampleOk ? 'met' : 'insufficient_sample') as Verdict,
    firstCandidateCorrect: threshold(intent.firstCandidate, rubric.intent.minFirstCandidateCorrect, human),
    correctAfterRepair: threshold(intent.afterRepair, rubric.intent.minCorrectAfterRepair, human),
    unexpectedEffects: ceiling(m.effects.unexpected, rubric.safety.maxUnexpectedEffects),
    missedAbstentions: ceiling(m.rows.abstention.missed, rubric.safety.maxMissedAbstentions),
    medianEdits: median(m.supervision.edits.p50, rubric.humanEffort.maxMedianEdits),
    medianCorrectionMs: median(m.supervision.correctionMs.p50, rubric.humanEffort.maxMedianCorrectionMs),
    requestsPerTask: within(m.requestsPerTask.max, budget?.maxRequestsPerTask ?? null),
    tokensPerTask: within(m.tokensPerTask.max, budget?.maxTokensPerTask ?? null, m.tokensPerTask.unknown > 0),
    p95CompositionMs: within(m.compositionMs.p95, budget?.maxP95CompositionMs ?? null),
  };
  const all = Object.values(result);
  return { ...result, overall: all.every(v => v === 'met') ? 'meets_rubric' : all.includes('not_met') ? 'does_not_meet' : 'not_established' };
}

const pick = <T extends object>(value: T | null | undefined, keys: (keyof T)[]) =>
  value ? Object.fromEntries(keys.map(k => [k, value[k] ?? null])) : null;
const LIMITATIONS = [
  'Synthetic held-out tasks with simulated notify and AI effects; not live integration or real-user usefulness certification.',
  'Rates count every scheduled task; unrun, failed, refused and timed-out tasks are not successes.',
  'Profile identity comes from the admin export. Per-request upstream routing is verifiable only from the proxy spend log.',
  'Correction counts and times are reviewer-reported, not instrumented.',
];

/**
 * Splits hosted runs into those a report may use, those that never started,
 * and the problems that refuse the whole report: anything but a hosted
 * held-out measurement under a pinned frozen rubric with admin evidence and
 * authorization, and runs whose rubrics, task sets or profiles do not match.
 */
export function matchedHostedRuns(runs: BaselineRun[]) {
  const problems: string[] = [], notRun: Array<{ profileId: string | null; reasons: string[] }> = [], valid: BaselineRun[] = [];
  for (const run of runs) {
    const m = run.manifest, before = problems.length;
    if (m?.mode !== 'hosted') problems.push(run.source + ' is a ' + (m?.mode ?? 'unknown') + ' run; only hosted runs form a baseline.');
    else if (m.taskset?.split !== 'heldout') problems.push(run.source + ' used the ' + m.taskset?.split + ' split; a baseline uses the held-out set.');
    else if (run.report?.status === 'not_run') notRun.push({ profileId: m.profile?.id ?? null, reasons: run.report.reasons ?? [run.report.reason] });
    else {
      if (!m.rubric?.value || fingerprint(m.rubric.value) !== m.rubric.sha256) problems.push(run.source + ' does not pin its rubric.');
      else if (validateRubric(m.rubric.value).status !== 'frozen') problems.push(run.source + ' ran under an unfrozen rubric.');
      if (!m.profileEvidence) problems.push(run.source + ' has no admin profile evidence.');
      if (!m.authorization) problems.push(run.source + ' has no spend authorization.');
      if (run.rows.some(r => r.kind !== 'hosted')) problems.push(run.source + ' contains rows that are not hosted measurements.');
      if (run.taskset.sha256 !== m.taskset.sha256) problems.push(run.source + ' task set does not match its manifest.');
      if (problems.length === before) valid.push(run);
    }
  }
  const distinct = (values: unknown[]) => new Set(values).size;
  if (distinct(valid.map(r => r.manifest.rubric.sha256)) > 1) problems.push('Runs use different rubrics; compare only matched inputs.');
  if (distinct(valid.map(r => r.manifest.taskset.sha256)) > 1) problems.push('Runs use different task sets; compare only matched inputs.');
  if (distinct(valid.map(r => r.manifest.profile.id)) < valid.length) problems.push('More than one run measures the same profile.');
  return { problems, notRun, valid };
}

/** A sanitized, shareable baseline: aggregates and identities only. No job
 * text, prompts, responses, graphs, error text, URLs or reviewer notes. */
export function baselineReport(runs: BaselineRun[], generatedAt = new Date()) {
  if (!runs.length) throw new Error('A baseline needs at least one run');
  const { problems, notRun, valid } = matchedHostedRuns(runs);
  if (problems.length) return { schemaVersion: 1 as const, kind: 'workflow-hosted-baseline' as const, status: 'refused' as const,
    generatedAt: generatedAt.toISOString(), problems };
  if (!valid.length) return { schemaVersion: 1 as const, kind: 'workflow-hosted-baseline' as const, status: 'not_run' as const,
    generatedAt: generatedAt.toISOString(), notRun, limitations: LIMITATIONS };

  const rubric = validateRubric(valid[0]!.manifest.rubric.value), taskset = valid[0]!.taskset;
  const groups: Record<string, unknown> = {};
  for (const run of valid) {
    const m = run.manifest, profileId: string = m.profile.id, scheduled: ScheduledItem[] = m.scheduled;
    const done = new Set(run.rows.map(r => [r.taskId, r.policy, r.repeat, r.condition].join('\0')));
    for (const policy of [...new Set(scheduled.map(i => i.policy))]) for (const condition of [...new Set(scheduled.map(i => i.condition))]) {
      const items = scheduled.filter(i => i.policy === policy && i.condition === condition);
      const measures = measure(run.rows.filter(r => r.policy === policy && r.condition === condition), taskset.tasks,
        items.filter(i => !done.has([i.taskId, i.policy, i.repeat, i.condition].join('\0'))));
      groups[[profileId, policy, condition].join('/')] = { measures,
        // Thresholds describe natural behaviour; injected-fault runs measure recovery only.
        verdicts: condition === 'natural' ? verdicts(measures, rubric, budgetFor(rubric, profileId)) : null };
    }
  }
  const complete = valid.every(r => r.report?.status === 'completed') && !notRun.length;
  return {
    schemaVersion: 1 as const, kind: 'workflow-hosted-baseline' as const, status: complete ? 'completed' as const : 'incomplete' as const,
    generatedAt: generatedAt.toISOString(),
    rubric: { id: rubric.id, sha256: valid[0]!.manifest.rubric.sha256, frozen: rubric.frozen, decision: rubric.decision },
    taskset: { version: taskset.version, sha256: taskset.sha256, split: 'heldout' as const,
      supportedTasks: taskset.tasks.filter(t => !t.expectation.blocked).length, negativeTasks: taskset.tasks.filter(t => t.expectation.blocked).length },
    runs: valid.map(run => {
      const m = run.manifest, stops: Record<string, number> = {};
      for (const stop of run.rows.flatMap(r => r.interruptions ?? [])) stops[stop.reason] = (stops[stop.reason] ?? 0) + 1;
      return {
        startedAt: m.startedAt, finishedAt: run.report?.finishedAt ?? null, status: run.report?.status ?? null, failed: Boolean(run.report?.failure),
        head: m.head, sourceSha256: m.sourceSha256,
        profile: { id: m.profile.id, version: m.profile.version, intendedModel: m.profile.intendedModel,
          ...pick(m.profileEvidence, ['planKey', 'planName', 'profileKey', 'slot', 'modelKey', 'upstreamModel', 'reasoningEffort',
            'proxyFallbacks', 'exportedAt', 'exportedBy', 'revisionSha256']) },
        authorization: pick(m.authorization, ['approvedBy', 'approvedAt', 'validUntil', 'maxRequests', 'maxTokens']),
        limits: { maxRequests: m.maxRequests ?? null, maxTokens: m.maxTokens ?? null },
        transport: { attempts: run.rows.reduce((n, r) => n + r.transport.length, 0), refused: stops },
      };
    }),
    groups, notRun, limitations: LIMITATIONS,
  };
}
