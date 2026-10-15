import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assessJobHypotheses, classifyJobSignals } from '../job-hypotheses.ts';
import { applyOpportunityFeedbackPolicy, summarizeOpportunityFeedback, FEEDBACK_POLICY } from '../opportunity-feedback-policy.ts';
import type { FeedbackEvidence } from '../opportunity-feedback-evidence.ts';
import type { JobKind } from '../opportunity-types.ts';
import { routineKey, type ReportCadence } from '../routine-identity.ts';
import { caseCaptures, EVALUATION_NOW, type RoutineCase } from './routine-evaluation.ts';

const DAY = 86_400_000;
export function feedbackCaptures(kind: JobKind = 'recurring_report', cadence: ReportCadence = 'weekly', now = EVALUATION_NOW) {
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/development.json', import.meta.url), 'utf8')) as { cases: RoutineCase[] };
  const source = corpus.cases.find(c => c.usefulRoutine === kind)!;
  const fixture = { ...source, id: `feedback-${kind}-${cadence}`, steps: source.steps.map(step => ({ ...step,
    text: kind === 'recurring_report' ? step.text.replace(/\bweekly\b/gi, cadence) : step.text })) };
  return caseCaptures(fixture).map(c => ({ ...c, timestamp: c.timestamp + now - EVALUATION_NOW }));
}
export function feedbackHypothesis(kind: JobKind = 'recurring_report', cadence: ReportCadence = 'weekly', now = EVALUATION_NOW) {
  return assessJobHypotheses(feedbackCaptures(kind, cadence, now).flatMap(classifyJobSignals), [], new Set(), now).proposals[0]!;
}
export function proposalFeedbackReport() {
  const bytes = readFileSync(new URL('./fixtures/proposal-feedback.json', import.meta.url));
  const corpus = JSON.parse(bytes.toString()) as { provenance: string; cases: Array<{
    id: string; cadence?: ReportCadence; history: Array<{ event: FeedbackEvidence['event']; kind?: JobKind; cadence?: ReportCadence | null;
      daysAgo: number; reason?: string; workRef?: string; useful?: boolean }>;
    expected: { eligible: boolean; priority?: number; rate?: number | null; reportedUses?: number };
  }> };
  const cases = corpus.cases.map(c => {
    const evidence: FeedbackEvidence[] = [];
    c.history.forEach((e, i) => {
      const kind = e.kind ?? 'recurring_report';
      const key = routineKey(kind, e.cadence === null ? undefined : e.cadence ?? 'weekly');
      const opportunityId = `prior:${key}`;
      const base = { opportunityId, routineKey: key, kind };
      if (!evidence.some(row => row.event === 'proposal' && row.opportunityId === opportunityId)) {
        evidence.push({ ...base, ref: opportunityId, source: 'awareness_suggestions', event: 'proposal',
          at: EVALUATION_NOW - Math.max(20, ...c.history.map(row => row.daysAgo + 1)) * DAY });
      }
      const source = e.event === 'accept' || e.event === 'interest' ? 'suggestion_feedback'
        : e.event === 'delivery' ? 'opportunity_delivery' : 'opportunity_feedback';
      evidence.push({ ...base, ref: `${source}:${c.id}:${i}`, source, event: e.event,
        at: EVALUATION_NOW - e.daysAgo * DAY, reason: e.reason, workRef: e.workRef, useful: e.useful });
    });
    const snapshot = { evidence, invalidOutcomeRecords: 0 };
    const assessment = applyOpportunityFeedbackPolicy({ schemaVersion: 1, assessedAt: EVALUATION_NOW,
      proposals: [feedbackHypothesis('recurring_report', c.cadence ?? 'monthly')], abstention: null }, snapshot, EVALUATION_NOW);
    const metrics = summarizeOpportunityFeedback(snapshot, EVALUATION_NOW);
    const actual = { eligible: assessment.proposals.length === 1, priority: assessment.proposals[0]?.feedbackLearning?.priority,
      rate: metrics.usefulResultRate.rate, reportedUses: metrics.reportedUses };
    return { id: c.id, expected: c.expected, actual,
      passed: Object.entries(c.expected).every(([key, value]) => actual[key as keyof typeof actual] === value),
      learning: assessment.proposals[0]?.feedbackLearning ?? null,
      suppression: assessment.feedbackPolicy!.suppressed, abstention: assessment.abstention, metrics };
  });
  return { policy: FEEDBACK_POLICY, provenance: corpus.provenance, corpusSha256: createHash('sha256').update(bytes).digest('hex'),
    total: cases.length, passed: cases.filter(c => c.passed).length, cases };
}
