import type { JobHypothesis, OpportunityAssessment } from './opportunity-types.ts';
import type { FeedbackEvidence, FeedbackSnapshot } from './opportunity-feedback-evidence.ts';
import { hypothesisRoutineKey, sameRoutine } from './routine-identity.ts';

export const FEEDBACK_POLICY = 'proposal-feedback-v1' as const;
const DAY = 86_400_000;
export const FEEDBACK_WINDOW_MS = 90 * DAY;
export const DISMISS_COOLDOWN_MS = 7 * DAY;
export const UNHELPFUL_COOLDOWN_MS = 14 * DAY;
export const ACCEPT_COOLDOWN_MS = DAY;
export const PROPOSAL_COOLDOWN_MS = DAY;
export type FeedbackLearning = {
  policy: typeof FEEDBACK_POLICY; basis: 'related_routine_user_reports';
  priority: 0 | 1; accepted: number; reportedUses: number; usefulReports: number;
  sourceRefs: string[];
};
export type FeedbackSuppression = {
  routineKey: string; reason: 'already_proposed' | 'dismissed_routine' | 'feedback_cooldown';
  until: number | null; sourceRefs: string[];
};
const current = (e: FeedbackEvidence, now: number) => e.at !== null && e.at <= now && e.at >= now - FEEDBACK_WINDOW_MS;

/** A repeated work reference is not another use; conflicting reports remain unknown. */
export function outcomeReports(evidence: FeedbackEvidence[]) {
  const groups = new Map<string, FeedbackEvidence[]>();
  for (const e of evidence) {
    if (e.event !== 'outcome' || !e.workRef || typeof e.useful !== 'boolean') continue;
    const key = JSON.stringify([e.routineKey, e.workRef]);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const reports = [...groups.values()].filter(group => group.every(e => e.useful === group[0]!.useful)).map(group => group[0]!);
  return { reports, conflictingWorkRefs: [...groups.values()].filter(group => group.some(e => e.useful !== group[0]!.useful)).length };
}

export function applyOpportunityFeedbackPolicy(assessment: OpportunityAssessment, snapshot: FeedbackSnapshot, now: number): OpportunityAssessment {
  const suppressed: FeedbackSuppression[] = [];
  const proposals: JobHypothesis[] = [];
  for (const hypothesis of assessment.proposals) {
    const key = hypothesisRoutineKey(hypothesis);
    if (!key) continue;
    const related = snapshot.evidence.filter(e => e.kind === hypothesis.kind);
    const known = related.filter(e => e.event === 'proposal' && sameRoutine(e.routineKey, key));
    if (known.length) {
      const dismissed = related.filter(e => e.event === 'dismiss' && sameRoutine(e.routineKey, key));
      suppressed.push({ routineKey: key, reason: dismissed.length ? 'dismissed_routine' : 'already_proposed',
        until: null, sourceRefs: (dismissed.length ? dismissed : known).map(e => e.ref) });
      continue;
    }
    const recent = related.filter(e => current(e, now));
    const cooldowns = recent.flatMap(e => {
      const duration = e.event === 'dismiss' ? DISMISS_COOLDOWN_MS
        : e.event === 'outcome' && e.useful === false ? UNHELPFUL_COOLDOWN_MS
          : e.event === 'accept' || e.event === 'validate' ? ACCEPT_COOLDOWN_MS
            : e.event === 'proposal' || e.event === 'delivery' ? PROPOSAL_COOLDOWN_MS : 0;
      return duration && e.at! + duration > now ? [{ until: e.at! + duration, ref: e.ref }] : [];
    });
    if (cooldowns.length) {
      suppressed.push({ routineKey: key, reason: 'feedback_cooldown', until: Math.max(...cooldowns.map(e => e.until)), sourceRefs: cooldowns.map(e => e.ref) });
      continue;
    }
    const { reports } = outcomeReports(recent);
    const useful = reports.filter(e => e.useful);
    const accepted = recent.filter(e => e.event === 'accept');
    const learning: FeedbackLearning = {
      policy: FEEDBACK_POLICY, basis: 'related_routine_user_reports',
      priority: useful.length >= 2 && useful.length > reports.length / 2 ? 1 : 0,
      accepted: new Set(accepted.map(e => e.opportunityId)).size,
      reportedUses: reports.length, usefulReports: useful.length,
      sourceRefs: [...accepted, ...reports].map(e => e.ref),
    };
    proposals.push({ ...hypothesis, patternKey: key, feedbackLearning: learning });
  }
  // Goal evidence remains primary. Clicks/acceptance never supply a usefulness boost.
  proposals.sort((a, b) => b.goalCandidates.length - a.goalCandidates.length
    || b.feedbackLearning!.priority - a.feedbackLearning!.priority
    || b.recurrence.distinctDays - a.recurrence.distinctDays || a.patternKey.localeCompare(b.patternKey));
  return { ...assessment, proposals, abstention: proposals.length ? null : suppressed.length
    ? suppressed.some(s => s.reason === 'feedback_cooldown') ? 'feedback_cooldown' : 'already_proposed' : assessment.abstention,
  feedbackPolicy: { policy: FEEDBACK_POLICY, suppressed } };
}

/** Full retained census. Null rate means missing feedback, never zero usefulness. */
export function summarizeOpportunityFeedback(snapshot: FeedbackSnapshot, now = Date.now()) {
  const evidence = snapshot.evidence.filter(e => e.at === null || e.at <= now);
  const { reports, conflictingWorkRefs } = outcomeReports(evidence);
  const ids = (event: FeedbackEvidence['event']) => new Set(evidence.filter(e => e.event === event).map(e => e.opportunityId));
  const accepted = ids('accept'), validated = ids('validate'), proposed = ids('proposal');
  const withReports = new Set(reports.map(e => e.opportunityId));
  const useful = reports.filter(e => e.useful).length;
  const usesPerRoutine = new Map<string, number>();
  reports.filter(e => e.useful).forEach(e => usesPerRoutine.set(e.routineKey, (usesPerRoutine.get(e.routineKey) ?? 0) + 1));
  const reasons = evidence.filter(e => e.event === 'dismiss' && e.source !== 'awareness_suggestions').map(e => ({
    source: e.source, sourceRef: e.ref, opportunityId: e.opportunityId, routineKey: e.routineKey, reason: e.reason ?? null, at: e.at,
  }));
  const reappearances = evidence.filter(e => e.event === 'proposal' && e.at !== null).filter(proposal => evidence.some(e =>
    e.event === 'dismiss' && e.at !== null && e.at < proposal.at! && e.opportunityId !== proposal.opportunityId
    && sameRoutine(e.routineKey, proposal.routineKey)));
  return {
    policy: FEEDBACK_POLICY, evidenceBasis: 'user_report', accepted: accepted.size, interested: ids('interest').size,
    reportedUses: reports.length, usefulReports: useful, notUsefulReports: reports.length - useful,
    usefulResultRate: { numerator: useful, denominator: reports.length, rate: reports.length ? useful / reports.length : null },
    proposalsWithoutOutcomeFeedback: [...proposed].filter(id => !withReports.has(id)).length,
    acceptedWithoutOutcomeFeedback: [...accepted].filter(id => !withReports.has(id)).length,
    validatedWithoutOutcomeFeedback: [...validated].filter(id => !withReports.has(id)).length,
    repeatedUsefulRoutines: [...usesPerRoutine.values()].filter(count => count >= 2).length,
    dismissalsWithoutTimestamp: [...ids('dismiss')].filter(id => !evidence.some(e => e.opportunityId === id && e.event === 'dismiss' && e.at !== null)).length,
    rejectionReasons: reasons, reappearanceErrors: reappearances.map(e => ({ opportunityId: e.opportunityId, routineKey: e.routineKey, sourceRef: e.ref })),
    invalidOutcomeRecords: snapshot.invalidOutcomeRecords, conflictingWorkRefs,
    verifiedResults: 0, measuredTimeSaved: null,
  };
}
