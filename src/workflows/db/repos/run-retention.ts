/**
 * How long finished workflow runs are kept.
 *
 * Nothing used to remove a run: about 6.7 KB of database rows and run-log file
 * for every run, for good, and every finished job row kept the full copy of the
 * payload that started it. The owner's default is unchanged: run history is
 * kept forever until they choose otherwise ("Keep run history for" in Brief
 * Settings). When they do, a daily sweep deletes FINISHED runs older than that,
 * with their log files and jobs.
 *
 * What a sweep never touches, whatever the age:
 *   - a run that is queued, running or paused, or has an unresolved waitpoint;
 *   - an effect still pending or dispatching;
 *   - a run an open or approved-but-unreceipted approval card names, or one
 *     whose decision document is kept for review;
 *   - a run still on Today's list of failures to deal with (`open_failure`);
 *   - a run that is the child of a live run, or has a live child, or whose
 *     sub-workflow call has no result yet;
 *   - a run a planned task points at (`commitment_work`).
 * The approvals' own rows (the Authority history) and audit rows are not run
 * history and stay.
 *
 * Separately, and whatever the setting: the payload copy that a finished job
 * row keeps (a webhook body, a manual run's input, sample data) is queue
 * bookkeeping, not history. It is dropped after JOB_PAYLOAD_KEEP_DAYS for jobs
 * of runs that have ended. A job of a live run keeps it: an upgrade-recovery
 * path reads the original BEGIN payload of a paused run.
 */
import type { Database } from "bun:sqlite";
import { opendir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getWorkflowDb } from "../index";
import { ENDED_RUN_STATUSES_SQL } from "../schema";
import { workflowLogsBase } from "../../sandbox-api/config";
import { getSetting, setSetting } from "../../../vault/settings";

export const RUN_HISTORY_KEEP_VALUES = ["forever", "1y", "90d", "30d"] as const;
export type RunHistoryKeep = (typeof RUN_HISTORY_KEEP_VALUES)[number];
export const RUN_HISTORY_KEEP_DAYS: Record<RunHistoryKeep, number | null> = { forever: null, "1y": 365, "90d": 90, "30d": 30 };
export const RUN_HISTORY_SETTING_KEY = "workflow.run_history_keep";
/** A finished job's payload copy is dropped after this many days, whatever the setting. */
export const JOB_PAYLOAD_KEEP_DAYS = 7;
/** Runs deleted per transaction, so the event loop is let go between batches. */
export const RETENTION_BATCH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE = "('QUEUED','RUNNING','PAUSED')";
const safeId = (v: string) => /^[A-Za-z0-9_-]{1,200}$/.test(v);

export function isRunHistoryKeep(value: unknown): value is RunHistoryKeep {
  return typeof value === "string" && (RUN_HISTORY_KEEP_VALUES as readonly string[]).includes(value);
}

/** The owner's choice. Anything missing or unreadable is "forever": a typo never deletes. */
export function getRunHistoryKeep(): RunHistoryKeep {
  try {
    const stored = getSetting(RUN_HISTORY_SETTING_KEY);
    return isRunHistoryKeep(stored) ? stored : "forever";
  } catch { return "forever"; }
}

export function setRunHistoryKeep(keep: RunHistoryKeep): void {
  setSetting(RUN_HISTORY_SETTING_KEY, keep);
}

const hasTable = (db: Database, name: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * The SQL of "this finished run may be deleted", for runs older than `?1`
 * (epoch ms). Clauses on tables that do not exist in this database (the
 * vault's, in a workflow-only test) are left out.
 */
function eligibleSql(db: Database): string {
  const parts = [
    `r.status IN ${ENDED_RUN_STATUSES_SQL}`,
    `COALESCE(r.finish_time, r.updated) < ?1`,
    `NOT EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id = r.id AND e.status IN ('pending','dispatching'))`,
    `NOT EXISTS (SELECT 1 FROM waitpoint w WHERE w.flow_run_id = r.id AND w.resumed_at IS NULL)`,
    `NOT EXISTS (SELECT 1 FROM workflow_job j WHERE j.flow_run_id = r.id AND j.status IN ('QUEUED','RUNNING'))`,
    `NOT EXISTS (SELECT 1 FROM flow_run c WHERE c.parent_run_id = r.id AND c.status IN ${LIVE})`,
    `(r.parent_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM flow_run p WHERE p.id = r.parent_run_id AND p.status IN ${LIVE}))`,
    `NOT EXISTS (SELECT 1 FROM workflow_subflow_call s WHERE s.child_run_id = r.id AND s.result_json IS NULL)`,
  ];
  if (hasTable(db, "open_failure")) parts.push(`NOT EXISTS (SELECT 1 FROM open_failure f WHERE f.run_id = r.id)`);
  if (hasTable(db, "approval_requests")) {
    const document = hasTable(db, "brief_decision_document")
      ? ` OR EXISTS (SELECT 1 FROM brief_decision_document d WHERE d.approval_id = a.id)` : "";
    parts.push(`NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.agent_id = 'workflow:' || r.id
      AND (a.status IN ('pending','approved')${document}))`);
  }
  if (hasTable(db, "commitment_work")) parts.push(`NOT EXISTS (SELECT 1 FROM commitment_work cw WHERE cw.run_id = r.id)`);
  return parts.join("\n    AND ");
}

/** Jobs of these runs (by column, or an older job's payload). `?1` is a JSON array of run ids. */
const JOBS_OF_RUNS = `FROM workflow_job WHERE flow_run_id IN (SELECT value FROM json_each(?1))
  OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END IN (SELECT value FROM json_each(?1)))`;

/** How many finished runs a sweep with this setting would delete now. */
export function countRunsToPrune(keep: RunHistoryKeep, now = Date.now(), db: Database = getWorkflowDb()): number {
  const days = RUN_HISTORY_KEEP_DAYS[keep];
  if (days === null) return 0;
  return (db.query(`SELECT COUNT(*) AS n FROM flow_run r WHERE ${eligibleSql(db)}`).get(now - days * DAY_MS) as { n: number }).n;
}

export interface PruneResult { runs: number; jobs: number; files: number }

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Delete finished runs older than the setting, in batches with the event loop
 * let go between them, then their log files. Safe to run twice at once only
 * because each batch re-selects: a second caller finds nothing left to take.
 */
export async function pruneRunHistory(keep: RunHistoryKeep, now = Date.now(), db: Database = getWorkflowDb()): Promise<PruneResult> {
  const total: PruneResult = { runs: 0, jobs: 0, files: 0 };
  const days = RUN_HISTORY_KEEP_DAYS[keep];
  if (days === null) return total;
  const cutoff = now - days * DAY_MS;
  for (;;) {
    const sql = eligibleSql(db);
    const batch = db.transaction((): { runIds: string[]; jobs: number } => {
      const runIds = db.query<{ id: string }, [number, number]>(
        `SELECT r.id FROM flow_run r WHERE ${sql} ORDER BY COALESCE(r.finish_time, r.updated) LIMIT ?2`).all(cutoff, RETENTION_BATCH).map((r) => r.id);
      if (runIds.length === 0) return { runIds, jobs: 0 };
      const ids = JSON.stringify(runIds);
      const jobs = db.run(`DELETE ${JOBS_OF_RUNS}`, [ids]).changes;
      // Effects, waitpoints, human waits, delegations and the rest cascade.
      db.run("DELETE FROM flow_run WHERE id IN (SELECT value FROM json_each(?))", [ids]);
      return { runIds, jobs };
    }).immediate();
    if (batch.runIds.length === 0) break;
    total.runs += batch.runIds.length;
    total.jobs += batch.jobs;
    // After the commit: a file left behind by a failed delete is only disk, never history.
    for (const runId of batch.runIds) {
      if (!safeId(runId)) continue;
      try { await rm(resolve(workflowLogsBase(), `${runId}.bin`), { force: true }); total.files++; } catch { /* disk fault: the row is gone, the file is just space */ }
    }
    await yieldToEventLoop();
  }
  if (total.runs > 0) logBytesCache = null; // the size shown must not count what was just deleted
  return total;
}

/**
 * Drop the payload copy from finished job rows of ended runs (or of no run),
 * after JOB_PAYLOAD_KEEP_DAYS. Keeps the run id, execution type and waitpoint
 * the queue's own queries read. Returns how many rows were slimmed.
 */
export function pruneJobPayloads(now = Date.now(), db: Database = getWorkflowDb()): number {
  const cutoff = now - JOB_PAYLOAD_KEEP_DAYS * DAY_MS;
  return db.run(
    `UPDATE workflow_job SET payload = json_remove(payload, '$.payload', '$.sampleData', '$.sampleInputOverride', '$.resumePayload')
     WHERE status IN ('SUCCEEDED','FAILED','CANCELED') AND updated < ?1 AND json_valid(payload)
       AND (json_type(payload, '$.payload') IS NOT NULL OR json_type(payload, '$.sampleData') IS NOT NULL
            OR json_type(payload, '$.sampleInputOverride') IS NOT NULL OR json_type(payload, '$.resumePayload') IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM flow_run r WHERE r.status IN ${LIVE}
            AND r.id = COALESCE(workflow_job.flow_run_id, CASE WHEN json_valid(workflow_job.payload) THEN json_extract(workflow_job.payload, '$.runId') END))`,
    [cutoff],
  ).changes;
}

export interface RunHistorySummary {
  runs: number;
  oldestAt: number | null;
  /** Database rows kept for run history, in bytes: an estimate from the stored text. */
  dataBytes: number;
  /** Run-log files on disk, in bytes. */
  logBytes: number;
  bytes: number;
}

const SIZE_CACHE_MS = 30_000;
let logBytesCache: { at: number; bytes: number } | null = null;

/** Total size of the run-log files, counted without holding the event loop. Cached briefly. */
export async function runLogBytes(now = Date.now()): Promise<number> {
  if (logBytesCache && now - logBytesCache.at < SIZE_CACHE_MS) return logBytesCache.bytes;
  let bytes = 0;
  try {
    const dir = await opendir(workflowLogsBase());
    let pending: Promise<number>[] = [];
    const flush = async () => { for (const size of await Promise.all(pending)) bytes += size; pending = []; };
    for await (const entry of dir) {
      if (!entry.isFile()) continue;
      pending.push(stat(resolve(workflowLogsBase(), entry.name)).then((s) => s.size, () => 0));
      if (pending.length >= 256) await flush();
    }
    await flush();
  } catch { /* no log directory yet: nothing kept */ }
  logBytesCache = { at: Date.now(), bytes };
  return bytes;
}

/** Test hook: forget the cached log size. */
export function resetRunHistorySizeCache(): void { logBytesCache = null; }

export async function runHistorySummary(db: Database = getWorkflowDb()): Promise<RunHistorySummary> {
  const row = db.query(`SELECT COUNT(*) AS runs, MIN(created) AS oldest,
      COALESCE(SUM(length(COALESCE(steps,'')) + length(COALESCE(execution_config,'')) + length(COALESCE(tags,''))), 0) AS bytes FROM flow_run`).get() as
    { runs: number; oldest: number | null; bytes: number };
  const jobs = db.query("SELECT COALESCE(SUM(length(payload)), 0) AS bytes FROM workflow_job").get() as { bytes: number };
  const effects = db.query("SELECT COALESCE(SUM(length(record)), 0) AS bytes FROM workflow_effect").get() as { bytes: number };
  const dataBytes = row.bytes + jobs.bytes + effects.bytes;
  const logBytes = await runLogBytes();
  return { runs: row.runs, oldestAt: row.oldest, dataBytes, logBytes, bytes: dataBytes + logBytes };
}

/**
 * The daily clean-up. Reads the setting each time, so a change applies without
 * a restart. The job-payload step runs whatever the setting is. Returns a stop
 * function.
 */
export function startRunHistoryRetention(
  opts: { firstDelayMs?: number; intervalMs?: number; log?: (line: string) => void } = {},
): () => void {
  const log = opts.log ?? ((line: string) => console.log(line));
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const slimmed = pruneJobPayloads();
      if (slimmed > 0) log(`[Retention] Dropped the stored input of ${slimmed} finished job(s) older than ${JOB_PAYLOAD_KEEP_DAYS} days`);
      const keep = getRunHistoryKeep();
      if (keep !== "forever") {
        const result = await pruneRunHistory(keep);
        if (result.runs > 0) log(`[Retention] Deleted ${result.runs} finished run(s) older than ${RUN_HISTORY_KEEP_DAYS[keep]} days`);
      }
    } catch (err) {
      console.error("[Retention] Run history sweep failed:", err);
    } finally { running = false; }
  };
  const first = setTimeout(() => void sweep(), opts.firstDelayMs ?? 120_000);
  const timer = setInterval(() => void sweep(), opts.intervalMs ?? DAY_MS);
  (first as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
