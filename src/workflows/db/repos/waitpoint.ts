/**
 * `waitpoint` repository. Async pauses created by piece actions that call
 * `context.run.createWaitpoint()`. The flow run sits at PAUSED status until
 * the waitpoint resolves -- via timer, webhook, or explicit resume -- at
 * which point we enqueue RUN_FLOW(executionType=RESUME).
 *
 * The actual resume scheduling (cron tick for TIMER, webhook route for
 * WEBHOOK) is layered on later; this repo just records the row and exposes
 * lookup + lifecycle.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";

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

export function markWaitpointResumed(id: string, now = Date.now()): boolean {
  const r = db()
    .prepare(`UPDATE waitpoint SET resumed_at = ? WHERE id = ? AND resumed_at IS NULL`)
    .run(now, id);
  return r.changes > 0;
}

export function _clearWaitpointsForTests(): void {
  db().exec(`DELETE FROM waitpoint`);
}
