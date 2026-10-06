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
import { getGoal } from '../vault/goals.ts';
import { findCommitments } from '../vault/commitments.ts';
import { getWorkItem } from './work-items.ts';
import { getWaitpoint } from '../workflows/db/repos/waitpoint.ts';
import { getFlowVersion } from '../workflows/db/repos/flow-version.ts';
import { walkFlowNodes } from '../workflows/db/flow-graph.ts';
import { versionReadiness } from '../workflows/db/repos/flow-readiness.ts';
import { digest } from '../workflows/runtime/effect-context.ts';

export const PLANNER = 'next-action-v1';

/** The parts of a goal the planner reads. */
export interface PlanGoal {
  id: string; parentId: string | null; level: GoalLevel; title: string;
  status: GoalStatus; health: GoalHealth; deadline: number | null;
  dependencies: string[]; escalation: EscalationStage; sortOrder: number;
  /** 0 to 1; 1 means fully achieved. */
  score: number;
  createdAt: number;
  /** F-01's read revision. Any edit changes it, health and escalation updates included; it is not a concurrency token. */
  updatedAt: number;
  /** When the goal last became active: its first activation or a later resume. */
  activatedAt: number | null;
  /** The latest progress entry, if any. */
  lastProgressAt: number | null;
  /** The latest settled result of work linked to the goal, however old. */
  lastResult: PlanResult | null;
}
/** A settled work item: checked, or closed in Tasks without a check. */
export interface PlanResult {
  workId: string; title: string; verdict: 'passed' | 'failed';
  /** The check that settled it; null when it was closed in Tasks. */
  checkId: string | null; summary: string | null; at: number;
}
export interface PlanWork {
  id: string; title: string; goalId: string | null; status: WorkItem['status']; mode: WorkMode;
  workflow: { flowId: string; versionId: string } | null;
  /** Why it cannot progress. A waiting run also says who resumes it: you, its own timer, or an outside call. */
  blocker: { kind: WorkBlockerKind; reason: string; waitsFor: 'you' | 'timer' | 'outside' | null } | null;
  runId: string | null;
  check: { id: string; verdict: 'passed' | 'failed'; summary: string; checkedAt: number } | null;
  /** The commitment's own status, which Tasks and the commitments tool change directly. */
  commitmentStatus: CommitmentStatus;
  createdAt: number;
  /** The last meaningful change: creation, decision, configuration, blocker, run link, run finish or check. Run steps are not activity. */
  activityAt: number;
}
/** An open commitment that is not a work item. */
export interface PlanCommitment { id: string; what: string; status: CommitmentStatus; whenDue: number | null; createdAt: number }
export interface PlanSnapshot {
  now: number;
  /** The user's IANA time zone, for dates in messages, and the bounds of the user's day. */
  timeZone: string; dayStart: number; dayEnd: number;
  /** Every goal, so parents and dependencies resolve. */
  goals: PlanGoal[];
  /** Open work: accepted and not settled, or proposed today and not decided. */
  work: PlanWork[];
  commitments: PlanCommitment[];
  /** Commitments finished in the last 30 days, to catch a goal done without a linked work item. */
  done: Array<{ title: string; at: number }>;
  /** Whether each workflow version that open work uses can run now, keyed `flowId:versionId`. */
  workflows: Record<string, { ready: boolean; reason: string | null }>;
  /** Open items a day holds before more work is noise. */
  capacity: number;
  /** Open work items past the observer's bound; the newest are kept. */
  omittedWork: number;
}

export type NextActionKind = 'check_result' | 'resolve_blocker' | 'restore_capability' | 'decide_work'
  | 'continue_work' | 'close_goal' | 'start_step' | 'review_goal';

export interface NextAction {
  kind: NextActionKind;
  /** What to do, built from the user's own titles; nothing is invented. */
  title: string;
  /** The goal it serves, its read revision, and its titles from the top goal down. */
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
  /** Digest of every input except the clock. A different basis means a stored plan is stale. */
  basis: string;
  workload: { open: number; capacity: number };
  /** Alternatives weighed, including doing nothing new, and why each lost or was left out: at most 20. */
  considered: ConsideredAction[];
  /** What this plan did not see or list: open work past the observer's bound, alternatives past the list's. */
  omitted: { work: number; considered: number };
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
/** How far back finished commitments are read to catch a goal done without a linked work item. */
export const DONE_WINDOW = 30 * DAY;
/** Open items before more work is noise, unless the caller passes the user's own limit. */
export const DEFAULT_CAPACITY = 5;
/** The observer reads at most this many open work items, newest first, and counts the rest. */
export const WORK_LIMIT = 500;
const CONSIDERED_LIMIT = 20;
const MAX_DEPTH = 16;
const WEBHOOK_PIECE = '@activepieces/piece-webhook';

/** The preference order, most preferable first: finish, unblock and close before starting. */
const TIERS: Record<NextActionKind, number> = {
  check_result: 0, resolve_blocker: 1, restore_capability: 2, decide_work: 3, continue_work: 4,
  close_goal: 5, start_step: 6, review_goal: 7,
};
const WHY_TIER: Record<NextActionKind, string> = {
  check_result: 'Its run finished, and only you can confirm the result; until then it counts for nothing.',
  resolve_blocker: 'Accepted work is stuck on this, and you are the one who can clear it.',
  restore_capability: 'Accepted work cannot run until this is fixed.',
  decide_work: 'A proposal from today is waiting for your decision.',
  continue_work: 'You already accepted this work, and nothing blocks it.',
  close_goal: 'The goal looks done; recording that keeps your plan honest.',
  start_step: 'It is the next concrete step of an active goal, and nothing blocks it.',
  review_goal: 'The goal needs a decision before more work goes into it.',
};
/** What each tier is about, for saying why one option ranked below another. */
const TIER_LABEL: Record<NextActionKind, string> = {
  check_result: 'checking finished work', resolve_blocker: 'unblocking accepted work',
  restore_capability: 'restoring what accepted work needs', decide_work: 'deciding pending proposals',
  continue_work: 'continuing accepted work', close_goal: 'closing a goal that looks done',
  start_step: 'starting a new step', review_goal: 'reviewing a goal',
};
/** Why an option that neither adds nor closes work beats doing nothing new. */
const WHY_NONE: Partial<Record<NextActionKind, string>> = {
  restore_capability: 'it lets accepted work run', close_goal: 'it settles a goal that looks done',
  review_goal: 'it settles what further work is worth doing',
};
/** What separated two options of one kind, by the first urgency field that differs. */
const DECIDED_BY = ['has a sooner deadline', 'serves a goal in worse health', 'comes earlier in your goal order', 'is older', 'comes first alphabetically'];
const HEALTH_RANK: Record<GoalHealth, number> = { critical: 0, behind: 1, at_risk: 2, on_track: 3 };
const NO_GOAL = 4;
const OPEN_WORK: ReadonlySet<PlanWork['status']> = new Set(['proposed', 'ready', 'running', 'blocked', 'needs_check']);
const CONCRETE: ReadonlySet<GoalLevel> = new Set(['task', 'daily_action']);

type Candidate = NextAction & { tier: number; urgency: Array<number | string>; question: string | null };
/** An impossible hold needs the goal changed; a waiting one clears by itself. */
type Hold = { reason: string; impossible: boolean };
type Draft = { considered: ConsideredAction[] } & (
  | { outcome: 'recommend'; action: NextAction }
  | { outcome: 'ask'; question: string; about: NextAction[] }
  | { outcome: 'none'; reason: string; evidence: BriefEvidenceRef[] }
);

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const quote = (title: string) => `"${title.length > 120 ? `${title.slice(0, 117)}...` : title}"`;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A sortable key for a goal order, an integer from 0 to 2^53 - 1. */
const rank = (order: number) => String(Math.min(Math.max(Math.trunc(order) || 0, 0), Number.MAX_SAFE_INTEGER)).padStart(16, '0');
const compare = (a: Array<number | string>, b: Array<number | string>, length = Math.max(a.length, b.length)) => {
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const firstDifference = (a: Array<number | string>, b: Array<number | string>) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return i;
  return -1;
};
const isOpenCommitment = (c: PlanCommitment) => c.status === 'pending' || c.status === 'active' || c.status === 'escalated';
/** YYYY-MM-DD in the user's time zone; an unknown zone falls back to UTC. */
function dateFormatter(timeZone: string): (at: number) => string {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US', { ...options, timeZone }); }
  catch { format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }); }
  return at => {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/** Decide with no clock but the snapshot's, no reads and no writes. */
export function planNextAction(snapshot: PlanSnapshot): NextActionPlan {
  const { now } = snapshot;
  const goals = new Map(snapshot.goals.map(g => [g.id, g]));
  const childrenOf = new Map<string, PlanGoal[]>();
  for (const g of snapshot.goals) if (g.parentId) childrenOf.set(g.parentId, [...childrenOf.get(g.parentId) ?? [], g]);
  const exclusions: ConsideredAction[] = [];
  const exclude = (kind: NextActionKind, title: string, why: string) => { exclusions.push({ kind, title, outcome: 'excluded', why }); };
  const day = dateFormatter(snapshot.timeZone);

  /** The goal, then its parents; a missing parent or a loop ends the walk. */
  const chain = (goal: PlanGoal) => {
    const lineage: PlanGoal[] = [];
    for (let g: PlanGoal | undefined = goal; g && lineage.length < MAX_DEPTH && !lineage.includes(g); g = g.parentId ? goals.get(g.parentId) : undefined) lineage.push(g);
    return lineage;
  };
  const path = (goal: PlanGoal) => chain(goal).reverse().map(g => g.title);
  /** Whether `from`, through its own or its parents' dependencies, waits on any goal in `targets`. */
  const waitsOn = (from: PlanGoal, targets: ReadonlySet<string>) => {
    const seen = new Set<string>();
    const pending = [from];
    while (pending.length) {
      const goal = pending.pop()!;
      if (seen.has(goal.id)) continue;
      seen.add(goal.id);
      for (const g of chain(goal)) for (const id of g.dependencies) {
        if (targets.has(id)) return true;
        const next = goals.get(id);
        if (next && next.status !== 'completed') pending.push(next);
      }
    }
    return false;
  };
  const holds = new Map<string, Hold | null>();
  /** Why a goal's work cannot go ahead: it or a parent is not active, or a dependency of either is not done. */
  const holdup = (goal: PlanGoal): Hold | null => {
    if (holds.has(goal.id)) return holds.get(goal.id)!;
    const lineage = chain(goal);
    const find = (): Hold | null => {
      const inactive = lineage.find(g => g.status !== 'active');
      if (inactive) return { reason: inactive === goal ? `the goal is ${inactive.status}` : `its parent ${quote(inactive.title)} is ${inactive.status}`, impossible: false };
      const own = new Set(lineage.map(g => g.id));
      let waiting: Hold | null = null;
      for (const [index, g] of lineage.entries()) {
        const who = g === goal ? 'it' : `its parent ${quote(g.title)}`;
        for (const id of g.dependencies) {
          const dependency = goals.get(id);
          if (!dependency) return { reason: `${who} depends on a goal that no longer exists`, impossible: true };
          const position = lineage.indexOf(dependency);
          if (position >= 0 && position < index) continue; // a parent waiting on its own step does not hold that step
          if (position >= 0) return { reason: `${who} depends on ${position === index ? 'itself' : `its own parent ${quote(dependency.title)}`}`, impossible: true };
          if (dependency.status === 'completed') continue;
          if (dependency.status === 'killed' || dependency.status === 'failed') {
            return { reason: `${who} waits on ${quote(dependency.title)}, which is ${dependency.status}`, impossible: true };
          }
          if (waitsOn(dependency, own)) return { reason: `${who} and ${quote(dependency.title)} wait on each other`, impossible: true };
          waiting ??= { reason: `${who} waits on ${quote(dependency.title)}, which is ${dependency.status}`, impossible: false };
        }
      }
      return waiting;
    };
    const hold = find();
    holds.set(goal.id, hold);
    return hold;
  };
  /** The goal or parent with the soonest deadline. */
  const deadlineOf = (goal: PlanGoal) => chain(goal).reduce<PlanGoal | null>(
    (soonest, g) => g.deadline !== null && (soonest === null || g.deadline < soonest.deadline!) ? g : soonest, null);
  /** Sooner deadlines and worse health, a parent's included, then your goal order from the top goal down. */
  const urgency = (goal: PlanGoal | null, at: number, title: string): Array<number | string> => {
    if (!goal) return [Number.MAX_SAFE_INTEGER, NO_GOAL, '~', at, title];
    const lineage = chain(goal);
    return [deadlineOf(goal)?.deadline ?? Number.MAX_SAFE_INTEGER, Math.min(...lineage.map(g => HEALTH_RANK[g.health])),
      lineage.map(g => rank(g.sortOrder)).reverse().join('.'), at, title];
  };
  const goalRef = (goal: PlanGoal) => ({ goalId: goal.id, revision: String(goal.updatedAt), path: path(goal) });
  const goalEvidence = (goal: PlanGoal): BriefEvidenceRef => ({ kind: 'goal', id: goal.id, revision: String(goal.updatedAt) });
  const workEvidence = (work: PlanWork): BriefEvidenceRef[] => [
    { kind: 'work_item', id: work.id, revision: `${work.status}:${work.activityAt}` },
    ...(work.runId ? [{ kind: 'run' as const, id: work.runId, revision: null }] : []),
    ...(work.check ? [{ kind: 'receipt' as const, id: work.check.id, revision: null }] : []),
  ];
  const resultEvidence = (result: PlanResult): BriefEvidenceRef[] => [
    { kind: 'work_item', id: result.workId, revision: null },
    ...(result.checkId ? [{ kind: 'receipt' as const, id: result.checkId, revision: null }] : []),
  ];
  const commitmentEvidence = (c: PlanCommitment): BriefEvidenceRef => ({ kind: 'source', id: `commitment:${c.id}`, revision: c.status });

  const candidates: Candidate[] = [];
  const add = (kind: NextActionKind, title: string, goal: PlanGoal | null, work: PlanWork | null,
    reasons: string[], evidence: BriefEvidenceRef[], load: NextAction['load'], question: string | null = null) => {
    candidates.push({ kind, title, goal: goal ? goalRef(goal) : null, workItemId: work?.id ?? null,
      rationale: [WHY_TIER[kind], ...reasons, ...(goal ? [`Serves: ${path(goal).join(' > ')}.`] : [])],
      evidence: [...(goal ? [goalEvidence(goal)] : []), ...evidence], load,
      tier: TIERS[kind], urgency: urgency(goal, work?.createdAt ?? goal?.createdAt ?? 0, title), question });
  };

  /** Open until settled. Closed in Tasks, rejected, checked, or an undecided proposal from before today: not open. */
  const isOpen = (w: PlanWork) => {
    if (w.commitmentStatus === 'completed' || w.commitmentStatus === 'failed') return false;
    if (w.status === 'proposed') return w.createdAt >= snapshot.dayStart;
    return OPEN_WORK.has(w.status) || (w.status === 'failed' && !w.check);
  };
  /** Running, or waiting on its timer or an outside call: it counts toward the day, but nothing is yours to do. */
  const waiting = (w: PlanWork) => w.status === 'running' || (w.status === 'blocked' && w.blocker?.kind === 'waitpoint'
    && (w.blocker.waitsFor === 'timer' || w.blocker.waitsFor === 'outside'));
  const accepted = (w: PlanWork) => w.status !== 'proposed' && w.status !== 'rejected';
  const open = snapshot.work.filter(isOpen);
  const acceptedFor = new Set(open.filter(accepted).flatMap(w => w.goalId ? [w.goalId] : []));
  const proposedFor = new Set(open.filter(w => !accepted(w)).flatMap(w => w.goalId ? [w.goalId] : []));
  const workActivity = new Map<string, number>();
  for (const w of snapshot.work) if (w.goalId && accepted(w)) workActivity.set(w.goalId, Math.max(workActivity.get(w.goalId) ?? 0, w.activityAt));
  /** Activation, progress, settled results and accepted work show someone moving the goal; proposals do not. */
  const lastActivity = (goal: PlanGoal) => Math.max(goal.createdAt, goal.activatedAt ?? 0, goal.lastProgressAt ?? 0,
    goal.lastResult?.at ?? 0, workActivity.get(goal.id) ?? 0);
  const staleReason = (goal: PlanGoal) => goal.escalation === 'suggest_kill' ? 'escalation already suggests stopping it'
    : now - lastActivity(goal) > STALE_AFTER ? `nothing has moved on it since ${day(lastActivity(goal))}` : null;
  const doneTitles = new Map(snapshot.done.map(d => [normalize(d.title), d]));
  /** Why the goal looks done, unless accepted work says otherwise. A passed step finishes only a concrete goal. */
  const doneSignal = (goal: PlanGoal): { reason: string; evidence: BriefEvidenceRef[] } | null => {
    if (acceptedFor.has(goal.id)) return null;
    const children = childrenOf.get(goal.id) ?? [];
    if (children.length && children.every(g => g.status === 'completed')) {
      return { reason: `all ${children.length} of its steps are complete`, evidence: children.slice(0, 5).map(goalEvidence) };
    }
    const result = goal.lastResult;
    if (result?.verdict === 'passed' && (CONCRETE.has(goal.level) || goal.score >= 1)) {
      return { reason: `its work ${quote(result.title)} was ${result.checkId ? 'checked done' : 'marked done in Tasks'} on ${day(result.at)}`, evidence: resultEvidence(result) };
    }
    if (goal.score >= 1) return { reason: 'its score is already 1.0', evidence: [] };
    const finished = doneTitles.get(normalize(goal.title));
    return finished ? { reason: `${quote(finished.title)} was finished on ${day(finished.at)}`, evidence: [] } : null;
  };

  // Existing work: close loops, unblock, decide and continue before anything new.
  for (const work of open) {
    if (waiting(work)) continue;
    const goal = work.goalId ? goals.get(work.goalId) ?? null : null;
    const hold = goal ? holdup(goal) : null;
    const evidence = workEvidence(work);
    // Checking a result or settling a failed or missing run records what already happened, so a held goal does not stop it.
    if (work.status === 'needs_check') { add('check_result', `Check the result of ${quote(work.title)}`, goal, work, [], evidence, 'reduces'); continue; }
    if (work.status === 'blocked' || work.status === 'failed') {
      const kind = work.blocker?.kind;
      if (hold && kind !== 'run_failure' && kind !== 'missing_run') {
        exclude('resolve_blocker', work.title, `Not now: ${kind === 'waitpoint' ? 'answering resumes it, and ' : ''}${hold.reason}.`);
        continue;
      }
      const title = kind === 'waitpoint' ? `Answer what ${quote(work.title)} is waiting for`
        : kind === 'missing_run' ? `Close ${quote(work.title)} in Tasks: its run no longer exists`
        : kind === 'run_failure' ? `Find out why ${quote(work.title)} failed and record the outcome`
        : `Clear the blocker on ${quote(work.title)}`;
      add('resolve_blocker', title, goal, work, [`Blocked: ${work.blocker?.reason ?? 'no reason recorded'}.`], evidence, 'reduces');
      continue;
    }
    if (work.status === 'proposed') {
      if (hold) { exclude('decide_work', work.title, `Not now: ${hold.reason}.`); continue; }
      const done = goal ? doneSignal(goal) : null;
      if (done) { exclude('decide_work', work.title, `Its goal looks done: ${done.reason}. Record that before adding work to it.`); continue; }
      const stale = goal ? staleReason(goal) : null;
      if (stale) { exclude('decide_work', work.title, `Its goal needs a decision first: ${stale}.`); continue; }
      add('decide_work', `Decide whether to do ${quote(work.title)}`, goal, work, [], evidence, 'reduces');
      continue;
    }
    // Accepted and not started.
    if (hold) { exclude('continue_work', work.title, `Not now: ${hold.reason}.`); continue; }
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

  // Goals: close, review or take the next step of each active goal whose own steps are not active.
  const committed = [...snapshot.commitments.filter(isOpenCommitment).map(c => c.what), ...open.map(w => w.title)]
    .map(text => ({ text, key: normalize(text) }));
  for (const goal of snapshot.goals) {
    if (goal.status !== 'active') continue;
    const children = childrenOf.get(goal.id) ?? [];
    if (children.some(g => g.status === 'active')) continue; // its active steps carry the work
    const hold = holdup(goal);
    if (hold?.impossible) {
      add('review_goal', `Fix what ${quote(goal.title)} waits on`, goal, null, [`It cannot go ahead: ${hold.reason}.`], [], 'none');
      continue;
    }
    if (hold) {
      if (!acceptedFor.has(goal.id) && !proposedFor.has(goal.id)) exclude('start_step', goal.title, `Not now: ${hold.reason}.`);
      continue;
    }
    if (acceptedFor.has(goal.id)) continue; // its accepted work is ranked above
    const done = doneSignal(goal);
    if (done) {
      add('close_goal', `Record whether ${quote(goal.title)} is done`, goal, null, [`${sentence(done.reason)}, and the goal is still open.`], done.evidence, 'none');
      continue;
    }
    if (children.length) {
      // Every step is settled or parked, yet the goal is open: it needs a decision, not a new task.
      add('review_goal', `Decide how to continue ${quote(goal.title)}`, goal, null,
        [`None of its steps is active: ${[...new Set(children.map(g => g.status))].join(', ')}.`], children.slice(0, 5).map(goalEvidence), 'none');
      continue;
    }
    const stale = staleReason(goal);
    if (stale) { add('review_goal', `Decide whether ${quote(goal.title)} is still worth pursuing`, goal, null, [`${sentence(stale)}.`], [], 'none'); continue; }
    if (proposedFor.has(goal.id)) continue; // today's proposal is its next step
    const duplicate = committed.find(c => c.key === normalize(goal.title));
    if (duplicate) { exclude('start_step', goal.title, `Already committed as ${quote(duplicate.text)}.`); continue; }
    const last = goal.lastResult;
    if (!CONCRETE.has(goal.level)) {
      const which = last ? 'next' : 'first';
      add('start_step', `Choose the ${which} concrete step toward ${quote(goal.title)}`, goal, null,
        [last ? `Its last step, ${quote(last.title)}, ${last.verdict === 'passed' ? 'was done' : 'failed'} on ${day(last.at)}, and nothing is planned after it; inventing the next one would be a guess.`
          : 'It has no concrete task yet, and inventing one would be a guess.'],
        last ? resultEvidence(last) : [], 'adds', `What is the ${which} concrete step toward ${quote(goal.title)}?`);
      continue;
    }
    if (last?.verdict === 'failed') {
      const how = last.checkId ? `failed its check (${last.summary})` : `was marked failed in Tasks on ${day(last.at)}`;
      add('start_step', `Retry ${quote(goal.title)} or change the approach`, goal, null, [`The last attempt, ${quote(last.title)}, ${how}.`],
        resultEvidence(last), 'adds', `The last attempt at ${quote(goal.title)} ${how}. Try again as it was, or change the approach first?`);
      continue;
    }
    const due = deadlineOf(goal);
    add('start_step', `Start ${quote(goal.title)}`, goal, null,
      due ? [`Due ${day(due.deadline!)}${due.deadline! < now ? ', already overdue' : ''}${due === goal ? '' : `, through ${quote(due.title)}`}.`] : [],
      [], 'adds');
  }

  candidates.sort((a, b) => a.tier - b.tier || compare(a.urgency, b.urgency));
  // A day's load: open work, and plain commitments due by the end of today, overdue ones included.
  const dueToday = snapshot.commitments.filter(c => isOpenCommitment(c) && c.whenDue !== null && c.whenDue < snapshot.dayEnd);
  const openCount = open.length + dueToday.length;
  const full = openCount >= snapshot.capacity;
  // A full day takes nothing that adds work; checking, unblocking, deciding and closing still reduce or settle it.
  const pool = full ? candidates.filter(c => c.load !== 'adds') : candidates;
  const crowded = full ? candidates.filter(c => c.load === 'adds') : [];
  const [best, runnerUp] = pool;
  const due = best?.goal ? deadlineOf(goals.get(best.goal.goalId)!)?.deadline ?? null : null;
  const base = {
    planner: PLANNER, generatedAt: now,
    expiresAt: Math.min(now + PLAN_TTL, ...(due !== null && due > now ? [due] : [])),
    basis: digest({ planner: PLANNER, snapshot: { ...snapshot, now: undefined } }),
    workload: { open: openCount, capacity: snapshot.capacity },
  } as const;
  const strip = ({ tier: _t, urgency: _u, question: _q, ...action }: Candidate): NextAction => action;
  /** What put `winner` ahead: the preference order, or the first urgency field that differs. */
  const beats = (winner: Candidate, loser: Candidate, subject: string) => {
    if (loser.tier > winner.tier) return `${TIER_LABEL[winner.kind]} comes before ${TIER_LABEL[loser.kind]}`;
    const field = firstDifference(winner.urgency, loser.urgency);
    return `${subject} ${field === 1 && !loser.goal ? 'serves a goal' : DECIDED_BY[field] ?? 'comes first in your list'}`;
  };
  const ranked = (winner: Candidate, skip: readonly Candidate[]): ConsideredAction[] => pool.filter(c => !skip.includes(c))
    .map(c => ({ kind: c.kind, title: c.title, outcome: 'ranked_lower', why: `Ranked below: ${beats(winner, c, 'the chosen option')}.` }));
  const crowdedOut: ConsideredAction[] = crowded.map(c => ({ kind: c.kind, title: c.title, outcome: 'ranked_lower',
    why: `It would add work to a full day (${openCount} of ${snapshot.capacity} items open).` }));
  /** Chosen, doing nothing, exclusions, then lower ranks: a cut drops the least needed reasons first. */
  const group = (c: ConsideredAction) => c.outcome === 'chosen' ? 0 : c.kind === 'no_action' ? 1 : c.outcome === 'excluded' ? 2 : 3;
  const finish = (draft: Draft): NextActionPlan => {
    const all = [...draft.considered, ...exclusions].sort((a, b) => group(a) - group(b));
    return { ...base, ...draft, considered: all.slice(0, CONSIDERED_LIMIT),
      omitted: { work: snapshot.omittedWork, considered: Math.max(0, all.length - CONSIDERED_LIMIT) } };
  };

  if (!best) {
    const busy = open.filter(waiting).length;
    const parts = [
      ...(busy ? [`${busy} ${busy === 1 ? 'item is' : 'items are'} running or waiting on a timer or an outside call`] : []),
      ...(exclusions.length ? [`${exclusions.length} ${exclusions.length === 1 ? 'option is' : 'options are'} held back`] : []),
    ];
    return finish({ outcome: 'none',
      reason: crowded.length ? `${openCount} items are already open, at your limit of ${snapshot.capacity}. Finish or check some before adding more.`
        : `Nothing is waiting on you: ${parts.length ? parts.join(', and ') : 'no active goal has a step you can take now'}.`,
      evidence: [...open.slice(0, 5).map(w => workEvidence(w)[0]!), ...dueToday.slice(0, 5).map(commitmentEvidence),
        ...(open.length || dueToday.length ? [] : snapshot.goals.filter(g => g.status === 'active').slice(0, 5).map(goalEvidence))],
      considered: [{ kind: 'no_action', title: 'Do nothing new', outcome: 'chosen',
        why: crowded.length ? 'The day is full, and every remaining option adds work.' : 'No achievable action was found.' }, ...crowdedOut] });
  }
  // Two new steps for different goals that nothing tells apart: the user decides, and the answer can be kept as goal order.
  const tied = best.kind === 'start_step' && runnerUp?.kind === 'start_step' && !best.question && !runnerUp.question
    && compare(best.urgency, runnerUp.urgency, 3) === 0;
  if (best.question || tied) {
    const about = tied ? [best, runnerUp!] : [best];
    return finish({ outcome: 'ask',
      question: tied ? `Which should come first: ${quote(best.goal!.path.at(-1)!)} or ${quote(runnerUp!.goal!.path.at(-1)!)}? Nothing in their deadlines, health or order separates them.`
        : best.question!,
      about: about.map(strip),
      considered: [...about.map(c => ({ kind: c.kind, title: c.title, outcome: 'chosen' as const, why: 'It needs your answer before it can be recommended.' })),
        { kind: 'no_action', title: 'Do nothing new', outcome: 'ranked_lower', why: 'An answer unblocks a useful next step.' }, ...ranked(best, about), ...crowdedOut] });
  }
  const action = strip(best);
  const versusNothing = best.load === 'reduces' ? 'Better than doing nothing new: it closes or moves open work.'
    : best.load === 'adds' ? `Better than doing nothing new: the day has room (${openCount} of ${snapshot.capacity} items open).`
    : `Better than doing nothing new: ${WHY_NONE[best.kind] ?? 'it settles what further work is worth doing'}.`;
  action.rationale = [...action.rationale, versusNothing, ...(runnerUp ? [`Ahead of the next option (${runnerUp.title}): ${beats(best, runnerUp, 'it')}.`] : [])];
  return finish({ outcome: 'recommend', action,
    considered: [{ kind: best.kind, title: best.title, outcome: 'chosen', why: WHY_TIER[best.kind] },
      { kind: 'no_action', title: 'Do nothing new', outcome: 'ranked_lower', why: versusNothing }, ...ranked(best, [best]), ...crowdedOut] });
}

/**
 * Who resumes a waiting run. A delay resumes itself, and a webhook step waits
 * for an outside call. Anything else may need you, including an approval
 * link, which also resumes through a webhook.
 */
function waitsFor(work: WorkItem): 'you' | 'timer' | 'outside' {
  const waitpoint = work.blocker?.ref ? getWaitpoint(work.blocker.ref) : null;
  if (waitpoint?.type === 'TIMER') return 'timer';
  if (waitpoint?.type !== 'WEBHOOK' || !work.run) return 'you';
  const step = walkFlowNodes(getFlowVersion(work.run.flowVersionId)?.trigger).find(node => node.name === waitpoint.stepName);
  return step?.settings?.pieceName === WEBHOOK_PIECE ? 'outside' : 'you';
}

type ResultRow = { goal_id: string; work_id: string; what: string; check_id: string | null; verdict: 'passed' | 'failed'; summary: string | null; at: number };

/**
 * Read the live state the planner judges. Reads only. Goals are read whole.
 * Work is bounded to what is open (accepted and not settled, or proposed today
 * and not decided), newest first, and the rest is counted in `omittedWork`.
 */
export function observeNextAction(options: { now?: number; capacity?: number; workLimit?: number } = {}): PlanSnapshot {
  const now = options.now ?? Date.now();
  const db = getDb();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const dayStart = midnight.getTime();
  midnight.setDate(midnight.getDate() + 1);
  const dayEnd = midnight.getTime();

  const progress = new Map(db.query<{ goal_id: string; at: number }, []>(
    'SELECT goal_id, MAX(created_at) AS at FROM goal_progress GROUP BY goal_id').all().map(r => [r.goal_id, r.at]));
  // A resume leaves started_at alone. Its event is kept for 180 days, well past the 14-day stale window.
  const resumed = new Map(db.query<{ goal_id: string; at: number }, []>(
    `SELECT json_extract(event, '$.goalId') AS goal_id, MAX(created_at) AS at FROM goal_events
     WHERE json_extract(event, '$.type') = 'goal_status_changed' AND json_extract(event, '$.data.status') = 'active'
     GROUP BY goal_id`).all().map(r => [r.goal_id, r.at]));
  // The latest settled result per goal: a check, or the item closed in Tasks. Closing a proposal as failed only dismisses it.
  const results = new Map(db.query<ResultRow, []>(
    `SELECT goal_id, work_id, what, check_id, verdict, summary, at FROM (
       SELECT w.goal_id, w.work_id, c.what, json_extract(w.result_check, '$.id') AS check_id,
         COALESCE(json_extract(w.result_check, '$.verdict'), CASE c.status WHEN 'completed' THEN 'passed' ELSE 'failed' END) AS verdict,
         json_extract(w.result_check, '$.summary') AS summary,
         COALESCE(json_extract(w.result_check, '$.checkedAt'), c.completed_at, c.created_at) AS at,
         ROW_NUMBER() OVER (PARTITION BY w.goal_id
           ORDER BY COALESCE(json_extract(w.result_check, '$.checkedAt'), c.completed_at, c.created_at) DESC, w.work_id) AS position
       FROM commitment_work w JOIN commitments c ON c.id = w.work_id
       WHERE w.goal_id IS NOT NULL AND (w.result_check IS NOT NULL OR c.status = 'completed'
         OR (c.status = 'failed' AND json_extract(w.decision, '$.outcome') = 'accepted'))
     ) WHERE position = 1`).all().map(r => [r.goal_id, r]));
  const goals: PlanGoal[] = db.query<{ id: string }, []>('SELECT id FROM goals ORDER BY sort_order, created_at, id').all().flatMap(({ id }) => {
    const g = getGoal(id);
    if (!g) return [];
    const result = results.get(id);
    return [{
      id: g.id, parentId: g.parent_id, level: g.level, title: g.title, status: g.status, health: g.health,
      deadline: g.deadline, dependencies: g.dependencies, escalation: g.escalation_stage, sortOrder: g.sort_order, score: g.score,
      createdAt: g.created_at, updatedAt: g.updated_at,
      activatedAt: Math.max(g.started_at ?? 0, resumed.get(id) ?? 0) || null,
      lastProgressAt: progress.get(id) ?? null,
      lastResult: result ? { workId: result.work_id, title: result.what, verdict: result.verdict, checkId: result.check_id, summary: result.summary, at: result.at } : null,
    }];
  });

  const openWork = `FROM commitment_work w JOIN commitments c ON c.id = w.work_id
    WHERE c.status IN ('pending', 'active', 'escalated')
      AND (json_extract(w.decision, '$.outcome') = 'accepted' OR (w.decision IS NULL AND c.created_at >= ?))`;
  const limit = Math.max(1, options.workLimit ?? WORK_LIMIT);
  const total = db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n ${openWork}`).get(dayStart)!.n;
  const rows = db.query<{ work_id: string; status: CommitmentStatus; updated_at: number }, [number, number]>(
    `SELECT w.work_id, c.status, w.updated_at ${openWork} ORDER BY c.created_at DESC, w.work_id LIMIT ?`).all(dayStart, limit);
  const work: PlanWork[] = rows.map(row => {
    const w = getWorkItem(row.work_id);
    return {
      id: w.id, title: w.title, goalId: w.goalId, status: w.status, mode: w.mode,
      workflow: w.workflowId && w.workflowVersionId ? { flowId: w.workflowId, versionId: w.workflowVersionId } : null,
      blocker: w.blocker ? { kind: w.blocker.kind, reason: w.blocker.reason, waitsFor: w.blocker.kind === 'waitpoint' ? waitsFor(w) : null } : null,
      runId: w.runId,
      check: w.resultCheck ? { id: w.resultCheck.id, verdict: w.resultCheck.verdict, summary: w.resultCheck.summary, checkedAt: w.resultCheck.checkedAt } : null,
      commitmentStatus: row.status, createdAt: w.createdAt,
      activityAt: Math.max(row.updated_at, w.run?.finishTime ?? 0),
    };
  });
  const isWork = new Set(db.query<{ work_id: string }, []>('SELECT work_id FROM commitment_work').all().map(r => r.work_id));
  const commitments: PlanCommitment[] = (['pending', 'active', 'escalated'] as const).flatMap(status => findCommitments({ status }))
    .filter(c => !isWork.has(c.id))
    .map(c => ({ id: c.id, what: c.what, status: c.status, whenDue: c.when_due, createdAt: c.created_at }));
  const done = db.query<{ what: string; at: number }, [number]>(
    "SELECT what, completed_at AS at FROM commitments WHERE status = 'completed' AND completed_at >= ? ORDER BY completed_at DESC, id LIMIT 500",
  ).all(now - DONE_WINDOW).map(r => ({ title: r.what, at: r.at }));
  const workflows: PlanSnapshot['workflows'] = {};
  for (const w of work) {
    if (!w.workflow) continue;
    const key = `${w.workflow.flowId}:${w.workflow.versionId}`;
    if (workflows[key]) continue;
    try {
      const readiness = versionReadiness(w.workflow.flowId, w.workflow.versionId);
      workflows[key] = { ready: readiness.ready, reason: readiness.issues[0] ? `${readiness.issues[0].node}: ${readiness.issues[0].message}` : null };
    } catch (error) {
      workflows[key] = { ready: false, reason: (error as Error).message };
    }
  }
  return {
    now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dayStart, dayEnd,
    goals, work, commitments, done, workflows,
    capacity: options.capacity ?? DEFAULT_CAPACITY, omittedWork: Math.max(0, total - rows.length),
  };
}

export function nextAction(options: { now?: number; capacity?: number; workLimit?: number } = {}): NextActionPlan {
  return planNextAction(observeNextAction(options));
}
