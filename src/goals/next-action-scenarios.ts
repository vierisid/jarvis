/** The founder-review scenarios for the next-action planner, as planner snapshots. */
import scenarios from './next-action-scenarios.json' with { type: 'json' };
import { DEFAULT_CAPACITY, type NextActionKind, type NextActionPlan, type PlanSnapshot, type PlanWork } from './next-action.ts';
import type { GoalHealth, GoalLevel, GoalStatus } from './types.ts';

type GoalFixture = { id: string; title: string; level?: string; status?: string; parent?: string; deps?: string[];
  deadline?: number; health?: string; sort?: number; created?: number; progress?: number; escalation?: string };
type WorkFixture = { id: string; title: string; goal?: string; status: string; mode?: string; workflow?: string; run?: string;
  blocker?: [string, string]; check?: [string, string, number]; created?: number };
type Expectation = { outcome: NextActionPlan['outcome']; kind?: NextActionKind; workItemId?: string; goalId?: string; about?: string[] };
export type NextActionScenario = {
  id: string; situation: string; why: string;
  goals: GoalFixture[]; work?: WorkFixture[]; commitments?: { id: string; what: string; status?: string }[];
  workflows?: Record<string, { ready: boolean; reason?: string }>; capacity?: number;
  expect: Expectation; never?: { kind: NextActionKind; workItemId?: string; goalId?: string }[];
};

export const SCENARIO_SET = scenarios as { version: number; status: string; statusNote: string; now: string; scenarios: NextActionScenario[] };
export const SCENARIO_NOW = Date.parse(SCENARIO_SET.now);
const at = (days: number) => SCENARIO_NOW + days * 86_400_000;

export function scenarioSnapshot(scenario: NextActionScenario): PlanSnapshot {
  return {
    now: SCENARIO_NOW,
    goals: scenario.goals.map((g, index) => ({
      id: g.id, parentId: g.parent ?? null, level: (g.level ?? 'task') as GoalLevel, title: g.title,
      status: (g.status ?? 'active') as GoalStatus, health: (g.health ?? 'on_track') as GoalHealth,
      deadline: g.deadline === undefined ? null : at(g.deadline), dependencies: g.deps ?? [],
      escalation: (g.escalation ?? 'none') as PlanSnapshot['goals'][number]['escalation'], sortOrder: g.sort ?? 0,
      createdAt: at(g.created ?? -3) + index, updatedAt: at(g.created ?? -3) + index,
      lastProgressAt: g.progress === undefined ? null : at(g.progress),
    })),
    work: (scenario.work ?? []).map((w, index) => {
      const [flowId, versionId] = (w.workflow ?? ':').split(':');
      return {
        id: w.id, title: w.title, goalId: w.goal ?? null, status: w.status as PlanWork['status'],
        mode: (w.mode ?? 'manual') as PlanWork['mode'], workflow: w.workflow ? { flowId: flowId!, versionId: versionId! } : null,
        blocker: w.blocker ? { kind: w.blocker[0] as NonNullable<PlanWork['blocker']>['kind'], reason: w.blocker[1] } : null,
        runId: w.run ?? null,
        check: w.check ? { id: `check-${w.id}`, verdict: w.check[0] as 'passed' | 'failed', summary: w.check[1], checkedAt: at(w.check[2]) } : null,
        createdAt: at(w.created ?? -1) + index, updatedAt: w.check ? at(w.check[2]) : at(w.created ?? -1) + index,
      };
    }),
    commitments: (scenario.commitments ?? []).map((c, index) => ({ id: c.id, what: c.what,
      status: (c.status ?? 'pending') as PlanSnapshot['commitments'][number]['status'], whenDue: null, createdAt: at(-1) + index })),
    workflows: Object.fromEntries(Object.entries(scenario.workflows ?? {}).map(([key, value]) => [key, { ready: value.ready, reason: value.reason ?? null }])),
    capacity: scenario.capacity ?? DEFAULT_CAPACITY,
  };
}

/** Where the plan departs from the scenario's expectation, in words; empty when it holds. */
export function scenarioMisses(scenario: NextActionScenario, plan: NextActionPlan): string[] {
  const misses: string[] = [];
  const { expect } = scenario;
  if (plan.outcome !== expect.outcome) misses.push(`expected ${expect.outcome}, got ${plan.outcome}`);
  if (plan.outcome === 'recommend') {
    const action = plan.action;
    if (expect.kind && action.kind !== expect.kind) misses.push(`expected ${expect.kind}, got ${action.kind}`);
    if (expect.workItemId && action.workItemId !== expect.workItemId) misses.push(`expected work ${expect.workItemId}, got ${action.workItemId}`);
    if (expect.goalId && action.goal?.goalId !== expect.goalId) misses.push(`expected goal ${expect.goalId}, got ${action.goal?.goalId ?? 'none'}`);
    for (const never of scenario.never ?? []) {
      if (action.kind === never.kind && (!never.workItemId || action.workItemId === never.workItemId)
        && (!never.goalId || action.goal?.goalId === never.goalId)) misses.push(`recommended ${never.kind} it must not`);
    }
  }
  if (plan.outcome === 'ask' && expect.about) {
    const about = plan.about.map(a => a.goal?.goalId).sort();
    if (JSON.stringify(about) !== JSON.stringify([...expect.about].sort())) misses.push(`expected a question about ${expect.about.join(', ')}, got ${about.join(', ')}`);
  }
  return misses;
}
