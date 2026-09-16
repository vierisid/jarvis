/**
 * SQLite-backed job queue. Replaces BullMQ/Redis for the workflow runtime.
 *
 * Atomic claim via SQLite RETURNING (3.35+; bun:sqlite ships a recent SQLite).
 * A single SELECT-then-UPDATE under a write transaction would also be safe
 * because bun:sqlite serializes writes per-connection, but RETURNING keeps the
 * claim to one round-trip.
 *
 * Status machine:
 *
 *   QUEUED ──claim──▶ RUNNING ──completeJob──▶ SUCCEEDED
 *      ▲                 │
 *      │                 └─failJob (retries left)──┐
 *      └────────────────────────────────────────────┘
 *                        │
 *                        └─failJob (no retries)──▶ FAILED
 *
 *   QUEUED|RUNNING ──cancelJob──▶ CANCELED
 *
 * Lease: a claimed job is locked for `leaseMs`. If a worker dies mid-execution
 * the row's `locked_until` will lapse and another worker can re-claim it on
 * the next poll, EXCEPT for RUN_FLOW. Workflow execution is never reassigned:
 * the original worker may still be running and effects may already exist.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";
import { maxAttemptsForJob, RUN_FLOW, workflowFailureMessage } from "../../queue/retry-policy";
import { cancelFlowRun, getRunCancellation, recoverCanceledRuns } from "./run-cancellation";

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export interface JobRow {
  id: string;
  job_type: string;
  flow_run_id: string | null;
  flow_id: string | null;
  flow_version_id: string | null;
  payload: string;
  priority: number;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  locked_until: number | null;
  scheduled_at: number;
  last_error: string | null;
  created: number;
  updated: number;
}

export interface Job<P = Record<string, unknown>> {
  id: string;
  jobType: string;
  flowRunId: string | null;
  flowId: string | null;
  flowVersionId: string | null;
  payload: P;
  priority: number;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  lockedUntil: number | null;
  scheduledAt: number;
  lastError: string | null;
  created: number;
  updated: number;
}

export interface EnqueueInput<P = Record<string, unknown>> {
  jobType: string;
  payload: P;
  flowRunId?: string;
  flowId?: string;
  flowVersionId?: string;
  priority?: number;
  scheduledAt?: number;
  maxAttempts?: number;
}

export interface ClaimOptions {
  /** Lease duration for retryable jobs. RUN_FLOW claims cannot be stolen. */
  leaseMs?: number;
  now?: number;
}

export interface FailJobOptions {
  /** Backoff multiplier (ms). Final delay = backoffMs * 4^(attempt-1). */
  backoffMs?: number;
  /** Cap on backoff. */
  maxBackoffMs?: number;
  now?: number;
}

const DEFAULT_LEASE_MS = 5 * 60_000; // 5 minutes
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

function db(): Database {
  return getWorkflowDb();
}

function nowMs(): number {
  return Date.now();
}

function rowToJob<P = Record<string, unknown>>(row: JobRow): Job<P> {
  return {
    id: row.id,
    jobType: row.job_type,
    flowRunId: row.flow_run_id,
    flowId: row.flow_id,
    flowVersionId: row.flow_version_id,
    payload: JSON.parse(row.payload) as P,
    priority: row.priority,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    lockedUntil: row.locked_until,
    scheduledAt: row.scheduled_at,
    lastError: row.last_error,
    created: row.created,
    updated: row.updated,
  };
}

/** Jobs waiting to run. Used to refuse public ingress once a backlog builds. */
export function countQueued(): number {
  const row = db()
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM workflow_job WHERE status = 'QUEUED'`)
    .get();
  return row?.n ?? 0;
}

export function enqueue<P = Record<string, unknown>>(input: EnqueueInput<P>): Job<P> {
  const runId = input.flowRunId ?? (input.payload as { runId?: string } | null)?.runId;
  if (input.jobType === "RUN_FLOW" && runId && getRunCancellation(runId)) {
    throw new Error(`Cannot enqueue canceled workflow run ${runId}`);
  }
  const id = apId();
  const ts = nowMs();
  db().run(
    `INSERT INTO workflow_job (
      id, job_type, flow_run_id, flow_id, flow_version_id, payload,
      priority, status, attempt, max_attempts, scheduled_at, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?, ?)`,
    [
      id,
      input.jobType,
      input.flowRunId ?? null,
      input.flowId ?? null,
      input.flowVersionId ?? null,
      JSON.stringify(input.payload),
      input.priority ?? 0,
      maxAttemptsForJob(input.jobType, input.maxAttempts),
      input.scheduledAt ?? ts,
      ts,
      ts,
    ],
  );
  const row = db()
    .query<JobRow, [string]>(`SELECT * FROM workflow_job WHERE id = ?`)
    .get(id);
  if (!row) throw new Error(`enqueue: row missing after insert (id=${id})`);
  return rowToJob<P>(row);
}

/**
 * Atomically claim the next ready job. Returns null if the queue is empty.
 *
 * "Ready" = QUEUED and scheduled, or an expired RUNNING lease for a retryable
 * job type. Workflow jobs must never have been attempted. On claim, status
 * flips to RUNNING, attempt++, locked_until = now + leaseMs.
 */
export function claimNextJob<P = Record<string, unknown>>(opts: ClaimOptions = {}): Job<P> | null {
  const now = opts.now ?? nowMs();
  const leaseUntil = now + (opts.leaseMs ?? DEFAULT_LEASE_MS);
  return db().transaction(() => {
    // Older chat jobs may already be queued for a second attempt. Retire
    // those before claiming anything, even when boot recovery wasn't called.
    retireWorkflowRetries(now, false);
    const row = db()
      .query<JobRow, [JobStatus, number, number, number, number, string]>(
        `UPDATE workflow_job
       SET status = ?, attempt = attempt + 1, locked_until = ?, updated = ?
       WHERE id = (
         SELECT id FROM workflow_job
         WHERE (status = 'QUEUED' AND scheduled_at <= ?)
            OR (status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until <= ? AND job_type != ?)
         ORDER BY priority DESC, scheduled_at ASC, created ASC
         LIMIT 1
       )
       RETURNING *`,
      )
      .get("RUNNING", leaseUntil, now, now, now, RUN_FLOW);
    return row ? rowToJob<P>(row) : null;
  })();
}

/** Called inside a transaction. Preserve step outputs and terminal run results;
 * an interrupted job is evidence of uncertainty, never proof of no effect. */
function retireWorkflowRetries(ts: number, atBoot: boolean): void {
  const d = db();
  d.run(`UPDATE workflow_job SET max_attempts = 1, updated = ?
    WHERE job_type = ? AND status IN ('QUEUED', 'RUNNING') AND max_attempts != 1`, [ts, RUN_FLOW]);
  const jobs = d.query<JobRow, [string, number]>(`SELECT * FROM workflow_job
    WHERE job_type = ? AND ((status = 'QUEUED' AND attempt > 0) OR (? = 1 AND status = 'RUNNING'))`)
    .all(RUN_FLOW, atBoot ? 1 : 0);
  for (const job of jobs) {
    const reason = job.status === "RUNNING"
      ? "Workflow execution was interrupted before its queue result was recorded. Effects may already have completed."
      : "A previously attempted workflow job was queued for replay; automatic replay was stopped.";
    const message = workflowFailureMessage([reason, job.last_error].filter(Boolean).join("\n"));
    d.run(`UPDATE workflow_job SET status = 'FAILED', last_error = ?, locked_until = NULL, updated = ? WHERE id = ?`,
      [message, ts, job.id]);
    // flow_run_id was optional in older callers. Use the execution payload as
    // a fallback so those runs also stop looking perpetually RUNNING/PAUSED.
    let runId = job.flow_run_id;
    if (!runId) {
      try {
        const payload = JSON.parse(job.payload);
        if (typeof payload?.runId === "string") runId = payload.runId;
      } catch { /* Keep the malformed job's durable error even without a run. */ }
    }
    if (runId) {
      // A durable PAUSED result can be waiting on an open waitpoint or on
      // the fresh RESUME that consumed it before this old job finished.
      // Preserve either continuation, but never an attempted/mismatched job.
      // Merely queuing a resume while RUNNING does not establish a pause.
      d.run(`UPDATE flow_run SET status = 'FAILED', failed_step = ?, finish_time = ?, updated = ?
        WHERE id = ? AND status IN ('QUEUED', 'RUNNING', 'PAUSED')
          AND (status != 'PAUSED' OR (
            NOT EXISTS (SELECT 1 FROM waitpoint WHERE flow_run_id = flow_run.id AND resumed_at IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM workflow_job continuation
              WHERE continuation.job_type = 'RUN_FLOW' AND continuation.status = 'QUEUED' AND continuation.attempt = 0
                AND (continuation.flow_run_id IS NULL OR continuation.flow_run_id = flow_run.id)
                AND (continuation.flow_id IS NULL OR continuation.flow_id = flow_run.flow_id)
                AND (continuation.flow_version_id IS NULL OR continuation.flow_version_id = flow_run.flow_version_id)
                AND CASE WHEN json_valid(continuation.payload) THEN
                  json_extract(continuation.payload, '$.runId') = flow_run.id
                  AND json_extract(continuation.payload, '$.executionType') = 'RESUME'
                ELSE 0 END
            )
          ))`, [
        JSON.stringify({ name: "<queue>", displayName: "Interrupted execution", errorMessage: message }),
        ts, ts, runId,
      ]);
    }
  }
}

export function getJob<P = Record<string, unknown>>(id: string): Job<P> | null {
  const row = db()
    .query<JobRow, [string]>(`SELECT * FROM workflow_job WHERE id = ?`)
    .get(id);
  return row ? rowToJob<P>(row) : null;
}

/**
 * Boot-time recovery (UPDATES.md graceful-drain resume). The daemon is
 * single-process, so any job still `RUNNING` at startup was orphaned by the
 * previous process's death (crash, or a drain that exceeded its deadline).
 * Retire RUN_FLOW jobs with an actionable error without replaying effects.
 * Other job types may re-queue within their attempt budget. Returns how many
 * retryable jobs were re-queued. Must run BEFORE the worker starts polling.
 * Runs stranded by an older daemon's recovery code are closed the same way.
 */
export function recoverOrphanedJobs(): number {
  // Before the transaction below, and before retireWorkflowRetries, on purpose.
  // (1) cancelFlowRun opens its own BEGIN IMMEDIATE and only announces the stop
  // decision once that commits; nesting it here would signal on a savepoint
  // release instead. (2) retireWorkflowRetries FAILs a run left QUEUED/RUNNING/
  // PAUSED with raw SQL, bypassing updateRun's fence -- so a legacy canceled job
  // has to reach STOPPED first or its run would settle as FAILED instead.
  // Moving this call inside the transaction throws no error, because bun runs
  // the inner transaction as a savepoint, so the mistake is silent; only
  // 'recovery keeps a legacy canceled job stopped instead of failing it' in
  // src/workflows/queue/queue.test.ts catches it.
  recoverCanceledRuns();
  const ts = nowMs();
  const d = db();
  return d.transaction(() => {
    retireWorkflowRetries(ts, true);
    // Preserve the attempt ceiling for other orphaned job types too.
    d.run(
      `UPDATE workflow_job
       SET status = 'FAILED', last_error = 'orphaned: max attempts exhausted', locked_until = NULL, updated = ?
       WHERE status = 'RUNNING' AND attempt >= max_attempts`,
      [ts],
    );
    const res = d.run(
      `UPDATE workflow_job
       SET status = 'QUEUED', locked_until = NULL, scheduled_at = ?, updated = ?
       WHERE status = 'RUNNING' AND attempt < max_attempts`,
      [ts, ts],
    );
    // Also repair runs stranded by older recovery code. A persisted pause or
    // terminal outcome wins, as does another active job for a valid resume/retry.
    // A consumed pause whose RESUME job died before entering the handler must
    // close too; it has no remaining waitpoint that could wake the run again.
    d.run(
      `UPDATE flow_run SET status = 'FAILED', failed_step = ?, finish_time = ?, updated = ?
       WHERE status IN ('QUEUED', 'RUNNING', 'PAUSED')
         AND EXISTS (SELECT 1 FROM workflow_job j WHERE j.flow_run_id = flow_run.id
           AND j.job_type = 'RUN_FLOW' AND j.status = 'FAILED'
           AND j.last_error = 'orphaned: max attempts exhausted'
           AND (flow_run.status <> 'PAUSED' OR json_extract(j.payload, '$.executionType') = 'RESUME'))
         AND (status <> 'PAUSED' OR NOT EXISTS (SELECT 1 FROM waitpoint w
           WHERE w.flow_run_id = flow_run.id AND w.resumed_at IS NULL))
         AND NOT EXISTS (SELECT 1 FROM workflow_job j WHERE j.flow_run_id = flow_run.id
           AND j.status IN ('QUEUED', 'RUNNING'))`,
      [JSON.stringify({ name: '<recovery>', displayName: 'Recovery',
        errorMessage: 'Execution was interrupted and exhausted its attempts. Its outcome is unknown; inspect partial results before proposing another run.' }), ts, ts],
    );
    return res.changes;
  })();
}

export function completeJob(id: string): void {
  const ts = nowMs();
  const res = db().run(
    `UPDATE workflow_job
     SET status = 'SUCCEEDED', last_error = NULL, locked_until = NULL, updated = ?
     WHERE id = ? AND status = 'RUNNING'`,
    [ts, id],
  );
  if (res.changes === 0) {
    throw new Error(`completeJob: job not found or not RUNNING (id=${id})`);
  }
}

/**
 * Mark a job as failed. If retries remain, the job goes back to QUEUED with an
 * exponential-backoff scheduled_at; otherwise it terminates as FAILED.
 *
 * Returns whether the job will retry.
 */
export function failJob(id: string, error: string, opts: FailJobOptions = {}): boolean {
  const job = getJob(id);
  if (!job) throw new Error(`failJob: not found (id=${id})`);
  if (job.status !== "RUNNING") {
    throw new Error(`failJob: job is ${job.status}, expected RUNNING (id=${id})`);
  }
  const ts = opts.now ?? nowMs();
  if (job.attempt >= maxAttemptsForJob(job.jobType, job.maxAttempts)) {
    db().run(
      `UPDATE workflow_job
       SET status = 'FAILED', last_error = ?, locked_until = NULL, updated = ?
       WHERE id = ?`,
      [job.jobType === RUN_FLOW ? workflowFailureMessage(error) : error, ts, id],
    );
    return false;
  }
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const cap = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const delay = Math.min(cap, backoff * Math.pow(4, Math.max(0, job.attempt - 1)));
  db().run(
    `UPDATE workflow_job
     SET status = 'QUEUED', last_error = ?, locked_until = NULL, scheduled_at = ?, updated = ?
     WHERE id = ?`,
    [error, ts + delay, ts, id],
  );
  return true;
}

export function cancelJob(id: string): void {
  const job = getJob<{ runId?: string }>(id);
  const runId = job?.flowRunId ?? job?.payload.runId;
  if (job?.jobType === "RUN_FLOW" && runId && ["QUEUED", "RUNNING"].includes(job.status)) {
    const run = db().query("SELECT id FROM flow_run WHERE id = ?").get(runId);
    if (run) { cancelFlowRun(runId); return; }
  }
  const ts = nowMs();
  db().run(
    `UPDATE workflow_job
     SET status = 'CANCELED', locked_until = NULL, updated = ?
     WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`,
    [ts, id],
  );
}

/**
 * Find the active queue entry (QUEUED or RUNNING) for a given run id, if any.
 * Used by the API layer when canceling a run -- one run typically has one
 * active job; we return the most recent.
 */
export function findActiveJobForRun<P = Record<string, unknown>>(
  flowRunId: string,
): Job<P> | null {
  const row = db()
    .query<JobRow, [string]>(
      `SELECT * FROM workflow_job
       WHERE flow_run_id = ? AND status IN ('QUEUED', 'RUNNING')
       ORDER BY created DESC LIMIT 1`,
    )
    .get(flowRunId);
  return row ? rowToJob<P>(row) : null;
}

export interface QueueStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
}

export function queueStats(): QueueStats {
  const rows = db()
    .query<{ status: JobStatus; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM workflow_job GROUP BY status`,
    )
    .all();
  const stats: QueueStats = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const r of rows) {
    if (r.status === "QUEUED") stats.queued = r.n;
    else if (r.status === "RUNNING") stats.running = r.n;
    else if (r.status === "SUCCEEDED") stats.succeeded = r.n;
    else if (r.status === "FAILED") stats.failed = r.n;
    else if (r.status === "CANCELED") stats.canceled = r.n;
  }
  return stats;
}
