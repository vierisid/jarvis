import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BriefEvidenceRef } from './contracts';
import type { RecommendationPlan, RecommendedAction, RecommendationPlanner } from './recommendation-contracts';

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid planner record');
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 1000): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error('Invalid planner text');
  return v;
};
const list = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw Error('Invalid planner list');
  return v;
};
function evidence(v: unknown): BriefEvidenceRef[] {
  return list(v, 32).map(value => {
    const e = record(value);
    if (typeof e.kind !== 'string' || !['observation','fact','goal','work_item','run','receipt','source'].includes(e.kind)) throw Error('Invalid evidence kind');
    return { kind: e.kind as BriefEvidenceRef['kind'], id: text(e.id, 512), revision: e.revision === null ? null : text(e.revision, 512) };
  });
}
function action(v: unknown): RecommendedAction {
  const a = record(v);
  const kinds = ['check_result','resolve_blocker','restore_capability','decide_work','continue_work','close_goal','start_step','review_goal'];
  if (typeof a.kind !== 'string' || !kinds.includes(a.kind) || typeof a.load !== 'string' || !['adds','reduces','none'].includes(a.load)) throw Error('Invalid action');
  const g = a.goal === null ? null : record(a.goal);
  const refs = evidence(a.evidence), rationale = list(a.rationale, 12).map(v => text(v, 4000));
  if (!refs.length || !rationale.length) throw Error('Recommendation needs evidence and rationale');
  return { kind: a.kind as RecommendedAction['kind'], title: text(a.title, 10_000),
    goal: g && { goalId: text(g.goalId, 512), revision: text(g.revision, 512), path: list(g.path, 32).map(v => text(v, 10_000)) },
    workItemId: a.workItemId === null ? null : text(a.workItemId, 512), rationale, evidence: refs, load: a.load as RecommendedAction['load'] };
}
/** Copy an allowlisted, bounded result. Never store a snapshot, run or arbitrary extra fields. */
export function checkedRecommendationPlan(input: unknown, now: number): RecommendationPlan {
  const p = record(input);
  if (p.planner !== 'next-action-v1' || typeof p.basis !== 'string' || !/^[a-f0-9]{64}$/.test(p.basis) || p.generatedAt !== now ||
      !Number.isSafeInteger(p.expiresAt) || Number(p.expiresAt) <= now || Number(p.expiresAt) > now + 12 * 3_600_000) throw Error('Invalid planner basis or expiry');
  const common = { planner: 'next-action-v1' as const, generatedAt: now, expiresAt: p.expiresAt as number, basis: p.basis as string };
  let plan: RecommendationPlan;
  if (p.outcome === 'recommend') plan = { ...common, outcome: 'recommend', action: action(p.action) };
  else if (p.outcome === 'ask') plan = { ...common, outcome: 'ask', question: text(p.question, 4000), about: list(p.about, 20).map(action) };
  else if (p.outcome === 'none') plan = { ...common, outcome: 'none', reason: text(p.reason, 4000), evidence: evidence(p.evidence) };
  else throw Error('Unknown planner outcome');
  if (JSON.stringify(plan).length > 64_000) throw Error('Planner result exceeds storage bound');
  return plan;
}
/** Fixed optional Q-18 entry point. No caller-controlled path or fallback planning algorithm. */
export async function loadRecommendationPlanner(): Promise<RecommendationPlanner | null> {
  const path = new URL('../goals/next-action.ts', import.meta.url);
  if (!existsSync(fileURLToPath(path))) return null;
  try {
    const module = await import(path.href);
    if (module.PLANNER !== 'next-action-v1' || typeof module.nextAction !== 'function') return null;
    return { readiness: () => 'ready', plan: now => module.nextAction({ now }) };
  } catch { return null; }
}
