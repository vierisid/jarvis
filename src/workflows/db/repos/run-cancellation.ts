import { getWorkflowDb } from "../index";
import { signalRunCanceled } from "../../runtime/cancellation-signals";
import { deleteDelegations } from "./delegation";
import { listWorkflowEffects, saveWorkflowEffect } from "./workflow-effect";
import type { RunConnectionBinding } from "./binding-pins";

export interface RunCancellation {
  runId: string;
  /** When the durable dispatch fence closed, not proof of remote rollback. */
  acknowledgedAt: number;
  statusAtRequest: string;
  /** Historical uncertainty at acknowledgement; receipts remain authoritative. */
  inFlightMayHaveCompleted: boolean;
}

export function getRunCancellation(runId: string): RunCancellation | null {
  const row = getWorkflowDb().query<{
    run_id: string; acknowledged_at: number; status_at_request: string; in_flight_may_have_completed: number;
  }, [string]>("SELECT * FROM workflow_run_cancellation WHERE run_id = ?").get(runId);
  return row ? {
    runId: row.run_id, acknowledgedAt: row.acknowledged_at,
    statusAtRequest: row.status_at_request, inFlightMayHaveCompleted: row.in_flight_may_have_completed !== 0,
  } : null;
}

/** The outcome of an approved effect whose connection was replaced after the card was raised. */
export const CONNECTION_CHANGED_CODE = 'CONNECTION_CHANGED_AFTER_REQUEST';
const CONNECTION_CHANGED_MESSAGE = 'The connection changed after you were asked, so this was not sent';
/** The same, for a connection removed or revoked after the card was raised: there is nothing to accept, it has to be set up again. */
export const CONNECTION_REMOVED_CODE = 'CONNECTION_REMOVED_AFTER_REQUEST';
const CONNECTION_REMOVED_MESSAGE = 'The connection was removed after you were asked, so this was not sent';

/** The refusals this run met fetching a connection (Q-05): a credential replaced, or a connection removed or revoked, while it ran. */
function runConnectionRefusals(runId: string): Array<{ message: string; at: number }> {
  return getWorkflowDb().query<{ record: string }, [string]>(
    'SELECT record FROM workflow_run_connection_binding WHERE run_id = ?').all(runId)
    .flatMap(row => (JSON.parse(row.record) as RunConnectionBinding).refusal ?? []);
}

/**
 * Whether a refusal says the connection was removed or revoked rather than
 * changed: there is nothing to accept then, it has to be set up again. Reads
 * the sentence `enforceRunConnectionBinding` writes (binding-pins.ts).
 */
export function connectionWasRemoved(refusal: string): boolean {
  return /^Connection .* was (removed|revoked) while this run asked for it\./su.test(refusal);
}

/** Whether this run was refused a connection it asked for (Q-05). */
export function runWasRefusedConnection(runId: string): boolean {
  return runConnectionRefusals(runId).length > 0;
}

function failedStepName(runId: string): string | null {
  const row = getWorkflowDb().query<{ failed_step: string | null }, [string]>('SELECT failed_step FROM flow_run WHERE id = ?').get(runId);
  try { return row?.failed_step ? (JSON.parse(row.failed_step) as { name?: string }).name ?? null : null; } catch { return null; }
}

/**
 * Caller holds the transaction and has established that the run cannot
 * continue. Returns the ids of the cards it closed, so a caller that can reach
 * the approval surfaces can drop them there too.
 */
function retireRunWaits(runId: string, ts: number, canceled: boolean): string[] {
  const db = getWorkflowDb();
  const closed: string[] = [];
  // A connection the run asked for was refused (Q-05): its credential was
  // replaced, or it was removed, so nothing was handed out for it.
  const refusals = canceled ? [] : runConnectionRefusals(runId);
  const failedStep = refusals.length > 0 ? failedStepName(runId) : null;
  // Pending effects provably never dispatched. Leave in-flight and final
  // effects alone: cleanup cannot certify rollback or replace their receipts.
  for (const effect of listWorkflowEffects(runId)) {
    if (effect.status !== 'pending') continue;
    effect.finishedAt = ts;
    if (effect.partial) {
      // Resumable work that already ran slices: earlier slices had effects, so
      // neither the record nor the approval receipt may say nothing started.
      // Blocked, as the boundary records a typed stop, with an outcome that
      // says earlier slices may have had effects.
      effect.status = 'blocked';
      effect.error = canceled ? 'Workflow canceled between slices; earlier slices ran' : 'Workflow ended between slices; earlier slices ran';
      effect.outcome = { status: 'blocked', code: canceled ? 'WORKFLOW_CANCELED' : 'WORKFLOW_FINISHED',
        message: effect.error, effect: 'may_have_occurred' };
    } else if (effect.approvalId && effect.stepName === failedStep && refusals.some(r => r.at >= effect.createdAt)) {
      // The step that failed had raised this card, and only then was it refused
      // its connection: replaced or removed after the card was raised. Nothing
      // was handed out or sent. Another step's effect, or a refusal from before
      // the card, is not this, and reads as the run having ended.
      const removed = refusals.some(r => r.at >= effect.createdAt && connectionWasRemoved(r.message));
      effect.status = 'blocked';
      effect.error = removed ? CONNECTION_REMOVED_MESSAGE : CONNECTION_CHANGED_MESSAGE;
      effect.outcome = { status: 'blocked', code: removed ? CONNECTION_REMOVED_CODE : CONNECTION_CHANGED_CODE, message: effect.error, effect: 'not_started' };
    } else {
      effect.status = 'blocked';
      effect.error = canceled ? 'Workflow canceled before dispatch' : 'Workflow ended before dispatch';
      effect.outcome = { status: 'blocked', code: canceled ? 'WORKFLOW_CANCELED' : 'WORKFLOW_FINISHED',
        message: effect.error, effect: 'not_started' };
    }
    saveWorkflowEffect(effect);
    if (effect.approvalId) {
      const denied = db.run(`UPDATE approval_requests SET status='denied', decided_at=?, decided_by=?
        WHERE id=? AND execution_mode='workflow' AND status='pending'`,
      [ts, canceled ? 'workflow-cancellation' : 'workflow-completion', effect.approvalId]);
      const receipted = db.run(`UPDATE approval_requests SET status='executed', executed_at=?, execution_result=?, execution_outcome=?
        WHERE id=? AND execution_mode='workflow' AND status='approved'`, [ts, effect.error, effect.partial ? 'failed' : 'blocked', effect.approvalId]);
      if (denied.changes > 0 || receipted.changes > 0) closed.push(effect.approvalId);
    }
  }
  db.run('UPDATE waitpoint SET resumed_at=? WHERE flow_run_id=? AND resumed_at IS NULL', [ts, runId]);
  return closed;
}

/**
 * Retire abandoned waits without changing a terminal run's status or failure
 * evidence. Returns the ids of the cards it closed.
 */
export function retireTerminalRunWaits(runId: string): string[] {
  const db = getWorkflowDb();
  return db.transaction((): string[] => {
    const run = db.query<{ status: string }, [string]>('SELECT status FROM flow_run WHERE id=?').get(runId);
    if (!run || ['QUEUED', 'RUNNING', 'PAUSED'].includes(run.status)) return [];
    return retireRunWaits(runId, Date.now(), false);
  }).immediate();
}

/**
 * Atomically stop the run and ALL its queued attempts, including legacy jobs.
 * A `reason` is kept on the stopped run (its failed step), so a run stopped
 * because its workflow was turned off says so (Q-06). Required descendants
 * stopped with it keep the plain cancellation: the reason names the root's
 * workflow, not theirs.
 */
export function cancelFlowRun(runId: string, opts: { reason?: string; reasonLabel?: string } = {}): {
  accepted: boolean; jobCanceled: boolean; cancellation: RunCancellation | null;
  /** The cards this stop closed, the run's and its stopped descendants', for a caller that can drop them from the surfaces. */
  closedApprovalIds: string[];
} {
  const db = getWorkflowDb();
  const stopped: string[] = [];
  const closedApprovalIds: string[] = [];
  const stop = (id: string) => {
    const run = db.query<{ status: string; start_time: number | null }, [string]>(
      "SELECT status, start_time FROM flow_run WHERE id = ?",
    ).get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    let cancellation = getRunCancellation(id);
    if (!cancellation && !["QUEUED", "RUNNING", "PAUSED"].includes(run.status)) {
      return { accepted: false, jobCanceled: false, cancellation: null, closedApprovalIds };
    }
    const ts = Date.now();
    if (!cancellation) {
      db.run(`INSERT INTO workflow_run_cancellation
        (run_id, acknowledged_at, status_at_request, in_flight_may_have_completed)
        VALUES (?, ?, ?, ?)`, [id, ts, run.status, run.status === "RUNNING" || run.start_time !== null ? 1 : 0]);
      cancellation = getRunCancellation(id)!;
    }
    const jobs = db.run(`UPDATE workflow_job SET status = 'CANCELED', locked_until = NULL, updated = ?
      WHERE job_type = 'RUN_FLOW' AND status IN ('QUEUED', 'RUNNING')
        AND (flow_run_id = ? OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END = ?))`, [ts, id, id]);
    db.run("UPDATE flow_run SET status = 'STOPPED', finish_time = ?, updated = ? WHERE id = ?",
      [cancellation.acknowledgedAt, ts, id]);
    closedApprovalIds.push(...retireRunWaits(id, ts, true));
    stopped.push(id);
    if (opts.reason && id === runId) {
      db.run("UPDATE flow_run SET failed_step = ? WHERE id = ?", [JSON.stringify({
        name: "<lifecycle>", displayName: opts.reasonLabel ?? "Stopped", errorMessage: opts.reason }), id]);
    }
    // A stopped run never resumes a delegated conversation; drop its log.
    deleteDelegations(id);
    return { accepted: true, jobCanceled: jobs.changes > 0, cancellation, closedApprovalIds };
  };
  const result = db.transaction(() => {
    const result = stop(runId);
    if (!result.accepted) return result;
    // A reusable invocation can have several parents. Follow every subscriber,
    // not just the original effect owner, and stop a child only after its last
    // live waiter has stopped. Explicit cancellation of the root still wins.
    // Only mark stopped children visited: a retained child must be reconsidered
    // if another parent later in this traversal is stopped too.
    const visited = new Set([runId]);
    const descendants = [runId];
    for (let i = 0; i < descendants.length; i++) {
      const children = db.query<{ child_run_id: string }, [string]>(`
        SELECT c.child_run_id FROM workflow_child_run c
        JOIN workflow_effect e ON e.id=c.effect_id JOIN flow_run child ON child.id=c.child_run_id
        WHERE e.run_id=?1 AND c.waitpoint_id IS NOT NULL
        UNION
        SELECT c.child_run_id FROM workflow_subflow_call c
        JOIN workflow_subflow_wait w ON w.call_id=c.id JOIN flow_run child ON child.id=c.child_run_id
        WHERE w.parent_run_id=?1`).all(descendants[i]!);
      for (const child of children) {
        if (visited.has(child.child_run_id)) continue;
        if (hasLiveSubflowWaiter(child.child_run_id)) continue;
        visited.add(child.child_run_id);
        if (stop(child.child_run_id).accepted) descendants.push(child.child_run_id);
      }
    }
    return result;
  }).immediate();
  // Never announce cancellation until the entire tree transaction commits.
  for (const id of stopped) signalRunCanceled(id);
  return result;
}

/** Shared ownership used by explicit cancellation and the abandoned-child sweep. */
export function hasLiveSubflowWaiter(childRunId: string): boolean {
  return !!getWorkflowDb().query(`SELECT 1 FROM workflow_subflow_call c
    JOIN workflow_subflow_wait w ON w.call_id=c.id
    JOIN waitpoint p ON p.id=w.waitpoint_id
    JOIN flow_run r ON r.id=w.parent_run_id JOIN flow f ON f.id=r.flow_id
    WHERE c.child_run_id=? AND c.result_json IS NULL AND p.resumed_at IS NULL
      AND r.status IN ('QUEUED','RUNNING','PAUSED')
      AND NOT (f.disabled_at IS NOT NULL AND r.created<=f.disabled_at)
    LIMIT 1`).get(childRunId);
}

/** Upgrade canceled jobs left by older daemons without reviving finished runs. */
export function recoverCanceledRuns(): void {
  const rows = getWorkflowDb().query<{ id: string }, []>(`SELECT r.id FROM flow_run r
    WHERE r.status IN ('QUEUED', 'RUNNING', 'PAUSED') AND (
      EXISTS (SELECT 1 FROM workflow_run_cancellation c WHERE c.run_id = r.id)
      OR (SELECT j.status FROM workflow_job j WHERE j.job_type = 'RUN_FLOW'
          AND (j.flow_run_id = r.id OR (j.flow_run_id IS NULL AND CASE WHEN json_valid(j.payload) THEN json_extract(j.payload, '$.runId') END = r.id))
          ORDER BY j.created DESC, j.rowid DESC LIMIT 1) = 'CANCELED'
    )`).all();
  for (const row of rows) cancelFlowRun(row.id);
}
