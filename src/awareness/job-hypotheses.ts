import type { Goal } from '../goals/types.ts';
import type { JobHypothesis, JobSignal, OpportunityAssessment } from './opportunity-types.ts';

import { ROUTINES, ROUTINE_POLICY } from './routine-catalog.ts';
import { groupRoutineEpisodes, OPPORTUNITY_WINDOW_MS } from './routine-episodes.ts';
import { rankOpportunityGoals } from './goal-relevance.ts';
export { OPPORTUNITY_WINDOW_MS } from './routine-episodes.ts';
export { classifyJobSignals } from './routine-signals.ts';

/** Pure boundary: retained observations + current active goals, no writes or execution. */
export function assessJobHypotheses(
  signals: JobSignal[], goals: Goal[], knownPatterns: ReadonlySet<string>, now = Date.now(),
): OpportunityAssessment {
  const recent = signals.filter(s => s.observedAt >= now - OPPORTUNITY_WINDOW_MS && s.observedAt <= now);
  const proposals: JobHypothesis[] = [];
  let recurring = false;
  for (const job of ROUTINES) {
    const episodes = groupRoutineEpisodes(recent.filter(s => s.kind === job.kind), now);
    const days = new Set(episodes.map(e => new Date(e.source.observedAt).toISOString().slice(0, 10)));
    if (episodes.length < 3 || days.size < 2) continue;
    recurring = true;
    // Preserve durable dismissal/interest identity across the policy upgrade.
    const patternKey = `job-v1:${job.kind}`;
    if (knownPatterns.has(patternKey)) continue;
    const evidence = episodes.map(e => e.output);
    const hypothesis: JobHypothesis = {
      schemaVersion: 1, assessedAt: now, patternKey, kind: job.kind,
      job: { title: job.title, proposedOutcome: job.proposedOutcome, question: job.question },
      evidence,
      routine: {
        policy: ROUTINE_POLICY,
        episodes: episodes.map(episode => Object.fromEntries(
          (['source', 'operation', 'output'] as const).map(stage => [stage, {
            captureId: episode[stage].captureId, observedAt: episode[stage].observedAt, cue: job.labels[stage],
          }]),
        ) as NonNullable<JobHypothesis['routine']>['episodes'][number]),
      },
      recurrence: {
        episodes: episodes.length, distinctDays: days.size,
        firstObservedAt: episodes[0]!.source.observedAt,
        lastObservedAt: episodes.at(-1)!.output.observedAt,
        windowDays: 14, basis: 'observed_activity',
      },
      goalCandidates: [],
      feasibility: {
        status: 'unverified',
        requiredChecks: ['source_access', 'output_destination', 'authority', 'workflow_preflight', 'model_profile_quality'],
        reason: 'Screen activity does not establish available integrations, permissions or reliable workflow execution.',
      },
      uncertainty: [
        'Screen text may describe reading or research rather than performing this job.',
        'Separate observations do not prove completed repetitions or time saved.',
        'The job, scope and expected outcome need user confirmation.',
        'Goal candidates are possible relevance only; no goal is linked automatically.',
      ],
    };
    proposals.push({ ...hypothesis, ...rankOpportunityGoals(hypothesis, goals, now) });
  }
  // Only one defensible contribution improves priority; competing links never inflate it.
  proposals.sort((a, b) => b.goalCandidates.length - a.goalCandidates.length
    || b.recurrence.distinctDays - a.recurrence.distinctDays || a.patternKey.localeCompare(b.patternKey));
  return {
    schemaVersion: 1, assessedAt: now, proposals,
    abstention: proposals.length ? null : recent.length === 0 ? 'no_job_evidence'
      : recurring ? 'already_proposed' : 'insufficient_recurrence',
  };
}
