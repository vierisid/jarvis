/** The founder-review scenarios for the next-action planner, as planner snapshots. */
import scenarios from './next-action-scenarios.json' with { type: 'json' };
import rubric from './next-action-rubric.json' with { type: 'json' };
import { digest } from '../workflows/runtime/effect-context.ts';
import { DEFAULT_CAPACITY, DONE_WINDOW, type NextActionKind, type NextActionPlan, type PlanResult, type PlanSnapshot, type PlanWork } from './next-action.ts';
import type { GoalHealth, GoalLevel, GoalStatus } from './types.ts';
import type { CommitmentStatus } from '../vault/commitments.ts';

type GoalFixture = { id: string; title: string; level?: string; status?: string; parent?: string; deps?: string[];
  deadline?: number; health?: string; sort?: number; score?: number; created?: number; activated?: number; progress?: number; escalation?: string };
type WorkFixture = { id: string; title: string; goal?: string; status: string; mode?: string; workflow?: string; run?: string;
  blocker?: [string, string] | [string, string, string]; check?: [string, string, number]; closed?: [string, number]; created?: number };
type Expectation = { outcome: NextActionPlan['outcome']; kind?: NextActionKind; workItemId?: string; goalId?: string; about?: string[] };
export type NextActionScenario = {
  id: string; situation: string; why: string;
  goals: GoalFixture[]; work?: WorkFixture[]; commitments?: { id: string; what: string; status?: string; due?: number }[];
  done?: [string, number][];
  workflows?: Record<string, { ready: boolean; reason?: string }>; capacity?: number;
  expect: Expectation; never?: { kind: NextActionKind; workItemId?: string; goalId?: string }[];
};

export const SCENARIO_SET = scenarios as {
  version: number; status: string; statusNote: string; now: string; scenarios: NextActionScenario[];
  /** Who approved the set and rubric, when, and the digest of what they approved. */
  approved: { by: string; on: string; digest: string };
};
export const RUBRIC = rubric;
/** What the founder approved: every scenario, and the rubric's criteria and pass rule. A change needs approval again. */
export const approvalDigest = () => digest({ scenarios: SCENARIO_SET.scenarios, criteria: RUBRIC.criteria, pass: RUBRIC.pass });
export const SCENARIO_NOW = Date.parse(SCENARIO_SET.now);
const DAY = 86_400_000;
const at = (days: number) => SCENARIO_NOW + Math.round(days * DAY);
/** The scenarios' day is the UTC day of SCENARIO_NOW. */
const DAY_START = Math.floor(SCENARIO_NOW / DAY) * DAY;

export function scenarioSnapshot(scenario: NextActionScenario): PlanSnapshot {
  const fixtures = scenario.work ?? [];
  // Settled work becomes its goal's latest result, as the observer reads it; closing a proposal as failed only dismisses it.
  const results = new Map<string, PlanResult>();
  for (const w of fixtures) {
    if (!w.goal || (!w.check && !w.closed) || (!w.check && w.closed![0] === 'failed' && w.status === 'proposed')) continue;
    const result: PlanResult = w.check
      ? { workId: w.id, title: w.title, verdict: w.check[0] as PlanResult['verdict'], checkId: `check-${w.id}`, summary: w.check[1], at: at(w.check[2]) }
      : { workId: w.id, title: w.title, verdict: w.closed![0] === 'completed' ? 'passed' : 'failed', checkId: null, summary: null, at: at(w.closed![1]) };
    if ((results.get(w.goal)?.at ?? -Infinity) < result.at) results.set(w.goal, result);
  }
  const work: PlanWork[] = fixtures.map((w, index) => {
    const [flowId, versionId] = (w.workflow ?? ':').split(':');
    const createdAt = at(w.created ?? -0.125) + index;
    const commitmentStatus: CommitmentStatus = w.check ? (w.check[0] === 'passed' ? 'completed' : 'failed')
      : (w.closed?.[0] ?? 'pending') as CommitmentStatus;
    return {
      id: w.id, title: w.title, goalId: w.goal ?? null, status: w.status as PlanWork['status'],
      mode: (w.mode ?? 'manual') as PlanWork['mode'], workflow: w.workflow ? { flowId: flowId!, versionId: versionId! } : null,
      blocker: w.blocker ? { kind: w.blocker[0] as NonNullable<PlanWork['blocker']>['kind'], reason: w.blocker[1],
        waitsFor: w.blocker[0] === 'waitpoint' ? (w.blocker[2] ?? 'you') as 'you' | 'timer' | 'outside' : null } : null,
      runId: w.run ?? null,
      check: w.check ? { id: `check-${w.id}`, verdict: w.check[0] as 'passed' | 'failed', summary: w.check[1], checkedAt: at(w.check[2]) } : null,
      commitmentStatus, createdAt,
      activityAt: Math.max(createdAt, w.check ? at(w.check[2]) : 0, w.closed ? at(w.closed[1]) : 0),
    };
  });
  const finished = [
    ...(scenario.done ?? []).map(([title, days]) => ({ title, at: at(days) })),
    ...fixtures.flatMap(w => w.check?.[0] === 'passed' ? [{ title: w.title, at: at(w.check[2]) }]
      : w.closed?.[0] === 'completed' ? [{ title: w.title, at: at(w.closed[1]) }] : []),
  ].filter(d => d.at >= SCENARIO_NOW - DONE_WINDOW).sort((a, b) => b.at - a.at);
  return {
    now: SCENARIO_NOW, timeZone: 'UTC', dayStart: DAY_START, dayEnd: DAY_START + DAY,
    goals: scenario.goals.map((g, index) => ({
      id: g.id, parentId: g.parent ?? null, level: (g.level ?? 'task') as GoalLevel, title: g.title,
      status: (g.status ?? 'active') as GoalStatus, health: (g.health ?? 'on_track') as GoalHealth,
      deadline: g.deadline === undefined ? null : at(g.deadline), dependencies: g.deps ?? [],
      escalation: (g.escalation ?? 'none') as PlanSnapshot['goals'][number]['escalation'], sortOrder: g.sort ?? 0, score: g.score ?? 0,
      createdAt: at(g.created ?? -3) + index, updatedAt: at(g.created ?? -3) + index,
      activatedAt: g.activated === undefined ? null : at(g.activated),
      lastProgressAt: g.progress === undefined ? null : at(g.progress), lastResult: results.get(g.id) ?? null,
    })),
    work,
    commitments: (scenario.commitments ?? []).map((c, index) => ({ id: c.id, what: c.what,
      status: (c.status ?? 'pending') as CommitmentStatus, whenDue: c.due === undefined ? null : at(c.due), createdAt: at(-1) + index })),
    done: finished,
    workflows: Object.fromEntries(Object.entries(scenario.workflows ?? {}).map(([key, value]) => [key, { ready: value.ready, reason: value.reason ?? null }])),
    capacity: scenario.capacity ?? DEFAULT_CAPACITY, omittedWork: 0,
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
