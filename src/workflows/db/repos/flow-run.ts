/**
 * `flow_run` repository: one row per execution, written by the worker as the
 * run progresses. `steps` is a JSON map keyed by step name with each step's
 * input/output/status, mirroring activepieces' run shape.
 *
 * Status enum mirrors `FlowRunStatus` from
 * src/workflows/activepieces/packages/shared/src/lib/automation/flow-run/execution/flow-execution.ts
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";

export type FlowRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "QUOTA_EXCEEDED"
  | "STOPPED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "SCHEDULE_FAILURE";

export type RunEnvironment = "PRODUCTION" | "TESTING";

export interface FlowRunRow {
  id: string;
  flow_id: string;
  flow_version_id: string;
  project_id: string;
  parent_run_id: string | null;
  fail_parent_on_failure: number;
  triggered_by: string | null;
  status: FlowRunStatus;
  environment: RunEnvironment;
  steps: string | null;
  failed_step: string | null;
  step_name_to_test: string | null;
  start_time: number | null;
  finish_time: number | null;
  archived_at: number | null;
  steps_count: number | null;
  logs_file_id: string | null;
  tags: string | null;
  created: number;
  updated: number;
}

export interface FailedStep {
  name: string;
  displayName: string;
  /**
   * Engine-side error detail. Set by the activepieces engine via
   * `WorkerContract.uploadRunLog` when a piece action throws or returns a
   * failure. Surfaced by `EngineFlowExecutor` in `FlowExecutionError`'s
   * message so the run-history panel can show the actual error string.
   */
  errorMessage?: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowVersionId: string;
  projectId: string;
  parentRunId: string | null;
  failParentOnFailure: boolean;
  triggeredBy: string | null;
  status: FlowRunStatus;
  environment: RunEnvironment;
  steps: Record<string, unknown> | null;
  failedStep: FailedStep | null;
  stepNameToTest: string | null;
  startTime: number | null;
  finishTime: number | null;
  archivedAt: number | null;
  stepsCount: number | null;
  logsFileId: string | null;
  tags: string[] | null;
  created: number;
  updated: number;
}

export interface CreateFlowRunInput {
  flowId: string;
  flowVersionId: string;
  projectId?: string;
  parentRunId?: string | null;
  failParentOnFailure?: boolean;
  triggeredBy?: string;
  environment?: RunEnvironment;
  status?: FlowRunStatus;
  startTime?: number;
  stepNameToTest?: string;
  tags?: string[];
}

export interface UpdateRunInput {
  status?: FlowRunStatus;
  steps?: Record<string, unknown> | null;
  failedStep?: FailedStep | null;
  finishTime?: number;
  startTime?: number;
  stepsCount?: number;
  logsFileId?: string | null;
}

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

function rowToRun(row: FlowRunRow): FlowRun {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowVersionId: row.flow_version_id,
    projectId: row.project_id,
    parentRunId: row.parent_run_id,
    failParentOnFailure: row.fail_parent_on_failure !== 0,
    triggeredBy: row.triggered_by,
    status: row.status,
    environment: row.environment,
    steps: row.steps ? (JSON.parse(row.steps) as Record<string, unknown>) : null,
    failedStep: row.failed_step ? (JSON.parse(row.failed_step) as FailedStep) : null,
    stepNameToTest: row.step_name_to_test,
    startTime: row.start_time,
    finishTime: row.finish_time,
    archivedAt: row.archived_at,
    stepsCount: row.steps_count,
    logsFileId: row.logs_file_id,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
    created: row.created,
    updated: row.updated,
  };
}

export function createFlowRun(input: CreateFlowRunInput): FlowRun {
  const id = apId();
  const ts = now();
  db().run(
    `INSERT INTO flow_run (
      id, flow_id, flow_version_id, project_id, parent_run_id, fail_parent_on_failure,
      triggered_by, status, environment, start_time, step_name_to_test, tags, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.flowId,
      input.flowVersionId,
      input.projectId ?? DEFAULT_IDS.project,
      input.parentRunId ?? null,
      input.failParentOnFailure ? 1 : 0,
      input.triggeredBy ?? null,
      input.status ?? "QUEUED",
      input.environment ?? "PRODUCTION",
      input.startTime ?? null,
      input.stepNameToTest ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      ts,
      ts,
    ],
  );
  const row = getFlowRunRow(id);
  if (!row) throw new Error(`createFlowRun: row missing after insert (id=${id})`);
  return rowToRun(row);
}

function getFlowRunRow(id: string): FlowRunRow | null {
  return db()
    .query<FlowRunRow, [string]>(`SELECT * FROM flow_run WHERE id = ?`)
    .get(id);
}

export function getFlowRun(id: string): FlowRun | null {
  const row = getFlowRunRow(id);
  return row ? rowToRun(row) : null;
}

export function updateRun(id: string, patch: UpdateRunInput): FlowRun {
  const existing = getFlowRunRow(id);
  if (!existing) throw new Error(`updateRun: not found (id=${id})`);
  const next: FlowRunRow = {
    ...existing,
    status: patch.status ?? existing.status,
    steps:
      patch.steps !== undefined
        ? patch.steps
          ? JSON.stringify(patch.steps)
          : null
        : existing.steps,
    failed_step:
      patch.failedStep !== undefined
        ? patch.failedStep
          ? JSON.stringify(patch.failedStep)
          : null
        : existing.failed_step,
    finish_time: patch.finishTime !== undefined ? patch.finishTime : existing.finish_time,
    start_time: patch.startTime !== undefined ? patch.startTime : existing.start_time,
    steps_count: patch.stepsCount !== undefined ? patch.stepsCount : existing.steps_count,
    logs_file_id:
      patch.logsFileId !== undefined ? patch.logsFileId : existing.logs_file_id,
    updated: now(),
  };
  db().run(
    `UPDATE flow_run SET
       status = ?, steps = ?, failed_step = ?, finish_time = ?, start_time = ?,
       steps_count = ?, logs_file_id = ?, updated = ?
     WHERE id = ?`,
    [
      next.status,
      next.steps,
      next.failed_step,
      next.finish_time,
      next.start_time,
      next.steps_count,
      next.logs_file_id,
      next.updated,
      id,
    ],
  );
  return rowToRun(next);
}

export interface ListRunsOptions {
  flowId?: string;
  status?: FlowRunStatus;
  limit?: number;
  offset?: number;
}

export function listRuns(opts: ListRunsOptions = {}): FlowRun[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // Manually compose a small WHERE clause; flow_id and status are the only filters.
  if (opts.flowId !== undefined && opts.status !== undefined) {
    return db()
      .query<FlowRunRow, [string, FlowRunStatus, number, number]>(
        `SELECT * FROM flow_run WHERE flow_id = ? AND status = ? ORDER BY created DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.flowId, opts.status, limit, offset)
      .map(rowToRun);
  }
  if (opts.flowId !== undefined) {
    return db()
      .query<FlowRunRow, [string, number, number]>(
        `SELECT * FROM flow_run WHERE flow_id = ? ORDER BY created DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.flowId, limit, offset)
      .map(rowToRun);
  }
  if (opts.status !== undefined) {
    return db()
      .query<FlowRunRow, [FlowRunStatus, number, number]>(
        `SELECT * FROM flow_run WHERE status = ? ORDER BY created DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.status, limit, offset)
      .map(rowToRun);
  }
  return db()
    .query<FlowRunRow, [number, number]>(
      `SELECT * FROM flow_run ORDER BY created DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset)
    .map(rowToRun);
}
