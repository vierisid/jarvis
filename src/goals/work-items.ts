/** Durable Today work, extending commitments instead of creating another task identity. */
import { getDb, generateId } from '../vault/schema.ts';
import { createCommitment, getCommitment } from '../vault/commitments.ts';
import * as goals from '../vault/goals.ts';
import { getFlow } from '../workflows/db/repos/flow.ts';
import { getFlowVersion } from '../workflows/db/repos/flow-version.ts';
import { getFlowRun, type FlowRun } from '../workflows/db/repos/flow-run.ts';
import { listWaitpointsByFlowRun } from '../workflows/db/repos/waitpoint.ts';

export type WorkMode = 'manual' | 'workflow';
export type WorkDecision = {
  id: string; outcome: 'accepted' | 'rejected'; reason: string; decidedBy: 'user'; decidedAt: number;
};
export type ResultCheck = {
  id: string; verdict: 'passed' | 'failed'; summary: string;
  evidence: { ref: string; description: string }[];
  checkedBy: 'user'; checkedAt: number; runId: string | null;
  runSnapshot: FlowRun | null; goalProgressId: string | null;
};
type WorkRow = {
  work_id: string; plan_id: string | null; action_index: number | null; goal_id: string | null;
  mode: WorkMode; workflow_id: string | null; workflow_version_id: string | null;
  input: string; decision: string | null; run_id: string | null; blocker: string | null;
  result_check: string | null; updated_at: number;
};
export type WorkItem = {
  id: string; title: string; planId: string | null; actionIndex: number | null;
  goalId: string | null; mode: WorkMode; workflowId: string | null; workflowVersionId: string | null;
  input: Record<string, unknown>; decision: WorkDecision | null; runId: string | null;
  run: FlowRun | null; blocker: { kind: string; ref: string | null; reason: string } | null;
  resultCheck: ResultCheck | null;
  status: 'proposed' | 'rejected' | 'ready' | 'running' | 'blocked' | 'needs_check' | 'verified' | 'failed';
  createdAt: number; updatedAt: number;
};

export class WorkItemError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function row(id: string): WorkRow {
  const value = getDb().query<WorkRow, [string]>('SELECT * FROM commitment_work WHERE work_id = ?').get(id);
  if (!value) throw new WorkItemError('Work item not found', 404);
  return value;
}
function workflowAvailable(): boolean {
  return !!getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flow_run'").get();
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) {
    throw new WorkItemError(`${name} must be non-empty text of at most 10000 characters`);
  }
  return value.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkItemError('Expected an object');
  return value as Record<string, unknown>;
}
export function getWorkItem(id: string): WorkItem {
  const w = row(id);
  const commitment = getCommitment(id)!;
  const decision = w.decision ? JSON.parse(w.decision) as WorkDecision : null;
  const resultCheck = w.result_check ? JSON.parse(w.result_check) as ResultCheck : null;
  const run = w.run_id && workflowAvailable() ? getFlowRun(w.run_id) : null;
  const waitpoint = run ? listWaitpointsByFlowRun(run.id, false)[0] : undefined;
  let blocker: WorkItem['blocker'] = w.blocker ? { kind: 'manual', ref: null, reason: w.blocker } : null;
  let status: WorkItem['status'] = decision ? decision.outcome === 'rejected' ? 'rejected' : 'ready' : 'proposed';
  if (w.run_id) {
    if (!run) {
      blocker = { kind: 'missing_run', ref: w.run_id, reason: 'Linked run is unavailable' };
      status = 'blocked';
    } else if (run.status === 'PAUSED' || waitpoint) {
      blocker = { kind: 'waitpoint', ref: waitpoint?.id ?? run.id, reason: waitpoint ? `Waiting at ${waitpoint.stepName}` : 'Run is paused' };
      status = 'blocked';
    } else if (run.status === 'RUNNING' || run.status === 'QUEUED') {
      status = 'running';
    } else if (run.status === 'SUCCEEDED') {
      status = 'needs_check';
    } else {
      status = 'failed';
      blocker = { kind: 'run_failure', ref: run.id, reason: run.failedStep?.errorMessage ?? run.status };
    }
  }
  if (w.blocker && !w.run_id && decision?.outcome === 'accepted') status = 'blocked';
  if (resultCheck) {
    status = resultCheck.verdict === 'passed' ? 'verified' : 'failed';
    blocker = resultCheck.verdict === 'passed' ? null : { kind: 'result_check', ref: resultCheck.id, reason: resultCheck.summary };
  }
  return {
    id, title: commitment.what, planId: w.plan_id, actionIndex: w.action_index, goalId: w.goal_id,
    mode: w.mode, workflowId: w.workflow_id, workflowVersionId: w.workflow_version_id,
    input: JSON.parse(w.input), decision, runId: w.run_id, run, blocker, resultCheck, status,
    createdAt: commitment.created_at, updatedAt: Math.max(w.updated_at, run?.updated ?? 0),
  };
}

export function listWorkItems(filter: { planId?: string; goalId?: string; today?: boolean } = {}): WorkItem[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.planId !== undefined) { conditions.push('w.plan_id = ?'); params.push(filter.planId); }
  if (filter.goalId !== undefined) { conditions.push('w.goal_id = ?'); params.push(filter.goalId); }
  if (filter.today) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    conditions.push('c.created_at >= ? AND c.created_at < ?'); params.push(start.getTime(), end.getTime());
  }
  return getDb().query<{ work_id: string }, (string | number)[]>(
    `SELECT w.work_id FROM commitment_work w JOIN commitments c ON c.id = w.work_id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY c.created_at, w.action_index, w.work_id`,
  ).all(...params).map(w => getWorkItem(w.work_id));
}

/** Called inside the same transaction as the check-in insert. Strings stay readable for old clients. */
export function createPlannedWork(planId: string, actions: { title: string; goalId: string | null }[]): WorkItem[] {
  return getDb().transaction(() => actions.map((action, index) => {
    const existing = getDb().query<{ work_id: string }, [string, number]>(
      'SELECT work_id FROM commitment_work WHERE plan_id = ? AND action_index = ?',
    ).get(planId, index);
    if (existing) return getWorkItem(existing.work_id);
    const commitment = createCommitment(requiredText(action.title, 'title'), { created_from: `goal_check_in:${planId}` });
    getDb().run(
      'INSERT INTO commitment_work (work_id, plan_id, action_index, goal_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [commitment.id, planId, index, action.goalId && goals.getGoal(action.goalId) ? action.goalId : null, Date.now()],
    );
    return getWorkItem(commitment.id);
  }))();
}

export function createWorkItem(body: unknown): WorkItem {
  const input = object(body);
  return getDb().transaction(() => {
    const commitment = createCommitment(requiredText(input.title, 'title'));
    getDb().run('INSERT INTO commitment_work (work_id, updated_at) VALUES (?, ?)', [commitment.id, Date.now()]);
    const { title: _title, ...configuration } = input;
    return configureWorkItem(commitment.id, configuration);
  })();
}

/** Configuration is frozen by the decision, so approval always refers to the exact version and input. */
export function configureWorkItem(id: string, body: unknown): WorkItem {
  const patch = object(body);
  const w = row(id);
  if (w.decision) throw new WorkItemError('Decided work is immutable; create a new proposal to change it', 409);
  const allowed = ['goalId', 'mode', 'workflowId', 'workflowVersionId', 'input'];
  if (Object.keys(patch).some(k => !allowed.includes(k))) throw new WorkItemError('Unknown work configuration field');
  const goalId = patch.goalId === undefined ? w.goal_id : patch.goalId;
  if (goalId !== null && (typeof goalId !== 'string' || !goals.getGoal(goalId))) throw new WorkItemError('Unknown goalId');
  const mode = patch.mode === undefined ? w.mode : patch.mode;
  if (mode !== 'manual' && mode !== 'workflow') throw new WorkItemError('mode must be manual or workflow');
  const workflowId = patch.workflowId === undefined ? w.workflow_id : patch.workflowId;
  const versionId = patch.workflowVersionId === undefined ? w.workflow_version_id : patch.workflowVersionId;
  if (mode === 'workflow') {
    if (!workflowAvailable()) throw new WorkItemError('Workflow runtime is unavailable', 409);
    if (typeof workflowId !== 'string' || typeof versionId !== 'string') throw new WorkItemError('workflowId and workflowVersionId are required');
    const version = getFlowVersion(versionId);
    if (!getFlow(workflowId) || !version || version.flowId !== workflowId || version.state !== 'LOCKED') {
      throw new WorkItemError('Choose a locked version belonging to the workflow');
    }
  } else if (workflowId !== null || versionId !== null) {
    throw new WorkItemError('Manual work cannot reference a workflow');
  }
  const payload = patch.input === undefined ? w.input : JSON.stringify(object(patch.input));
  if (payload.length > 256_000) throw new WorkItemError('input exceeds 256000 characters');
  getDb().run(
    'UPDATE commitment_work SET goal_id = ?, mode = ?, workflow_id = ?, workflow_version_id = ?, input = ?, updated_at = ? WHERE work_id = ?',
    [goalId as string | null, mode, workflowId as string | null, versionId as string | null, payload, Date.now(), id],
  );
  return getWorkItem(id);
}

export function decideWorkItem(id: string, body: unknown): WorkItem {
  const input = object(body);
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') throw new WorkItemError('outcome must be accepted or rejected');
  const reason = requiredText(input.reason, 'reason');
  return getDb().transaction(() => {
    const w = row(id);
    if (w.decision) {
      const decision = JSON.parse(w.decision) as WorkDecision;
      if (decision.outcome === input.outcome && decision.reason === reason) return getWorkItem(id);
      throw new WorkItemError('Work already has a decision', 409);
    }
    const decision: WorkDecision = { id: generateId(), outcome: input.outcome as WorkDecision['outcome'], reason, decidedBy: 'user', decidedAt: Date.now() };
    getDb().run('UPDATE commitment_work SET decision = ?, updated_at = ? WHERE work_id = ?', [JSON.stringify(decision), decision.decidedAt, id]);
    return getWorkItem(id);
  })();
}

export function setWorkBlocker(id: string, body: unknown): WorkItem {
  const input = object(body);
  const reason = input.reason === null ? null : requiredText(input.reason, 'reason');
  const w = row(id);
  if (w.result_check || w.run_id || !w.decision || JSON.parse(w.decision).outcome !== 'accepted') {
    throw new WorkItemError('Only accepted, unstarted work can have a manual blocker', 409);
  }
  getDb().run('UPDATE commitment_work SET blocker = ?, updated_at = ? WHERE work_id = ?', [reason, Date.now(), id]);
  return getWorkItem(id);
}

/** A successful run is execution evidence, never an automatic claim of goal progress. */
export function checkWorkResult(id: string, body: unknown): WorkItem {
  const input = object(body);
  if (input.verdict !== 'passed' && input.verdict !== 'failed') throw new WorkItemError('verdict must be passed or failed');
  const summary = requiredText(input.summary, 'summary');
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 20) throw new WorkItemError('Provide 1-20 evidence references');
  const evidence = input.evidence.map(entry => {
    const e = object(entry);
    return { ref: requiredText(e.ref, 'evidence.ref'), description: requiredText(e.description, 'evidence.description') };
  });
  return getDb().transaction(() => {
    const work = getWorkItem(id);
    if (work.resultCheck) throw new WorkItemError('Result is already checked', 409);
    if (work.decision?.outcome !== 'accepted' || work.blocker?.kind === 'manual') throw new WorkItemError('Accept and unblock the work before checking its result', 409);
    if (work.mode === 'workflow') {
      if (!work.run || ['RUNNING', 'QUEUED', 'PAUSED'].includes(work.run.status)) throw new WorkItemError('A finished linked run is required', 409);
      if (listWaitpointsByFlowRun(work.run.id, false).length) throw new WorkItemError('Resolve outstanding run waitpoints before checking its result', 409);
      if (input.verdict === 'passed' && work.run.status !== 'SUCCEEDED') throw new WorkItemError('A failed run cannot be verified as successful', 409);
    }
    const check: ResultCheck = {
      id: generateId(), verdict: input.verdict as ResultCheck['verdict'], summary, evidence,
      checkedBy: 'user', checkedAt: Date.now(), runId: work.runId, runSnapshot: work.run, goalProgressId: null,
    };
    if (input.goalScore !== undefined) {
      if (check.verdict !== 'passed' || !work.goalId || typeof input.goalScore !== 'number' || !Number.isFinite(input.goalScore) || input.goalScore < 0 || input.goalScore > 1) {
        throw new WorkItemError('goalScore requires a passed check, linked goal, and a number from 0 to 1');
      }
      const goal = goals.getGoal(work.goalId);
      if (!goal) throw new WorkItemError('Linked goal no longer exists', 409);
      const progress = goals.addProgressEntry(goal.id, 'manual', goal.score, input.goalScore, summary, `work_item:${id}:check:${check.id}`);
      check.goalProgressId = progress.id;
      getDb().run('UPDATE goals SET score = ?, score_reason = ?, updated_at = ? WHERE id = ?', [input.goalScore, summary, check.checkedAt, goal.id]);
    }
    getDb().run('UPDATE commitment_work SET result_check = ?, updated_at = ? WHERE work_id = ?', [JSON.stringify(check), check.checkedAt, id]);
    getDb().run('UPDATE commitments SET status = ?, completed_at = ?, result = ? WHERE id = ?', [check.verdict === 'passed' ? 'completed' : 'failed', check.checkedAt, summary, id]);
    return getWorkItem(id);
  })();
}
