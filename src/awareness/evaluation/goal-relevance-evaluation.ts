import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Goal } from '../../goals/types.ts';
import type { JobKind } from '../opportunity-types.ts';
import { assessJobHypotheses, classifyJobSignals } from '../job-hypotheses.ts';
import { GOAL_RELEVANCE_POLICY } from '../goal-relevance.ts';
import { EVALUATION_NOW, caseCaptures, type RoutineCase } from './routine-evaluation.ts';

export type GoalFixture = Partial<Goal> & { id: string; title: string; ageDays?: number; deadlineDays?: number };
export function fixtureGoal(input: GoalFixture, now = EVALUATION_NOW): Goal {
  const { ageDays = 0, deadlineDays, ...fields } = input;
  return { parent_id: null, level: 'objective', description: '', success_criteria: '', time_horizon: 'monthly',
    score: 0.4, score_reason: null, status: 'active', health: 'on_track', deadline: deadlineDays === undefined ? null : now + deadlineDays * 86_400_000,
    started_at: null, estimated_hours: null, actual_hours: 0, authority_level: 0, tags: [], dependencies: [],
    escalation_stage: 'none', escalation_started_at: null, sort_order: 0, created_at: now - Math.max(1, ageDays) * 86_400_000,
    updated_at: now - ageDays * 86_400_000, completed_at: null, ...fields };
}
export function fixtureSignals(kind: JobKind) {
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/development.json', import.meta.url), 'utf8')) as { cases: RoutineCase[] };
  const routine = corpus.cases.find(c => c.usefulRoutine === kind)!;
  return caseCaptures(routine).flatMap(classifyJobSignals);
}
export function goalRelevanceReport() {
  const bytes = readFileSync(new URL('./fixtures/goal-relevance.json', import.meta.url));
  const corpus = JSON.parse(bytes.toString()) as { provenance: string; cases: Array<{
    id: string; kind: JobKind; goals: GoalFixture[]; expected: string | null; status: string; limitation?: string;
  }> };
  const cases = corpus.cases.map(c => {
    const hypothesis = assessJobHypotheses(fixtureSignals(c.kind), c.goals.map(g => fixtureGoal(g)), new Set(), EVALUATION_NOW).proposals[0]!;
    const actual = hypothesis.goalCandidates[0]?.goalId ?? null;
    return { id: c.id, expected: c.expected, actual, status: hypothesis.goalRelevance!.status,
      passed: actual === c.expected && hypothesis.goalRelevance!.status === c.status,
      limitation: c.limitation ?? null, candidate: hypothesis.goalCandidates[0] ?? null };
  });
  return { policy: GOAL_RELEVANCE_POLICY, corpusSha256: createHash('sha256').update(bytes).digest('hex'),
    provenance: corpus.provenance, total: cases.length, passed: cases.filter(c => c.passed).length,
    proposedLinks: cases.filter(c => c.actual !== null).length,
    expectedAbstentions: cases.filter(c => c.expected === null).length,
    knownUnsupportedUsefulRelations: cases.filter(c => c.limitation).length, cases };
}
