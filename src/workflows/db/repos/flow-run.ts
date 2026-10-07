/**
 * `flow_run` repository: one row per execution, written by the worker as the
 * run progresses. `steps` is a JSON map keyed by step name with each step's
 * input/output/status, mirroring activepieces' run shape.
 *
 * Status enum mirrors `FlowRunStatus` from
 * src/workflows/activepieces/packages/shared/src/lib/automation/flow-run/execution/flow-execution.ts
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getRunCancellation, type RunCancellation } from "./run-cancellation";
import { getRunMachineBinding, type RunMachineBinding } from "./run-machine-binding";
import { listRunConnectionBindings, type RunConnectionBinding } from "./binding-pins";
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

/** Immutable per-run preview scope and inputs, retained independently of queue history. */
export interface RunExecutionConfig {
  stepNameToTest?: string;
  sampleData?: Record<string, unknown>;
  sampleInputOverride?: Record<string, Record<string, unknown>>;
}

/** Freeze before the first engine invocation. RESUME never trusts its job's preview settings. */
export function ensureRunExecutionConfig(runId: string, initial?: RunExecutionConfig): RunExecutionConfig {
  return db().transaction(() => {
    const row = db().query('SELECT execution_config, step_name_to_test FROM flow_run WHERE id=?')
      .get(runId) as { execution_config: string | null; step_name_to_test: string | null } | null;
    if (!row) throw new Error(`Run ${runId} not found`);
    if (row.execution_config !== null) return JSON.parse(row.execution_config) as RunExecutionConfig;
    let source = initial;
    if (!source) {
      // Upgrade recovery for runs parked before this column existed. Only the original
      // BEGIN payload can supply the snapshot; live version samples may have changed.
      const job = db().query(`SELECT payload FROM workflow_job WHERE flow_run_id=? AND job_type='RUN_FLOW'
        AND COALESCE(json_extract(payload, '$.executionType'), 'BEGIN')='BEGIN' ORDER BY created, id LIMIT 1`)
        .get(runId) as { payload: string } | null;
      if (!job) throw new Error('Original run configuration unavailable; start a new run to preserve preview scope');
      source = JSON.parse(job.payload) as RunExecutionConfig;
    }
    if (row.step_name_to_test && source.stepNameToTest && row.step_name_to_test !== source.stepNameToTest) {
      throw new Error('Run preview scope does not match the original job');
    }
    const stepNameToTest = row.step_name_to_test ?? source.stepNameToTest;
    const config: RunExecutionConfig = {
      ...(stepNameToTest ? { stepNameToTest } : {}),
      ...(source.sampleData ? { sampleData: source.sampleData } : {}),
      ...(source.sampleInputOverride ? { sampleInputOverride: source.sampleInputOverride } : {}),
    };
    const snapshot = JSON.stringify(config);
    db().run('UPDATE flow_run SET execution_config=?, step_name_to_test=? WHERE id=?', [snapshot, stepNameToTest ?? null, runId]);
    return JSON.parse(snapshot) as RunExecutionConfig;
  })();
}

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
  execution_config: string | null;
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
  machineBinding: RunMachineBinding | null;
  /** Q-05: the connection identity the run used for each connection, and any fetch it refused. */
  connectionBindings: RunConnectionBinding[];
  cancellation: RunCancellation | null;
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
  finishTime?: number | null;
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
    machineBinding: getRunMachineBinding(row.id),
    connectionBindings: listRunConnectionBindings(row.id),
    cancellation: getRunCancellation(row.id),
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
  const cancellation = getRunCancellation(id);
  if (cancellation) {
    // Late engine/handler writes may enrich evidence but cannot revoke a
    // user's stop decision or erase outputs recorded before cancellation.
    const steps = { ...(existing.steps ? JSON.parse(existing.steps) : {}), ...(patch.steps ?? {}) };
    patch = { ...patch, status: "STOPPED", finishTime: cancellation.acknowledgedAt,
      steps, stepsCount: Math.max(existing.steps_count ?? 0, patch.stepsCount ?? 0, Object.keys(steps).length) };
  }
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

/**
 * A page of runs, newest first.
 *
 * ORDER BY `created DESC, rowid DESC`, and the tiebreak is the whole point
 * (#636). `created` is a millisecond timestamp with no uniqueness, so two runs
 * created in the same millisecond had no defined order between them.
 *
 * WHAT THAT ACTUALLY COST, measured rather than assumed, because the filed
 * symptom and the real one turned out not to be the same thing:
 *
 *   - THE LISTING WAS BACKWARDS for same-millisecond runs. With no tiebreak
 *     SQLite's sorter leaves equal keys in scan order, so `created DESC`
 *     returned a block of same-millisecond rows OLDEST first. A flow that
 *     enqueued 120 runs inside one millisecond showed the 50 OLDEST of them on
 *     the first page of a listing whose whole contract is "newest first". That
 *     is the reproducible defect, and it is what the tests pin.
 *   - SKIP AND REPEAT ACROSS PAGES, which the issue leads with, is NOT fixed by
 *     a tiebreak, and was not reproducible without one either: measured both
 *     ways on a static table, paging returns every row exactly once. What
 *     breaks OFFSET paging is a row inserted or deleted BETWEEN two page reads,
 *     and that is true under any total order -- a new newest-first row shifts
 *     every later row down by one, so page 2 repeats page 1's last entry. Only
 *     keyset pagination fixes that, and it needs the route to hand back a
 *     cursor. So this makes the order DEFINED; it does not make OFFSET paging
 *     concurrency-safe, and saying otherwise would be false comfort.
 *
 * The defined order is worth having on its own terms even so: SQL guarantees
 * nothing about equal keys, so the old query's page-to-page consistency was an
 * accident of this planner that an index on `created`, a spilled sort or a
 * version bump could take away silently.
 *
 * #609 is what made any of it matter: once `GET /api/workflows/:id/runs`
 * clamped `limit` to 100, paging became the only way to read past 100 runs.
 *
 * `rowid` rather than `id`, which is the other obvious tiebreak and is also
 * total (`id` is the PRIMARY KEY). `id` is `apId()`, i.e. nanoid, so ordering
 * by it would break same-millisecond ties at RANDOM -- total and stable, which
 * is all paging strictly needs, but it would replace today's de-facto
 * insertion order with noise in the listing a user reads. `flow_run` is an
 * ordinary rowid table (`id TEXT PRIMARY KEY`, not WITHOUT ROWID), so `rowid`
 * is unique, never reused while rows live, and ascends with insertion: it is
 * total AND chronological, which is what "newest first" is supposed to mean.
 *
 * ONE query rather than the four near-identical branches this replaces. The
 * four each carried their own copy of the ORDER BY, which is four places for a
 * tiebreak to be added to three of them. Only literal SQL fragments are
 * concatenated; every value stays a bound parameter.
 *
 * Still OFFSET paging, so cost stays O(offset) and there is no index on
 * `created` to help (`schema.ts` indexes `flow_id`, `status`, `project_id`,
 * `start_time`, `parent_run_id`). Unchanged by this, since the sort was a full
 * sort of the filtered set before too. Keyset pagination would fix both, and
 * wants the route to hand back a cursor -- which `rowid` is not meant to be,
 * so that is a separate change.
 */
export function listRuns(opts: ListRunsOptions = {}): FlowRun[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const filters: string[] = [];
  const args: SQLQueryBindings[] = [];
  if (opts.flowId !== undefined) {
    filters.push("flow_id = ?");
    args.push(opts.flowId);
  }
  if (opts.status !== undefined) {
    filters.push("status = ?");
    args.push(opts.status);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  return db()
    .query<FlowRunRow, SQLQueryBindings[]>(
      `SELECT * FROM flow_run${where} ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset)
    .map(rowToRun);
}
