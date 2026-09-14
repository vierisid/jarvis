import type { Goal } from '../goals/types.ts';
import type { JobHypothesis, JobKind, JobSignal, OpportunityAssessment } from './opportunity-types.ts';

export const OPPORTUNITY_WINDOW_MS = 14 * 86_400_000;
const EPISODE_GAP_MS = 30 * 60_000;

// Deliberately bounded vocabulary: these cues support asking about a job, not
// claiming that it was performed. App names alone never match. No model calls.
const JOBS: Array<{
  kind: JobKind; pattern: RegExp; cue: string;
  title: string; proposedOutcome: string; question: string;
}> = [
  {
    kind: 'invoice_review',
    pattern: /\b(?:(?:unpaid|overdue|outstanding) invoices?|invoices? (?:overdue|unpaid|outstanding))\b/i,
    cue: 'unpaid or overdue invoices',
    title: 'Review invoices needing follow-up',
    proposedOutcome: 'A checked list of unpaid invoices and draft follow-ups for approval.',
    question: 'Is reviewing unpaid invoices a recurring job, and what output would help?',
  },
  {
    kind: 'lead_followup',
    pattern: /\b(?:(?:lead|prospect)s? (?:follow[ -]?up|outreach)|(?:follow[ -]?up|outreach) (?:for |with )?(?:lead|prospect)s?)\b/i,
    cue: 'lead or prospect follow-up',
    title: 'Prepare lead follow-ups',
    proposedOutcome: 'A checked list of leads due for follow-up and drafts for approval.',
    question: 'Is following up with leads a recurring job, and what output would help?',
  },
  {
    kind: 'recurring_report',
    pattern: /\b(?:daily|weekly|monthly) (?:sales |revenue |pipeline |performance |status )?report\b/i,
    cue: 'daily, weekly or monthly report',
    title: 'Prepare a recurring report',
    proposedOutcome: 'A draft report with source references and figures checked before sharing.',
    question: 'Do you prepare this report repeatedly, and which sources and checks does it need?',
  },
];

export function classifyJobSignals(input: {
  captureId: string; timestamp: number; app?: string | null;
  windowTitle?: string | null; ocrText?: string | null;
}): JobSignal[] {
  if (!input.captureId || !Number.isFinite(input.timestamp)) return [];
  const text = `${input.windowTitle?.slice(0, 240) ?? ''}\n${input.ocrText?.slice(0, 2000) ?? ''}`;
  return JOBS.filter(job => job.pattern.test(text)).map(job => ({
    captureId: input.captureId, observedAt: input.timestamp,
    app: (input.app || 'Unknown app').slice(0, 100), kind: job.kind, cue: job.cue,
  }));
}

/** Pure boundary: retained observations + current active goals, no writes or execution. */
export function assessJobHypotheses(
  signals: JobSignal[], goals: Goal[], knownPatterns: ReadonlySet<string>, now = Date.now(),
): OpportunityAssessment {
  const recent = signals.filter(s => s.observedAt >= now - OPPORTUNITY_WINDOW_MS && s.observedAt <= now);
  const proposals: JobHypothesis[] = [];
  let recurring = false;
  for (const job of JOBS) {
    const seen = new Set<string>();
    const observations = recent.filter(s => {
      if (s.kind !== job.kind || seen.has(s.captureId)) return false;
      seen.add(s.captureId);
      return true;
    }).sort((a, b) => a.observedAt - b.observedAt || a.captureId.localeCompare(b.captureId));
    const episodes: JobSignal[] = [];
    let lastObserved = -Infinity;
    for (const signal of observations) {
      // Continuous captures count as one episode, even across midnight or sessions.
      if (signal.observedAt - lastObserved >= EPISODE_GAP_MS) episodes.push(signal);
      lastObserved = signal.observedAt;
    }
    const days = new Set(episodes.map(s => new Date(s.observedAt).toISOString().slice(0, 10)));
    if (episodes.length < 3 || days.size < 2) continue;
    recurring = true;
    const patternKey = `job-v1:${job.kind}`;
    if (knownPatterns.has(patternKey)) continue;
    // One representative per episode, bounded by a 14-day / 30-minute window.
    const evidence = episodes;
    const goalCandidates = goals.filter(g => g.status === 'active' && job.pattern.test(
      `${g.title} ${g.description} ${g.success_criteria}`,
    )).slice(0, 5).map(g => ({
      goalId: g.id, title: g.title,
      reason: `The goal and observed activity both mention ${job.cue}. This does not establish that the activity serves the goal.`,
      evidenceCaptureIds: evidence.map(e => e.captureId),
      basis: 'text_overlap_requires_confirmation' as const,
    }));
    proposals.push({
      schemaVersion: 1, assessedAt: now, patternKey, kind: job.kind,
      job: { title: job.title, proposedOutcome: job.proposedOutcome, question: job.question },
      evidence,
      recurrence: {
        episodes: episodes.length, distinctDays: days.size,
        firstObservedAt: observations[0]!.observedAt,
        lastObservedAt: observations.at(-1)!.observedAt,
        windowDays: 14, basis: 'observed_activity',
      },
      goalCandidates,
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
    });
  }
  // Goal relevance breaks ties without inventing a probability or a business score.
  proposals.sort((a, b) => b.goalCandidates.length - a.goalCandidates.length
    || b.recurrence.distinctDays - a.recurrence.distinctDays || a.patternKey.localeCompare(b.patternKey));
  return {
    schemaVersion: 1, assessedAt: now, proposals,
    abstention: proposals.length ? null : recent.length === 0 ? 'no_job_evidence'
      : recurring ? 'already_proposed' : 'insufficient_recurrence',
  };
}
