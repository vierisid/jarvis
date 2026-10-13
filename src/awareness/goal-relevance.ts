import type { Goal } from '../goals/types.ts';
import type { JobHypothesis, GoalCandidate, GoalRelevance } from './opportunity-types.ts';
import { GOAL_CONTRIBUTIONS } from './goal-contributions.ts';
import { ROUTINES, ROUTINE_POLICY } from './routine-catalog.ts';
import { OPPORTUNITY_WINDOW_MS } from './routine-episodes.ts';

export const GOAL_RELEVANCE_POLICY = 'goal-contribution-v1' as const;
export const GOAL_FRESHNESS_MS = 90 * 86_400_000;
export const GOAL_CONTEXT_LIMIT = 1000;
const NON_OPERATIONAL = /\b(?:research|tutorial|article|blog|guide|fiction|novel|example|training|learn|study|translate|demo|not|never|avoid|stop|without)\b|\bdon['’]t\b/i;
type Evidence = Pick<JobHypothesis, 'kind' | 'routine' | 'evidence'>;

function current(goal: Goal, now: number): boolean {
  // These columns are nullable in older vaults despite the current TypeScript type.
  if (typeof goal.title !== 'string' || typeof goal.description !== 'string' || typeof goal.success_criteria !== 'string') return false;
  return goal.status === 'active' && goal.completed_at === null
    && Number.isSafeInteger(goal.updated_at) && goal.updated_at <= now
    && goal.updated_at >= now - GOAL_FRESHNESS_MS
    && (goal.deadline === null || Number.isSafeInteger(goal.deadline) && goal.deadline >= now)
    && goal.title.length <= 300 && goal.description.length <= 6000 && goal.success_criteria.length <= 300
    && !NON_OPERATIONAL.test(`${goal.title}\n${goal.description}\n${goal.success_criteria}`);
}

/** The whole current path is required; missing, cyclic or inactive ancestors fail closed. */
function objectivePath(goal: Goal, byId: Map<string, Goal>, now: number): Goal[] | null {
  const path: Goal[] = [];
  const seen = new Set<string>();
  let node: Goal | undefined = goal;
  while (node) {
    if (seen.has(node.id) || path.length >= 10 || !current(node, now)) return null;
    seen.add(node.id);
    path.unshift(node);
    if (node.parent_id === null) return node.level === 'objective' ? path : null;
    node = byId.get(node.parent_id);
  }
  return null;
}

function evidenceIds(hypothesis: Evidence, now: number): string[] {
  if (hypothesis.routine?.policy !== ROUTINE_POLICY) return [];
  const episodes = hypothesis.routine.episodes;
  const seen = new Set<string>();
  const days = new Set<string>();
  const ids: string[] = [];
  for (const episode of episodes) {
    const roles = [episode.source, episode.operation, episode.output];
    if (new Set(roles.map(r => r.captureId)).size !== 3) continue;
    if (roles.some(r => !r.captureId || seen.has(r.captureId) || !Number.isSafeInteger(r.observedAt)
      || r.observedAt < now - OPPORTUNITY_WINDOW_MS || r.observedAt > now)) continue;
    if (!(episode.source.observedAt < episode.operation.observedAt && episode.operation.observedAt < episode.output.observedAt)) continue;
    if (!hypothesis.evidence.some(e => e.captureId === episode.output.captureId
      && e.observedAt === episode.output.observedAt && e.kind === hypothesis.kind)) continue;
    roles.forEach(r => { seen.add(r.captureId); ids.push(r.captureId); });
    days.add(new Date(episode.source.observedAt).toISOString().slice(0, 10));
  }
  return ids.length >= 9 && days.size >= 2 ? ids : [];
}

/** Read-only projection. Never confirms a relation, writes progress or interprets app names. */
export function rankOpportunityGoals(hypothesis: Evidence, goals: Goal[], now: number): {
  goalCandidates: GoalCandidate[]; goalRelevance: GoalRelevance;
} {
  const result = (status: GoalRelevance['status'], goalCandidates: GoalCandidate[] = [], competingGoalIds: string[] = []) => ({
    goalCandidates, goalRelevance: { policy: GOAL_RELEVANCE_POLICY, assessedAt: now, status, competingGoalIds },
  });
  // The vault reader is capped. Do not choose a winner from a possibly partial goal set.
  if (goals.length >= GOAL_CONTEXT_LIMIT) return result('incomplete_goal_context');
  const captureIds = evidenceIds(hypothesis, now);
  if (!captureIds.length) return result('insufficient_evidence');
  const rule = GOAL_CONTRIBUTIONS[hypothesis.kind];
  const routine = ROUTINES.find(r => r.kind === hypothesis.kind);
  if (!rule || !routine) return result('no_supported_goal');
  const byId = new Map(goals.map(g => [g.id, g]));
  const matches = goals.flatMap(goal => {
    const path = objectivePath(goal, byId, now);
    if (!path) return [];
    // Explicit success criteria take precedence: title matches cannot contradict the required outcome.
    const field = goal.success_criteria.trim() ? 'success_criteria' as const : 'title' as const;
    const outcome = goal[field].trim();
    if (!rule.outcome.test(outcome)) return [];
    return [{ goal, path, field, outcome, strength: field === 'success_criteria' ? 2 : 1 }];
  });
  // Within one path, prefer its specific supported step to a generic ancestor.
  const leaves = matches.filter(m => !matches.some(other => other.goal.id !== m.goal.id
    && other.path.some(parent => parent.id === m.goal.id)));
  const strength = Math.max(0, ...leaves.map(m => m.strength));
  const best = leaves.filter(m => m.strength === strength).sort((a, b) => a.goal.id.localeCompare(b.goal.id));
  if (!best.length) return result('no_supported_goal');
  if (best.length > 1) return result('competing_goals', [], best.map(m => m.goal.id));
  const match = best[0]!;
  const uncertainty = 'This is a possible contribution; confirm that the observed work serves this goal. Activity does not prove progress or readiness.';
  const contribution = `${rule.contribution}; it may support “${match.outcome}”.`;
  return result('candidate', [{
    goalId: match.goal.id, title: match.goal.title, basis: 'causal_contribution_requires_confirmation',
    evidenceCaptureIds: captureIds,
    reason: `${routine.labels.source} → ${routine.labels.operation} → ${routine.labels.output}. ${contribution} ${uncertainty}`,
    grounding: {
      policy: GOAL_RELEVANCE_POLICY,
      objectiveId: match.path[0]!.id,
      path: match.path.map(g => ({ goalId: g.id, title: g.title, updatedAt: g.updated_at })),
      requiredOutcome: { goalId: match.goal.id, field: match.field, text: match.outcome },
      contribution, uncertainty,
    },
  }]);
}
