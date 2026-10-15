import type { QualityResult } from './contract';
/** Wilson interval, including the zero/all-success endpoints. */
export function rate(numerator: number, denominator: number) {
  if (!denominator) return { numerator, denominator, rate: null, ci95: null };
  const p = numerator / denominator, z2 = 1.96 ** 2, d = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / d;
  const half = 1.96 * Math.sqrt(p * (1 - p) / denominator + z2 / (4 * denominator ** 2)) / d;
  return { numerator, denominator, rate: p, ci95: [Math.max(0, center - half), Math.min(1, center + half)] };
}
/** Recompute the gate from reviewed aggregates; a free-standing "met" label
 * cannot hide below-threshold results or a changed denominator. */
export function measurementMet(row: QualityResult, q01: any, supplement: any, profile: string): boolean {
  const m = row.measurement;
  if (!m || !q01 || !supplement) return false;
  const lowerBound = q01.decision === 'lower-bound';
  switch (row.check) {
    case 'first-intent': case 'repaired-intent': case 'useful-opportunities': case 'negative-proposals': case 'qualified-recall': {
      if (m.kind !== 'rate' || m.denominator < 1) return false;
      const expected = row.check === 'negative-proposals' ? row.negativeTasks : row.supportedTasks;
      if (m.denominator !== expected) return false;
      if (row.check !== 'negative-proposals' && m.numerator > (row.taskDispositions.passed ?? 0)) return false;
      const value = rate(m.numerator, m.denominator);
      if (row.check === 'negative-proposals') return (lowerBound ? value.ci95![1]! : value.rate!) <= supplement.maxNegativeProposalRate;
      const target = row.check === 'first-intent' ? q01.intent.minFirstCandidateCorrect : row.check === 'repaired-intent' ? q01.intent.minCorrectAfterRepair
        : row.check === 'useful-opportunities' ? supplement.minUsefulOpportunityRate : supplement.minQualifiedRecallRate;
      return (lowerBound ? value.ci95![0]! : value.rate!) >= target;
    }
    case 'grounded-inputs': return m.kind === 'count' && m.value === 0;
    default: {
      if (m.kind !== 'distribution' || m.count !== row.measured) return false;
      const budget = q01.budgets?.[profile] ?? q01.budgets?.['*'];
      if (row.check === 'median-corrections') return m.p50 <= q01.humanEffort.maxMedianEdits;
      if (row.check === 'median-correction-time') return m.p50 <= q01.humanEffort.maxMedianCorrectionMs;
      if (row.check === 'request-budget') return m.max <= budget?.maxRequestsPerTask;
      if (row.check === 'token-budget') return m.max <= budget?.maxTokensPerTask;
      return m.p95 <= budget?.maxP95CompositionMs;
    }
  }
}
export function measurementSummary(row: QualityResult | undefined) {
  const m = row?.measurement;
  if (!m) return null;
  if (m.kind === 'rate') return { kind: m.kind, ...rate(m.numerator, m.denominator), missedEligible: m.missedEligible };
  if (m.kind === 'count') return { kind: m.kind, value: m.value };
  return { kind: m.kind, count: m.count, p50: m.p50, p90: m.p90, p95: m.p95, max: m.max, timeouts: m.timeouts };
}
