import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assessJobHypotheses, classifyJobSignals } from '../job-hypotheses.ts';
import type { RoutineCapture } from '../routine-signals.ts';
import { ROUTINE_POLICY } from '../routine-catalog.ts';

export type RoutineCase = {
  id: string; usefulRoutine: string | null;
  steps: Array<{ app: string; text: string }>;
  appOverride?: string; dayOffsets?: number[]; stepGapMinutes?: number;
  devices?: string[]; continuous?: boolean; excluded?: boolean;
};
export const EVALUATION_NOW = Date.UTC(2026, 9, 12, 18);
const DAY = 86_400_000;

/** All dates/IDs are synthetic. Three scheduled sessions do not themselves label a case useful. */
export function caseCaptures(fixture: RoutineCase): RoutineCapture[] {
  if (fixture.continuous) {
    return Array.from({ length: 600 }, (_, i) => {
      const step = fixture.steps[i % fixture.steps.length]!;
      return { captureId: `${fixture.id}-${i}`, timestamp: EVALUATION_NOW - 3 * DAY + i * 5 * 60_000,
        app: step.app, ocrText: step.text, sidecarId: 'fixture-device' };
    });
  }
  return (fixture.dayOffsets ?? [-3, -2, -1]).flatMap((day, episode) => fixture.steps.map((step, i) => ({
    captureId: `${fixture.id}-${episode}-${i}`,
    timestamp: EVALUATION_NOW + day * DAY - 6 * 60 * 60_000 + i * (fixture.stepGapMinutes ?? 2) * 60_000,
    app: fixture.appOverride ?? step.app, ocrText: step.text,
    sidecarId: fixture.devices?.[i] ?? 'fixture-device', excluded: fixture.excluded,
  })));
}

/** Wilson 95% interval for a measured corpus proportion, not classifier confidence. */
export function proportion(numerator: number, denominator: number) {
  if (!denominator) return { numerator, denominator, rate: null, wilson95: null };
  const p = numerator / denominator, z2 = 1.96 ** 2;
  const center = (p + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const radius = 1.96 * Math.sqrt(p * (1 - p) / denominator + z2 / (4 * denominator ** 2)) / (1 + z2 / denominator);
  return { numerator, denominator, rate: p, wilson95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}

export function evaluateRoutines(split: 'development' | 'holdout', implementation = { classifyJobSignals, assessJobHypotheses }) {
  const bytes = readFileSync(new URL(`./fixtures/${split}.json`, import.meta.url));
  const corpus = JSON.parse(bytes.toString()) as { cases: RoutineCase[] };
  const cases = corpus.cases.map(fixture => {
    const signals = caseCaptures(fixture).flatMap(c => implementation.classifyJobSignals(c));
    const result = implementation.assessJobHypotheses(signals, [], new Set(), EVALUATION_NOW);
    const proposed = result.proposals.map(p => p.kind);
    return { id: fixture.id, expected: fixture.usefulRoutine, proposed,
      trueProposals: proposed.filter(k => k === fixture.usefulRoutine).length,
      falseProposals: proposed.filter(k => k !== fixture.usefulRoutine).length,
      missed: fixture.usefulRoutine !== null && !proposed.some(k => k === fixture.usefulRoutine),
      abstention: result.abstention };
  });
  const trueProposals = cases.reduce((n, c) => n + c.trueProposals, 0);
  const falseProposals = cases.reduce((n, c) => n + c.falseProposals, 0);
  return { split, corpusSha256: createHash('sha256').update(bytes).digest('hex'), totalCases: cases.length,
    usefulCases: cases.filter(c => c.expected !== null).length,
    negativeCases: cases.filter(c => c.expected === null).length,
    proposalPrecision: proportion(trueProposals, trueProposals + falseProposals),
    missedUsefulRoutines: proportion(cases.filter(c => c.missed).length, cases.filter(c => c.expected !== null).length),
    falseProposals, cases };
}

export function routineEvaluationReport(implementation?: Parameters<typeof evaluateRoutines>[1]) {
  return { schemaVersion: 1, policy: ROUTINE_POLICY, data: 'synthetic only',
    limitation: 'Small hand-authored, unblinded synthetic split. Wilson intervals describe fixture sampling only; this is not field precision, observed completion, time saved, or model quality. The split was frozen before implementation but visible to its author; it is not an independent blinded holdout.',
    results: [evaluateRoutines('development', implementation), evaluateRoutines('holdout', implementation)] };
}
