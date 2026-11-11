/**
 * Deleting a workflow and everything it left behind (#1149, #1154).
 *
 * Two paths delete a workflow: the Brief purge (brief/workflow-removal.ts,
 * which keeps a receipt and finishes on recovery) and the ordinary delete
 * (DELETE /api/workflows/:id and manage_workflow's `delete`), for a workflow
 * that was never removed. Both delete the same rows and files, from here.
 * Before #1154 the ordinary delete removed only the flow row and what its
 * foreign keys cascade to, and left run logs and step files on disk, the
 * workflow_file rows, the flow-scoped piece store keys, its jobs and open
 * failures, and the pending cards of runs that had already ended.
 *
 * Large histories go in batches (FLOW_DELETE_BATCH runs and trigger events
 * per transaction), each its own transaction on the daemon thread, with the
 * event loop let go between them. Measured: one cascading delete of a flow
 * with 50,000 runs of two effects each took 632 ms (10,000: 119 ms), all of
 * it with the event loop held; that is 12.6 us per run, so a batch of 1,000
 * holds it about 13 ms. Jobs that name their run only in their payload (an
 * older job shape) are matched by reading every such job's payload, once per
 * batch: review measured 44 ms per batch with 50,000 of them.
 *
 * Nothing is deleted while an effect of the flow is still being dispatched in
 * this process (runtime/effect-inflight.ts): its record, approval receipt and
 * audit row are written when it returns, and the delete would make those
 * writes fail on the missing run.
 */
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { getWorkflowDb } from "../index";
import { legacyWorkflowLogsBase, workflowFileBase, workflowLogsBase } from "../../sandbox-api/config";
import { effectDispatchInFlight, waitForEffectDispatches } from "../../runtime/effect-inflight";
import { stopRunsOfDeletedFlow } from "./flow-turn-off";
import { retireTerminalRunWaits } from "./run-cancellation";
import { assertFlowDeletable } from "./workflow-removal-state";

/** Runs (and, separately, trigger events) deleted per transaction. See the module comment. */
export const FLOW_DELETE_BATCH = 1000;

/**
 * How long the ordinary delete waits for the flow's in-flight effects to be
 * recorded before it answers `stopping` and deletes nothing (owner decision,
 * 2026-11-06). A stopped run's effects end at their next cancellation check;
 * one that does not within this is retried by the caller.
 */
export const FLOW_DELETE_WAIT_MS = 10_000;

export interface FlowDeleteCounts {
  versions: number;
  runs: number;
  removals: number;
  triggerEvents: number;
  files: number;
  jobs: number;
  storeEntries: number;
}

export const NO_COUNTS: FlowDeleteCounts = { versions: 0, runs: 0, removals: 0, triggerEvents: 0, files: 0, jobs: 0, storeEntries: 0 };

const safeId = (v: string) => /^[A-Za-z0-9_-]{1,200}$/.test(v);

/** Jobs of these runs (by column, or a legacy job's payload). `?1` is a JSON array of run ids. */
const JOBS_OF_RUNS = `FROM workflow_job WHERE flow_run_id IN (SELECT value FROM json_each(?1))
  OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END IN (SELECT value FROM json_each(?1)))`;

/** True when the flow has a run that is queued, running or paused. */
export function flowHasLiveRun(flowId: string, db: Database = getWorkflowDb()): boolean {
  return !!db.query("SELECT 1 FROM flow_run WHERE flow_id = ? AND status IN ('QUEUED','RUNNING','PAUSED') LIMIT 1").get(flowId);
}

/** True when the flow has more history than one transaction should delete. */
export function flowHistoryOverBatch(flowId: string, db: Database = getWorkflowDb()): boolean {
  const over = (table: string) => !!db.query(`SELECT 1 FROM ${table} WHERE flow_id = ? LIMIT 1 OFFSET ?`).get(flowId, FLOW_DELETE_BATCH);
  return over("flow_run") || over("trigger_event");
}

/**
 * Delete up to FLOW_DELETE_BATCH of the flow's runs (with what cascades from
 * them, and their jobs) and of its trigger events. The caller holds the
 * transaction and the decision that the flow may go. Returns the run ids,
 * whose files the caller removes after commit.
 */
export function deleteFlowHistoryBatch(flowId: string, db: Database = getWorkflowDb()): { runIds: string[]; counts: FlowDeleteCounts } {
  const runIds = db.query<{ id: string }, [string, number]>("SELECT id FROM flow_run WHERE flow_id = ? LIMIT ?")
    .all(flowId, FLOW_DELETE_BATCH).map((r) => r.id);
  const ids = JSON.stringify(runIds);
  const jobs = db.run(`DELETE ${JOBS_OF_RUNS}`, [ids]).changes;
  if (runIds.length > 0) db.run("DELETE FROM flow_run WHERE id IN (SELECT value FROM json_each(?))", [ids]);
  const triggerEvents = db.run(
    "DELETE FROM trigger_event WHERE rowid IN (SELECT rowid FROM trigger_event WHERE flow_id = ? LIMIT ?)",
    [flowId, FLOW_DELETE_BATCH],
  ).changes;
  return { runIds, counts: { ...NO_COUNTS, runs: runIds.length, triggerEvents, jobs } };
}

/**
 * Delete the flow itself and everything else it owns: its remaining runs,
 * versions, trigger events and slot (by cascade), jobs, flow-scoped store
 * keys, step-file rows, open failures, saved dashboard notifications and
 * removal receipts. The caller holds
 * the transaction; receipts go only under a purge's grant (the schema's
 * fences refuse it otherwise). Returns false, deleting nothing, if no flow of
 * that id is in that project.
 */
export function deleteFlowRows(flowId: string, projectId: string, db: Database = getWorkflowDb()):
  { deleted: false } | { deleted: true; runIds: string[]; counts: FlowDeleteCounts } {
  if (!db.query("SELECT 1 FROM flow WHERE id = ? AND project_id = ?").get(flowId, projectId)) return { deleted: false };
  const count = (sql: string, ...more: string[]) => (db.query(sql).get(flowId, ...more) as { n: number }).n;
  const runs = `SELECT id FROM flow_run WHERE flow_id = ?1`;
  // Every job of the flow or its runs: the caller made sure no run is live.
  const jobs = `FROM workflow_job WHERE (flow_id = ?1 OR flow_run_id IN (${runs})
    OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END IN (${runs})))`;
  // FLOW-scoped piece store keys, as the engine writes them (piece-context/store.ts).
  const store = `FROM store_entry WHERE project_id = ?2 AND (substr(key, 1, length('flow_' || ?1 || '/')) = 'flow_' || ?1 || '/'
    OR substr(key, 1, length('testflow_' || ?1 || '/')) = 'testflow_' || ?1 || '/')`;
  const counts: FlowDeleteCounts = {
    versions: count("SELECT COUNT(*) AS n FROM flow_version WHERE flow_id = ?1"),
    runs: count("SELECT COUNT(*) AS n FROM flow_run WHERE flow_id = ?1"),
    removals: count("SELECT COUNT(*) AS n FROM brief_workflow_removals WHERE flow_id = ?1"),
    triggerEvents: count("SELECT COUNT(*) AS n FROM trigger_event WHERE flow_id = ?1"),
    files: count("SELECT COUNT(*) AS n FROM workflow_file WHERE flow_id = ?1"),
    jobs: count(`SELECT COUNT(*) AS n ${jobs}`),
    storeEntries: count(`SELECT COUNT(*) AS n ${store}`, projectId),
  };
  const runIds = db.query<{ id: string }, [string]>("SELECT id FROM flow_run WHERE flow_id = ?").all(flowId).map((r) => r.id);
  db.run(`DELETE ${jobs}`, [flowId]);
  db.run(`DELETE ${store}`, [flowId, projectId]);
  db.run("DELETE FROM workflow_file WHERE flow_id = ?", [flowId]);
  db.run("DELETE FROM open_failure WHERE flow_id = ?", [flowId]);
  // Its saved dashboard notifications (#1344): a deleted workflow's messages
  // leave the owner's Needs you list with it.
  db.run("DELETE FROM dashboard_notifications WHERE workflow_id = ?", [flowId]);
  // The receipts' foreign key requires them gone before the flow.
  db.run("DELETE FROM brief_workflow_removals WHERE flow_id = ?", [flowId]);
  // Versions, runs, effects, waitpoints, trigger events and the slot cascade.
  if (db.run("DELETE FROM flow WHERE id = ? AND project_id = ?", [flowId, projectId]).changes === 0) throw new Error("flow_delete_missing");
  return { deleted: true, runIds, counts };
}

export function addCounts(a: FlowDeleteCounts, b: FlowDeleteCounts): FlowDeleteCounts {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof FlowDeleteCounts>) out[k] += b[k] ?? 0;
  return out;
}

/** The engine's execution-state backups of these runs, kept beside the database. Throws on a disk fault. */
export function removeRunFiles(runIds: readonly string[]): void {
  for (const runId of runIds) if (safeId(runId)) for (const base of new Set([workflowLogsBase(), legacyWorkflowLogsBase()])) rmSync(resolve(base, `${runId}.bin`), { force: true });
}

/** The disk copies of the flow's step files. Throws on a disk fault. */
export function removeFlowFiles(flowId: string): void {
  if (safeId(flowId)) rmSync(resolve(workflowFileBase(), flowId), { recursive: true, force: true });
}

/**
 * Stop the flow's live runs and close the cards and waits of runs that ended
 * before they parked (#1039): the delete would otherwise remove a run whose
 * card stays approvable. Call outside any transaction.
 */
export function stopEverythingOfFlow(flowId: string, onCardClosed?: (approvalId: string) => void, db: Database = getWorkflowDb()): void {
  stopRunsOfDeletedFlow(flowId, onCardClosed);
  for (const { id } of db.query<{ id: string }, [string]>(`SELECT r.id FROM flow_run r WHERE r.flow_id = ?
    AND r.status NOT IN ('QUEUED','RUNNING','PAUSED') AND (
      EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id = r.id AND e.status = 'pending')
      OR EXISTS (SELECT 1 FROM waitpoint w WHERE w.flow_run_id = r.id AND w.resumed_at IS NULL))`).all(flowId)) {
    const closed = retireTerminalRunWaits(id);
    if (onCardClosed) closed.forEach(onCardClosed);
  }
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Who hears each workflow card a delete closes, so the dashboard stops
 * offering it, as the Brief purge's `onCardClosed` does (#1039). Set once by
 * the daemon for the live database, so every caller of `deleteWorkflow` (the
 * dashboard route, manage_workflow) is covered without passing it.
 */
const cardClosedListeners = new WeakMap<Database, (approvalId: string) => void>();
export function setDeletedWorkflowCardListener(listener: ((approvalId: string) => void) | null, db: Database = getWorkflowDb()): void {
  if (listener) cardClosedListeners.set(db, listener);
  else cardClosedListeners.delete(db);
}

export type FlowDeleteOutcome =
  | { status: "deleted"; counts: FlowDeleteCounts }
  | { status: "not_found" }
  /**
   * An effect of the flow was still being dispatched when the wait ran out.
   * The flow is still there, turned off (with part of a large history
   * possibly gone); deleting it again finishes the job.
   */
  | { status: "stopping" };

/**
 * The ordinary delete of a workflow that was never removed in Brief
 * (`workflow_history_retained` otherwise, from assertFlowDeletable). Stops
 * its runs, waits up to `waitMs` for its in-flight effects to be recorded,
 * then deletes in batches and finally the flow, and removes its files.
 *
 * Each batch re-checks that the flow may still go, so a Brief removal that
 * lands meanwhile stops the delete with its history intact up to that batch,
 * and that no effect is in flight and no run is live: a run started since the
 * stop (the flow stays on while it is deleted) is stopped, and its effects
 * waited for, before anything of it goes. That wait counts against the same
 * `waitMs`.
 * A delete interrupted between batches leaves the flow with part of its run
 * history; deleting it again finishes the job.
 */
export async function deleteWorkflow(
  projectId: string,
  flowId: string,
  opts: { onCardClosed?: (approvalId: string) => void; waitMs?: number } = {},
): Promise<FlowDeleteOutcome> {
  const db = getWorkflowDb();
  const inProject = () => !!db.query("SELECT 1 FROM flow WHERE id = ? AND project_id = ?").get(flowId, projectId);
  if (!inProject()) return { status: "not_found" };
  const listener = opts.onCardClosed ?? cardClosedListeners.get(db);
  // A listener that fails must not stop the delete half way.
  const onCardClosed = listener && ((approvalId: string) => {
    try { listener(approvalId); } catch (error) { console.error("[Workflow Delete] closed card update failed:", error); }
  });
  assertFlowDeletable(flowId);
  // Turned off first, as the purge does at acceptance: no trigger starts a
  // run while the delete waits or works through batches, and a delete that
  // ends `stopping` leaves the workflow off rather than on with its runs
  // stopped as deleted. The caller refreshes its triggers either way.
  const ts = Date.now();
  db.run(`UPDATE flow SET status = 'DISABLED', disabled_at = COALESCE(disabled_at, ?), updated = ?
    WHERE id = ? AND project_id = ? AND status <> 'DISABLED'`, [ts, ts, flowId, projectId]);
  const deadline = Date.now() + (opts.waitMs ?? FLOW_DELETE_WAIT_MS);
  let counts = { ...NO_COUNTS };
  for (;;) {
    stopEverythingOfFlow(flowId, onCardClosed, db);
    if (!(await waitForEffectDispatches(flowId, deadline - Date.now()))) return { status: "stopping" };
    // Batches while the history is large. Each is its own transaction, and
    // nothing is deleted while an effect is in flight (one may have started
    // during the wait above or a previous batch).
    let blocked = false;
    while (flowHistoryOverBatch(flowId, db)) {
      const batch = db.transaction(() => {
        if (!inProject()) return null;
        assertFlowDeletable(flowId);
        // A run started since the stop above (a trigger fired during the
        // wait, say) is stopped before anything of it goes.
        if (effectDispatchInFlight(flowId) || flowHasLiveRun(flowId, db)) return "blocked" as const;
        return deleteFlowHistoryBatch(flowId, db);
      }).immediate();
      if (batch === null) return { status: "not_found" };
      if (batch === "blocked") {
        blocked = true;
        break;
      }
      counts = addCounts(counts, batch.counts);
      try {
        removeRunFiles(batch.runIds);
      } catch (error) {
        console.error("[Workflow Delete] run files could not all be removed:", error);
      }
      await yieldToEventLoop();
    }
    if (blocked) continue;
    const last = db.transaction(() => {
      assertFlowDeletable(flowId);
      if (effectDispatchInFlight(flowId) || flowHasLiveRun(flowId, db)) return "blocked" as const;
      return deleteFlowRows(flowId, projectId, db);
    }).immediate();
    if (last === "blocked") continue;
    if (!last.deleted) return { status: "not_found" };
    counts = addCounts(counts, last.counts);
    try {
      removeRunFiles(last.runIds);
      removeFlowFiles(flowId);
    } catch (error) {
      console.error("[Workflow Delete] files of a deleted workflow could not all be removed:", error);
    }
    return { status: "deleted", counts };
  }
}
