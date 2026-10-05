/**
 * Q-18: recommend the next action worth taking, or say why there is none.
 *
 * What's next? must pick useful work the user can do now, not plausible
 * advice. The planner reads one snapshot (`observeNextAction`) and decides with
 * a pure function (`planNextAction`). It gathers candidate actions from goals,
 * work items and commitments, drops what is done, duplicated or blocked,
 * compares the rest with doing nothing new, and returns one recommendation, a
 * question or an abstention. Each carries evidence, an expiry and a fingerprint
 * of its inputs. It makes no model call and writes nothing: F-13 stores an
 * accepted recommendation and queues its work. The ranking is a stated
 * preference order, not a measured optimum. Contract: docs/next-action-planning.md.
 */
import type { BriefEvidenceRef, BriefRevision } from '../brief/contracts.ts';
import type { EscalationStage, GoalHealth, GoalLevel, GoalStatus } from './types.ts';
import type { WorkBlockerKind, WorkItem, WorkMode } from './work-items.ts';
import type { CommitmentStatus } from '../vault/commitments.ts';
import { getDb } from '../vault/schema.ts';
import { findGoals } from '../vault/goals.ts';
import { findCommitments } from '../vault/commitments.ts';
import { getWorkItem } from './work-items.ts';
import { versionReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { digest } from '../workflows/runtime/effect-context.ts';

export const PLANNER = 'next-action-v1';

/** The parts of a goal the planner reads. `updatedAt` is the revision F-01 exposes. */
export interface PlanGoal {
  id: string; parentId: string | null; level: GoalLevel; title: string;
  status: GoalStatus; health: GoalHealth; deadline: number | null;
  dependencies: string[]; escalation: EscalationStage; sortOrder: number;
  createdAt: number; updatedAt: number;
  /** The latest progress entry, if any. */
  lastProgressAt: number | null;
}
export interface PlanWork {
  id: string; title: string; goalId: string | null; status: WorkItem['status']; mode: WorkMode;
  workflow: { flowId: string; versionId: string } | null;
  blocker: { kind: WorkBlockerKind; reason: string } | null;
  runId: string | null;
  check: { id: string; verdict: 'passed' | 'failed'; summary: string; checkedAt: number } | null;
  createdAt: number; updatedAt: number;
}
/** An open commitment that is not a work item. */
export interface PlanCommitment { id: string; what: string; status: CommitmentStatus; whenDue: number | null; createdAt: number }
export interface PlanSnapshot {
  now: number;
  /** Every goal, so dependencies and parents resolve. */
  goals: PlanGoal[];
  /** Open work, and work checked or closed recently. */
  work: PlanWork[];
  commitments: PlanCommitment[];
  /** Whether each workflow version that open work uses can run now, keyed `flowId:versionId`. */
  workflows: Record<string, { ready: boolean; reason: string | null }>;
  /** Open items a day holds before more work is noise. */
  capacity: number;
}

export type NextActionKind = 'check_result' | 'resolve_blocker' | 'restore_capability' | 'decide_work'
  | 'continue_work' | 'start_step' | 'review_goal';

export interface NextAction {
  kind: NextActionKind;
  /** What to do, built from the user's own titles; nothing is invented. */
  title: string;
  /** The goal it serves, the revision F-13 stores, and its titles from the top goal down. */
  goal: { goalId: string; revision: BriefRevision; path: string[] } | null;
  /** The existing work item F-13 links on acceptance; null when F-13 creates one. */
  workItemId: string | null;
  /** Why this, in a few short sentences, including why it beats doing nothing new and the runner-up. */
  rationale: string[];
  evidence: BriefEvidenceRef[];
  /** Whether acting adds open work, closes some, or neither. */
  load: 'adds' | 'reduces' | 'none';
}

export interface ConsideredAction {
  kind: NextActionKind | 'no_action';
  title: string;
  outcome: 'chosen' | 'ranked_lower' | 'excluded';
  why: string;
}

export type NextActionPlan = {
  planner: typeof PLANNER;
  generatedAt: number;
  /** After this, ask again: the inputs may have moved on. */
  expiresAt: number;
  /** Digest of every input except the clock. A different basis means the plan is stale. */
  basis: string;
  workload: { open: number; capacity: number };
  /** Every alternative weighed, including doing nothing new, and why each lost or was excluded. */
  considered: ConsideredAction[];
} & (
  | { outcome: 'recommend'; action: NextAction }
  | { outcome: 'ask'; question: string; about: NextAction[] }
  | { outcome: 'none'; reason: string; evidence: BriefEvidenceRef[] }
);

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** A recommendation answers for a working day; changed inputs make it stale sooner (see `basis`). */
export const PLAN_TTL = 12 * HOUR;
/** An active goal with no progress or work for this long needs a decision, not another task. */
export const STALE_AFTER = 14 * DAY;
/** Work checked done this recently means the goal needs updating, not the step repeating. */
export const RECENTLY_CHECKED = 7 * DAY;
/** Open items before more work is noise, unless the caller passes the user's own limit. */
export const DEFAULT_CAPACITY = 5;
const CONSIDERED_LIMIT = 20;

/** The preference order, most preferable first: finish and unblock before starting. */
const TIERS: Record<NextActionKind, number> = {
  check_result: 0, resolve_blocker: 1, restore_capability: 2, decide_work: 3, continue_work: 4, start_step: 5, review_goal: 6,
};
const WHY_TIER: Record<NextActionKind, string> = {
  check_result: 'Its run finished, and only you can confirm the result; until then it counts for nothing.',
  resolve_blocker: 'Accepted work is stuck on this, and you are the one who can clear it.',
  restore_capability: 'Accepted work cannot run until this is fixed.',
  decide_work: 'A proposal is waiting for your decision.',
  continue_work: 'You already accepted this work, and nothing blocks it.',
  start_step: 'It is the next concrete step of an active goal, and nothing blocks it.',
  review_goal: 'The goal needs a decision before more work goes into it.',
};
/** What each tier is about, for saying why one option ranked below another. */
const TIER_LABEL: Record<NextActionKind, string> = {
  check_result: 'checking finished work', resolve_blocker: 'unblocking accepted work',
  restore_capability: 'restoring what accepted work needs', decide_work: 'deciding pending proposals',
  continue_work: 'continuing accepted work', start_step: 'starting a new step', review_goal: 'reviewing a goal',
};
const HEALTH_RANK: Record<GoalHealth, number> = { critical: 0, behind: 1, at_risk: 2, on_track: 3 };
const OPEN_WORK: ReadonlySet<PlanWork['status']> = new Set(['proposed', 'ready', 'running', 'blocked', 'needs_check']);
/** Open until someone settles it: a failed run with no checked outcome is still yours to resolve. */
const isOpen = (w: PlanWork) => OPEN_WORK.has(w.status) || (w.status === 'failed' && !w.check);
const CONCRETE: ReadonlySet<GoalLevel> = new Set(['task', 'daily_action']);

type Candidate = NextAction & { tier: number; urgency: Array<number | string>; question: string | null };

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const quote = (title: string) => `"${title.length > 120 ? `${title.slice(0, 117)}...` : title}"`;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const compare = (a: Array<number | string>, b: Array<number | string>) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** Decide with no clock but the snapshot's, no reads and no writes. */
export function planNextAction(snapshot: PlanSnapshot): NextActionPlan {
  const { now } = snapshot;
  const goals = new Map(snapshot.goals.map(g => [g.id, g]));
  const considered: ConsideredAction[] = [];
  const exclude = (kind: NextActionKind, title: string, why: string) => considered.push({ kind, title, outcome: 'excluded', why });

  const path = (goal: PlanGoal) => {
    const titles: string[] = [];
    for (let g: PlanGoal | undefined = goal, depth = 0; g && depth < 16; g = g.parentId ? goals.get(g.parentId) : undefined, depth++) titles.unshift(g.title);
    return titles;
  };
  /** Why a goal's work cannot go ahead: an inactive goal or parent, or an unfinished dependency. */
  const holdup = (goal: PlanGoal): string | null => {
    for (let g: PlanGoal | undefined = goal, depth = 0; g && depth < 16; g = g.parentId ? goals.get(g.parentId) : undefined, depth++) {
      if (g.status !== 'active') return g === goal ? `the goal is ${g.status}` : `its parent ${quote(g.title)} is ${g.status}`;
    }
    for (const id of goal.dependencies) {
      const dependency = goals.get(id);
      if (!dependency) return `it depends on a goal that no longer exists`;
      if (dependency.status !== 'completed') return `it waits on ${quote(dependency.title)}, which is ${dependency.status}`;
    }
    return null;
  };
  const top = (goal: PlanGoal) => {
    let g = goal;
    for (let depth = 0; g.parentId && goals.get(g.parentId) && depth < 16; depth++) g = goals.get(g.parentId)!;
    return g;
  };
  /** Sooner deadlines, worse health and the user's own goal order come first. */
  const urgency = (goal: PlanGoal | null, at: number): Array<number | string> => goal
    ? [goal.deadline ?? Number.MAX_SAFE_INTEGER, HEALTH_RANK[goal.health], top(goal).sortOrder, goal.sortOrder, at]
    : [Number.MAX_SAFE_INTEGER, 4, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, at];
  const goalRef = (goal: PlanGoal) => ({ goalId: goal.id, revision: String(goal.updatedAt), path: path(goal) });
  const goalEvidence = (goal: PlanGoal): BriefEvidenceRef => ({ kind: 'goal', id: goal.id, revision: String(goal.updatedAt) });
  const workEvidence = (work: PlanWork): BriefEvidenceRef[] => [
    { kind: 'work_item', id: work.id, revision: String(work.updatedAt) },
    ...(work.runId ? [{ kind: 'run' as const, id: work.runId, revision: null }] : []),
    ...(work.check ? [{ kind: 'receipt' as const, id: work.check.id, revision: null }] : []),
  ];

  const candidates: Candidate[] = [];
  const add = (kind: NextActionKind, title: string, goal: PlanGoal | null, work: PlanWork | null,
    reasons: string[], evidence: BriefEvidenceRef[], load: NextAction['load'], question: string | null = null) => {
    candidates.push({ kind, title, goal: goal ? goalRef(goal) : null, workItemId: work?.id ?? null,
      rationale: [WHY_TIER[kind], ...reasons, ...(goal ? [`Serves: ${path(goal).join(' > ')}.`] : [])],
      evidence: [...(goal ? [goalEvidence(goal)] : []), ...evidence], load,
      tier: TIERS[kind], urgency: urgency(goal, work?.createdAt ?? goal?.createdAt ?? 0), question });
  };

  // Existing work: close loops, unblock, decide and continue before anything new.
  const open = snapshot.work.filter(isOpen);
  for (const work of open) {
    const goal = work.goalId ? goals.get(work.goalId) ?? null : null;
    const evidence = workEvidence(work);
    if (work.status === 'running') continue;
    if (work.status === 'needs_check') { add('check_result', `Check the result of ${quote(work.title)}`, goal, work, [], evidence, 'reduces'); continue; }
    if (work.status === 'blocked' || work.status === 'failed') {
      const reason = work.blocker?.reason ?? 'no reason recorded';
      const title = work.blocker?.kind === 'waitpoint' ? `Answer what ${quote(work.title)} is waiting for`
        : work.blocker?.kind === 'missing_run' ? `Re-link or close ${quote(work.title)}: its run is missing`
        : work.blocker?.kind === 'run_failure' ? `Find out why ${quote(work.title)} failed and record the outcome`
        : `Clear the blocker on ${quote(work.title)}`;
      add('resolve_blocker', title, goal, work, [`Blocked: ${reason}.`], evidence, 'reduces');
      continue;
    }
    if (work.status === 'proposed') { add('decide_work', `Decide whether to do ${quote(work.title)}`, goal, work, [], evidence, 'reduces'); continue; }
    // Accepted and unstarted.
    const held = goal ? holdup(goal) : null;
    if (held) { exclude('continue_work', work.title, `Not now: ${held}.`); continue; }
    if (work.mode === 'workflow' && work.workflow) {
      const state = snapshot.workflows[`${work.workflow.flowId}:${work.workflow.versionId}`];
      if (!state) { exclude('continue_work', work.title, 'Its workflow could not be checked.'); continue; }
      if (!state.ready) {
        add('restore_capability', `Fix what ${quote(work.title)} needs to run`, goal, work,
          [`Its workflow is not ready: ${state.reason ?? 'unknown reason'}.`], evidence, 'none');
        continue;
      }
      add('continue_work', `Run ${quote(work.title)}`, goal, work, [], evidence, 'reduces');
      continue;
    }
    add('continue_work', `Do ${quote(work.title)}`, goal, work, [], evidence, 'reduces');
  }

  // Goals: the next concrete step of each active goal that has no open work.
  const busy = new Set(open.map(w => w.goalId).filter((id): id is string => !!id));
  const committed = [...snapshot.commitments.filter(c => c.status === 'pending' || c.status === 'active').map(c => c.what),
    ...open.map(w => w.title)].map(text => ({ text, key: normalize(text) }));
  for (const goal of snapshot.goals) {
    if (goal.status !== 'active') continue;
    const children = snapshot.goals.filter(g => g.parentId === goal.id);
    if (children.some(g => g.status === 'active')) continue; // its active children carry the work
    if (busy.has(goal.id)) continue; // existing work on it is ranked above
    const held = holdup(goal);
    if (held) { exclude('start_step', goal.title, `Not now: ${held}.`); continue; }
    if (children.length) {
      // Every step is settled or parked, yet the goal is open: it needs a decision, not a new task.
      const done = children.every(g => g.status === 'completed');
      add('review_goal', done ? `Record whether ${quote(goal.title)} is done` : `Decide how to continue ${quote(goal.title)}`, goal, null,
        [done ? `All ${children.length} of its steps are complete.`
          : `None of its steps is active: ${[...new Set(children.map(g => g.status))].join(', ')}.`],
        children.slice(0, 5).map(goalEvidence), 'none');
      continue;
    }
    const duplicate = committed.find(c => c.key === normalize(goal.title));
    if (duplicate) { exclude('start_step', goal.title, `Already committed as ${quote(duplicate.text)}.`); continue; }
    const finished = snapshot.work.filter(w => w.goalId === goal.id && w.check && now - w.check.checkedAt <= RECENTLY_CHECKED)
      .sort((a, b) => b.check!.checkedAt - a.check!.checkedAt);
    const latest = finished[0];
    const lastActivity = Math.max(goal.lastProgressAt ?? 0, goal.createdAt,
      ...snapshot.work.filter(w => w.goalId === goal.id).map(w => w.updatedAt));
    if (latest?.check?.verdict === 'passed') {
      add('review_goal', `Record whether ${quote(goal.title)} is done`, goal, null,
        [`Its work ${quote(latest.title)} was checked done on ${day(latest.check.checkedAt)}, and the goal is still open.`],
        workEvidence(latest), 'none');
      continue;
    }
    if (goal.escalation === 'suggest_kill' || now - lastActivity > STALE_AFTER) {
      add('review_goal', `Decide whether ${quote(goal.title)} is still worth pursuing`, goal, null,
        [goal.escalation === 'suggest_kill' ? 'Escalation already suggests stopping it.' : `Nothing has moved on it since ${day(lastActivity)}.`],
        [], 'none');
      continue;
    }
    if (latest?.check?.verdict === 'failed') {
      add('start_step', `Retry ${quote(goal.title)} or change the approach`, goal, null,
        [`The last attempt, ${quote(latest.title)}, failed its check: ${latest.check.summary}.`], workEvidence(latest), 'adds',
        `The last attempt at ${quote(goal.title)} failed its check (${latest.check.summary}). Try again as it was, or change the approach first?`);
      continue;
    }
    if (!CONCRETE.has(goal.level)) {
      add('start_step', `Choose the first concrete step toward ${quote(goal.title)}`, goal, null,
        ['It has no concrete task yet, and inventing one would be a guess.'], [], 'adds',
        `What is the first concrete step toward ${quote(goal.title)}?`);
      continue;
    }
    add('start_step', `Start ${quote(goal.title)}`, goal, null,
      goal.deadline ? [`Due ${day(goal.deadline)}${goal.deadline < now ? ', already overdue' : ''}.`] : [], [], 'adds');
  }

  candidates.sort((a, b) => a.tier - b.tier || compare(a.urgency, b.urgency) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const openCount = open.length + snapshot.commitments.filter(c => c.status === 'pending' || c.status === 'active').length;
  const full = openCount >= snapshot.capacity;
  const best = candidates[0];
  const runnerUp = candidates[1];
  const basis = digest({ planner: PLANNER, snapshot: { ...snapshot, now: undefined } });
  const deadline = best?.goal ? goals.get(best.goal.goalId)?.deadline : null;
  const expiresAt = Math.min(now + PLAN_TTL, ...(deadline && deadline > now ? [deadline] : []));
  const base = { planner: PLANNER, generatedAt: now, expiresAt, basis, workload: { open: openCount, capacity: snapshot.capacity } } as const;
  const finish = (plan: NextActionPlan): NextActionPlan => ({ ...plan, considered: [...plan.considered, ...considered].slice(0, CONSIDERED_LIMIT) });
  const strip = ({ tier: _t, urgency: _u, question: _q, ...action }: Candidate): NextAction => action;
  const ranked = (chosen: Candidate, skip: readonly Candidate[] = [chosen]) => candidates.filter(c => !skip.includes(c)).map(c => ({
    kind: c.kind, title: c.title, outcome: 'ranked_lower' as const,
    why: c.tier > chosen.tier ? `Ranked below: ${TIER_LABEL[chosen.kind]} comes before ${TIER_LABEL[c.kind]}.`
      : 'Ranked below on deadline, goal health or your goal order.' }));

  if (!best) {
    return finish({ ...base, outcome: 'none',
      reason: open.length ? 'Nothing is waiting on you: open work is running, and no active goal has an unblocked next step.'
        : 'Nothing is waiting on you: no active goal has an unblocked next step.',
      evidence: snapshot.goals.filter(g => g.status === 'active').slice(0, 5).map(goalEvidence),
      considered: [{ kind: 'no_action', title: 'Do nothing new', outcome: 'chosen', why: 'No achievable action was found.' }] });
  }
  if (full && best.load === 'adds') {
    return finish({ ...base, outcome: 'none',
      reason: `${openCount} items are already open, at your limit of ${snapshot.capacity}. Finish or check some before adding more.`,
      evidence: open.slice(0, 5).flatMap(w => workEvidence(w).slice(0, 1)),
      considered: [{ kind: 'no_action', title: 'Do nothing new', outcome: 'chosen', why: 'The queue is full and every option adds work.' },
        ...candidates.map(c => ({ kind: c.kind, title: c.title, outcome: 'ranked_lower' as const, why: 'It would add work to a full queue.' }))] });
  }
  // Two new steps for different goals with nothing to tell them apart: the user decides.
  const tied = best.kind === 'start_step' && runnerUp?.kind === 'start_step' && best.goal && runnerUp.goal
    && best.goal.goalId !== runnerUp.goal.goalId && compare(best.urgency.slice(0, 4), runnerUp.urgency.slice(0, 4)) === 0;
  if (best.question || tied) {
    const about = tied ? [best, runnerUp!] : [best];
    return finish({ ...base, outcome: 'ask',
      question: tied ? `Which should come first: ${quote(best.goal!.path.at(-1)!)} or ${quote(runnerUp!.goal!.path.at(-1)!)}? Nothing in their deadlines, health or order separates them.`
        : best.question!,
      about: about.map(strip),
      considered: [...about.map(c => ({ kind: c.kind, title: c.title, outcome: 'chosen' as const, why: 'It needs your answer before it can be recommended.' })),
        { kind: 'no_action', title: 'Do nothing new', outcome: 'ranked_lower', why: 'An answer unblocks a useful next step.' }, ...ranked(best, about)] });
  }
  const action = strip(best);
  action.rationale = [...action.rationale,
    best.load === 'reduces' ? 'Better than doing nothing new: it closes or moves open work.'
      : best.load === 'adds' ? `Better than doing nothing new: ${openCount} of ${snapshot.capacity} open items leaves room.`
      : 'Better than doing nothing new: it settles what further work is worth doing.',
    ...(runnerUp ? [`Ahead of the next option (${runnerUp.title}): ${runnerUp.tier > best.tier
      ? `${TIER_LABEL[best.kind]} comes before ${TIER_LABEL[runnerUp.kind]}` : 'sooner deadline, worse health or earlier in your goal order'}.`] : [])];
  return finish({ ...base, outcome: 'recommend', action,
    considered: [{ kind: best.kind, title: best.title, outcome: 'chosen', why: WHY_TIER[best.kind] },
      { kind: 'no_action', title: 'Do nothing new', outcome: 'ranked_lower', why: action.rationale.at(runnerUp ? -2 : -1)! },
      ...ranked(best)] });
}

/** Read the live state the planner judges. Reads only; work and commitments are bounded to what is open or recent. */
export function observeNextAction(options: { now?: number; capacity?: number } = {}): PlanSnapshot {
  const now = options.now ?? Date.now();
  const progress = new Map(getDb().query<{ goal_id: string; at: number }, []>(
    'SELECT goal_id, MAX(created_at) AS at FROM goal_progress GROUP BY goal_id').all().map(r => [r.goal_id, r.at]));
  const goals: PlanGoal[] = findGoals({ limit: 1000 }).map(g => ({
    id: g.id, parentId: g.parent_id, level: g.level, title: g.title, status: g.status, health: g.health,
    deadline: g.deadline, dependencies: g.dependencies, escalation: g.escalation_stage, sortOrder: g.sort_order,
    createdAt: g.created_at, updatedAt: g.updated_at, lastProgressAt: progress.get(g.id) ?? null,
  }));
  const workIds = getDb().query<{ work_id: string }, [number]>(
    `SELECT w.work_id FROM commitment_work w JOIN commitments c ON c.id = w.work_id
     WHERE c.status IN ('pending', 'active') OR c.completed_at >= ? ORDER BY c.created_at, w.work_id LIMIT 500`,
  ).all(now - RECENTLY_CHECKED).map(r => r.work_id);
  const work: PlanWork[] = workIds.map(id => getWorkItem(id)).map(w => ({
    id: w.id, title: w.title, goalId: w.goalId, status: w.status, mode: w.mode,
    workflow: w.workflowId && w.workflowVersionId ? { flowId: w.workflowId, versionId: w.workflowVersionId } : null,
    blocker: w.blocker ? { kind: w.blocker.kind, reason: w.blocker.reason } : null, runId: w.runId,
    check: w.resultCheck ? { id: w.resultCheck.id, verdict: w.resultCheck.verdict, summary: w.resultCheck.summary, checkedAt: w.resultCheck.checkedAt } : null,
    createdAt: w.createdAt, updatedAt: w.updatedAt,
  }));
  const isWork = new Set(getDb().query<{ work_id: string }, []>('SELECT work_id FROM commitment_work').all().map(r => r.work_id));
  const commitments: PlanCommitment[] = [...findCommitments({ status: 'pending' }), ...findCommitments({ status: 'active' })]
    .filter(c => !isWork.has(c.id))
    .map(c => ({ id: c.id, what: c.what, status: c.status, whenDue: c.when_due, createdAt: c.created_at }));
  const workflows: PlanSnapshot['workflows'] = {};
  for (const w of work) {
    if (!w.workflow || !isOpen(w)) continue;
    const key = `${w.workflow.flowId}:${w.workflow.versionId}`;
    if (workflows[key]) continue;
    try {
      const readiness = versionReadiness(w.workflow.flowId, w.workflow.versionId);
      workflows[key] = { ready: readiness.ready, reason: readiness.issues[0] ? `${readiness.issues[0].node}: ${readiness.issues[0].message}` : null };
    } catch (error) {
      workflows[key] = { ready: false, reason: (error as Error).message };
    }
  }
  return { now, goals, work, commitments, workflows, capacity: options.capacity ?? DEFAULT_CAPACITY };
}

export function nextAction(options: { now?: number; capacity?: number } = {}): NextActionPlan {
  return planNextAction(observeNextAction(options));
}
