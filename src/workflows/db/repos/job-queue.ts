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

export function cancelJob(id: string): void {
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
