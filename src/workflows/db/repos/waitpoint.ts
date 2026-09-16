/**
 * `waitpoint` repository. Async pauses created by piece actions that call
 * `context.run.createWaitpoint()`. The flow run sits at PAUSED status until
 * the waitpoint resolves -- via timer, webhook, or explicit resume -- at
 * which point we enqueue RUN_FLOW(executionType=RESUME).
 *
 * The actual resume scheduling (cron tick for TIMER, webhook route for
 * WEBHOOK) is layered on later; this repo just records the row and exposes
 * lookup + lifecycle.
 *
 * ## The waitpoint id is a bearer capability, not a plain identifier
 *
 * `POST /api/webhooks/waitpoints/:id` is unauthenticated on purpose:
 * `/api/webhooks/*` is a public-route exemption in the global gate, because
 * the caller resuming a waitpoint is typically an external service that has
 * no Jarvis session. Holding the id IS the authorization to resume the run,
 * so treat it the way you would treat a password-reset token:
 *
 *   - Do not log it, put it in an error message, or include it in telemetry.
 *   - Do not shorten it or switch it to a shorter / sequential / derived id.
 *     `apId()` (`../ids`) is a 21-char nanoid over a 62-char alphabet, ~125
 *     bits, which is what makes guessing infeasible -- but it was chosen for
 *     id-format compatibility with vendored Activepieces code, not as a
 *     security decision, so the entropy is load-bearing by accident and the
 *     next person to touch `apId()` needs to know it.
 *   - Do not widen who can read one. It already reaches step output as
 *     `resumeUrl` and the dashboard via
 *     `GET /api/workflow-runs/:runId/waitpoints`; anything further is a new
 *     grant of resume rights.
 *
 * The resume route rate-limits unknown-id probes so guessing is not free
 * (see `WAITPOINT_RESUME_UNKNOWN_ID_PER_MINUTE` in `../../api/routes.ts`),
 * but that is a backstop for the entropy, not a replacement for it.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";
import { assertRunNotCanceled } from "../../runtime/cancellation";

export type WaitpointType = "WEBHOOK" | "TIMER" | "MANUAL";

interface WaitpointRow {
  id: string;
  flow_run_id: string;
  project_id: string;
  step_name: string;
  type: string;
  version: string;
  resume_date_time: string | null;
  response_to_send: string | null;
  worker_handler_id: string | null;
  http_request_id: string | null;
  created: number;
  resumed_at: number | null;
}

export interface Waitpoint {
  id: string;
  flowRunId: string;
  projectId: string;
  stepName: string;
  type: WaitpointType;
  version: string;
  resumeDateTime: string | null;
  responseToSend: Record<string, unknown> | null;
  workerHandlerId: string | null;
  httpRequestId: string | null;
  created: number;
  resumedAt: number | null;
}

export interface CreateWaitpointInput {
  flowRunId: string;
  projectId: string;
  stepName: string;
  type: WaitpointType;
  version?: string;
  resumeDateTime?: string;
  responseToSend?: Record<string, unknown>;
  workerHandlerId?: string;
  httpRequestId?: string;
}

function db(): Database {
  return getWorkflowDb();
}

function rowToWaitpoint(row: WaitpointRow): Waitpoint {
  return {
    id: row.id,
    flowRunId: row.flow_run_id,
    projectId: row.project_id,
    stepName: row.step_name,
    type: row.type as WaitpointType,
    version: row.version,
    resumeDateTime: row.resume_date_time,
    responseToSend: row.response_to_send ? (JSON.parse(row.response_to_send) as Record<string, unknown>) : null,
    workerHandlerId: row.worker_handler_id,
    httpRequestId: row.http_request_id,
    created: row.created,
    resumedAt: row.resumed_at,
  };
}

export function createWaitpoint(input: CreateWaitpointInput): Waitpoint {
  assertRunNotCanceled(input.flowRunId);
  const id = apId();
  const created = Date.now();
  db()
    .prepare(
      `INSERT INTO waitpoint
        (id, flow_run_id, project_id, step_name, type, version,
         resume_date_time, response_to_send, worker_handler_id, http_request_id, created, resumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.flowRunId,
      input.projectId,
      input.stepName,
      input.type,
      input.version ?? "V1",
      input.resumeDateTime ?? null,
      input.responseToSend ? JSON.stringify(input.responseToSend) : null,
      input.workerHandlerId ?? null,
      input.httpRequestId ?? null,
      created,
    );
  return {
    id,
    flowRunId: input.flowRunId,
    projectId: input.projectId,
    stepName: input.stepName,
    type: input.type,
    version: input.version ?? "V1",
    resumeDateTime: input.resumeDateTime ?? null,
    responseToSend: input.responseToSend ?? null,
    workerHandlerId: input.workerHandlerId ?? null,
    httpRequestId: input.httpRequestId ?? null,
    created,
    resumedAt: null,
  };
}

export function getWaitpoint(id: string): Waitpoint | null {
  const row = db()
    .prepare<WaitpointRow, [string]>(`SELECT * FROM waitpoint WHERE id = ?`)
    .get(id);
  return row ? rowToWaitpoint(row) : null;
}

/**
 * Return all waitpoints for a flow run, newest first. The dashboard's
 * paused-run callout reads from this so it can surface the actual resume
 * URL(s) to the user instead of pointing them to the steps JSON. `resumed`
 * flag controls filtering: `false` = only active (resumed_at IS NULL),
 * `true` = only resumed, `undefined` = both.
 */
export function listWaitpointsByFlowRun(
  flowRunId: string,
  resumed?: boolean,
): Waitpoint[] {
  const filter =
    resumed === undefined
      ? ""
      : resumed
        ? " AND resumed_at IS NOT NULL"
        : " AND resumed_at IS NULL";
  return db()
    .prepare<WaitpointRow, [string]>(
      `SELECT * FROM waitpoint WHERE flow_run_id = ?${filter} ORDER BY created DESC`,
    )
    .all(flowRunId)
    .map(rowToWaitpoint);
}

/**
 * Active TIMER waitpoints whose resume time has arrived (`resume_date_time <=
 * now`). Drives the TIMER scheduler (UPDATES.md) — a delay/wait step whose
 * timer elapsed (incl. during downtime) has no other resume trigger. ISO-8601
 * strings sort chronologically, so a lexical `<=` is a time comparison.
 * Exclude QUEUED/RUNNING runs before limiting the batch so pending engine
 * uploads cannot starve later PAUSED runs. Missing and terminal runs remain
 * eligible for the scheduler's waitpoint retirement.
 */
export function listDueTimerWaitpoints(nowIso: string, limit = 100): Waitpoint[] {
  return db()
    .prepare<WaitpointRow, [string, number]>(
      `SELECT * FROM waitpoint
       WHERE type = 'TIMER' AND resumed_at IS NULL
         AND resume_date_time IS NOT NULL AND resume_date_time <= ?
         AND NOT EXISTS (
           SELECT 1 FROM flow_run
           WHERE flow_run.id = waitpoint.flow_run_id
             AND flow_run.status IN ('QUEUED', 'RUNNING')
         )
       ORDER BY resume_date_time ASC LIMIT ?`,
    )
    .all(nowIso, limit)
    .map(rowToWaitpoint);
}

export function markWaitpointResumed(id: string, now = Date.now()): boolean {
  const r = db()
    .prepare(`UPDATE waitpoint SET resumed_at = ? WHERE id = ? AND resumed_at IS NULL`)
    .run(now, id);
  return r.changes > 0;
}

export function _clearWaitpointsForTests(): void {
  db().exec(`DELETE FROM waitpoint`);
}
