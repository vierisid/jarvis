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
 * the next poll.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";

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
  /** How long the worker holds the claim before another worker can steal it. */
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
      input.maxAttempts ?? 3,
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
 * "Ready" = status='QUEUED' AND scheduled_at <= now AND (locked_until IS NULL
 * OR locked_until <= now). On claim, status flips to 'RUNNING', attempt++,
 * locked_until = now + leaseMs.
 */
export function claimNextJob<P = Record<string, unknown>>(opts: ClaimOptions = {}): Job<P> | null {
  const now = opts.now ?? nowMs();
  const leaseUntil = now + (opts.leaseMs ?? DEFAULT_LEASE_MS);
  // A row is claimable if it's QUEUED and ready to run, OR if it's RUNNING but
  // its lease has expired (a previous worker claimed it and never reported
  // back). The lease-expiry branch is what lets a crashed worker's job get
  // retried by another worker.
  const row = db()
    .query<JobRow, [JobStatus, number, number, number, number]>(
      `UPDATE workflow_job
       SET status = ?, attempt = attempt + 1, locked_until = ?, updated = ?
       WHERE id = (
         SELECT id FROM workflow_job
         WHERE (status = 'QUEUED' AND scheduled_at <= ?)
            OR (status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until <= ?)
         ORDER BY priority DESC, scheduled_at ASC, created ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get("RUNNING", leaseUntil, now, now, now);
  return row ? rowToJob<P>(row) : null;
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
 * Reset such jobs to `QUEUED` with the lease cleared and `scheduled_at=now` so
 * the worker re-claims them IMMEDIATELY, instead of waiting out the (up to
 * `leaseMs`, default 5-min) lease lapse. The run re-executes from its last
 * durable checkpoint. Exhausted jobs also close any unfinished run, preserving
 * partial outputs and recording that its outcome is unknown. Returns how many
 * jobs were requeued. Must run BEFORE the
 * worker starts polling.
 */
export function recoverOrphanedJobs(): number {
  const ts = nowMs();
  const d = db();
  return d.transaction(() => {
    // Never replay exhausted jobs: they may already have produced external effects.
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
    // No executor from the previous process is alive. Repair cancelled runs
    // left unfinished by older code, before handling exhausted executions.
    reconcileCanceledRuns(ts);
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
  if (job.attempt >= job.maxAttempts) {
    db().run(
      `UPDATE workflow_job
       SET status = 'FAILED', last_error = ?, locked_until = NULL, updated = ?
       WHERE id = ?`,
      [error, ts, id],
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

/** Called only for an unclaimed cancellation, or before workers start at boot. */
function reconcileCanceledRuns(ts: number, runId?: string): void {
  db().run(
    `UPDATE flow_run SET status = 'STOPPED', failed_step = ?, finish_time = ?, updated = ?
     WHERE status IN ('QUEUED', 'RUNNING', 'PAUSED')
       ${runId === undefined ? '' : 'AND id = ?'}
       AND (SELECT j.status FROM workflow_job j
         WHERE j.flow_run_id = flow_run.id AND j.job_type = 'RUN_FLOW'
         ORDER BY j.created DESC, j.rowid DESC LIMIT 1) = 'CANCELED'
       AND NOT EXISTS (SELECT 1 FROM workflow_job j WHERE j.flow_run_id = flow_run.id
         AND j.status IN ('QUEUED', 'RUNNING'))`,
    [JSON.stringify({ name: '<cancel>', displayName: 'Cancellation',
      errorMessage: 'Execution was cancelled. Inspect any partial results before proposing another run.' }),
    ts, ts, ...(runId === undefined ? [] : [runId])],
  );
}

export function cancelJob(id: string): void {
  const d = db();
  d.transaction(() => {
    const job = getJob(id);
    if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return;
    const ts = nowMs();
    d.run(
      `UPDATE workflow_job SET status = 'CANCELED', locked_until = NULL, updated = ? WHERE id = ?`,
      [ts, id],
    );
    // Claim and cancellation serialize through SQLite. Only an unclaimed job
    // can be acknowledged as stopped here; a live executor owns its outcome.
    if (job.status === 'QUEUED' && job.jobType === 'RUN_FLOW' && job.flowRunId) {
      reconcileCanceledRuns(ts, job.flowRunId);
    }
  })();
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
