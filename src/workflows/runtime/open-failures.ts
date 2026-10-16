/**
 * Q-19: the failures Today shows in "Waiting on you": one row per failure
 * that needs the person, with the same sentence Runs shows, until it is
 * resolved or dismissed (owner decision). There is no time window.
 *
 * Runs are indexed as they finish (`open_failure`, a cursor over
 * flow_run.updated), so a poll reads only what finished since the last one
 * plus what is still open; history is never rescanned. Each open row is a
 * reference, read afresh, and leaves the index once it is settled:
 *
 * - A run that ended badly. One that changed nothing settles when a later run
 *   of the same workflow succeeds. One that may have taken effect settles only
 *   when its recovery is inspected (Q-07): a later success does not say what
 *   the earlier run did. A run stopped with nothing in flight is waiting on
 *   nobody. Repeats (a scheduled workflow failing the same way every hour)
 *   share one row, so one workflow cannot push the others out.
 * - A notify step that a channel did not confirm: the message may not have
 *   arrived, and Jarvis will not resend it on its own.
 * - A chat turn that failed after it may have acted (`failures/chat.ts`).
 */
import { getWorkflowDb } from '../db';
import { getFlowRun } from '../db/repos/flow-run';
import { getFlowVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { getWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { walkFlowNodes } from '../db/flow-graph';
import { projectFailure, type DeliveryResult, type UserFailure } from '../../failures/projection';
import { dismissChatFailures, listChatFailures } from '../../failures/chat';
import { getRunRecovery } from './recovery';
import { runFailure } from './run-failure';

export interface OpenFailure {
  failure: UserFailure;
  /** Every failure this row stands for; dismissing the row dismisses them all. */
  keys: string[];
  /** Earlier runs that failed the same way and are covered by this row. */
  repeats: number;
  source: 'run' | 'delivery' | 'chat';
  /** What it belongs to: the workflow's name, or "Chat". */
  title: string;
  flowId?: string;
  runId?: string;
  at: number;
}

const LIMIT = 20;
const ENDED_BADLY = ['FAILED', 'TIMEOUT', 'INTERNAL_ERROR', 'QUOTA_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'SCHEDULE_FAILURE', 'STOPPED'];
const FINISHED = ['SUCCEEDED', ...ENDED_BADLY];
const KEY = /^[0-9a-f]{32}$/u;
/** How far back the very first scan looks; after that, nothing ages out. */
const FIRST_SCAN_MS = 7 * 86_400_000;
/** Runs indexed per call; a backlog drains over the next polls. */
const SCAN_BATCH = 500;
/** Dismissals older than this are forgotten; by then their rows have long left the index. */
const DISMISSAL_KEEP_MS = 90 * 86_400_000;

/**
 * Runs whose `updated` is at or after the cursor, driven by that index alone.
 * A run still going is passed over: finishing moves its `updated` again.
 */
export const FINISHED_RUNS_SQL = `SELECT rowid AS rid, id, flow_id, status, updated FROM flow_run INDEXED BY idx_flow_run_updated
  WHERE updated >= ? ORDER BY updated, rowid LIMIT ?`;
/** One run's notify steps that a channel did not confirm. By run: unhinted, SQLite picks the status index, every succeeded effect ever. */
export const UNCONFIRMED_NOTICES_SQL = `SELECT id FROM workflow_effect INDEXED BY idx_workflow_effect_run
  WHERE run_id = ? AND status = 'succeeded' AND json_valid(record)
    AND json_extract(record, '$.route') = 'notify' AND json_type(record, '$.result.unknown') = 'array'
    AND json_array_length(record, '$.result.unknown') > 0`;

function dismissedKeys(now: number): Set<string> {
  const db = getWorkflowDb();
  db.run('DELETE FROM failure_dismissal WHERE dismissed_at < ?', [now - DISMISSAL_KEEP_MS]);
  return new Set((db.query('SELECT key FROM failure_dismissal').all() as Array<{ key: string }>).map(row => row.key));
}

/**
 * Index the runs that finished since the last call: each that ended badly,
 * and each notify step whose channel did not confirm. Idempotent.
 */
export function indexFinishedRuns(now = Date.now()): void {
  const db = getWorkflowDb();
  db.transaction(() => {
    const saved = db.query('SELECT updated, run_rowid FROM open_failure_scan WHERE id = 1').get() as { updated: number; run_rowid: number } | null;
    let updated = saved?.updated ?? now - FIRST_SCAN_MS, rowid = saved?.run_rowid ?? 0;
    const runs = (db.query(FINISHED_RUNS_SQL).all(updated, SCAN_BATCH) as
      Array<{ rid: number; id: string; flow_id: string; status: string; updated: number }>)
      .filter(run => run.updated > updated || run.rid > rowid);
    for (const run of runs) {
      updated = run.updated; rowid = run.rid;
      if (!FINISHED.includes(run.status)) continue;
      if (ENDED_BADLY.includes(run.status)) {
        db.run(`INSERT OR IGNORE INTO open_failure (key, source, run_id, flow_id, effect_id, at) VALUES (?, 'run', ?, ?, NULL, ?)`,
          [`run:${run.id}`, run.id, run.flow_id, run.updated]);
      }
      const notices = db.query(UNCONFIRMED_NOTICES_SQL).all(run.id) as Array<{ id: string }>;
      for (const { id } of notices) {
        db.run(`INSERT OR IGNORE INTO open_failure (key, source, run_id, flow_id, effect_id, at) VALUES (?, 'delivery', ?, ?, ?, ?)`,
          [`delivery:${id}`, run.id, run.flow_id, id, run.updated]);
      }
    }
    db.run(`INSERT INTO open_failure_scan (id, updated, run_rowid) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, run_rowid = excluded.run_rowid`, [updated, rowid]);
  })();
}

function succeededSince(flowId: string, created: number): boolean {
  return !!getWorkflowDb().query(`SELECT 1 FROM flow_run WHERE flow_id = ? AND status = 'SUCCEEDED' AND created > ? LIMIT 1`)
    .get(flowId, created);
}

type Workflow = { name: string; nodes: FlowTriggerNode[]; steps: Map<string, string> };
function workflowFor(versionId: string, cache: Map<string, Workflow>): Workflow {
  let entry = cache.get(versionId);
  if (!entry) {
    const version = getFlowVersion(versionId);
    const nodes = walkFlowNodes(version?.trigger);
    entry = { name: version?.displayName || 'A workflow', nodes, steps: new Map(nodes.map(node => [node.name, node.displayName || node.name])) };
    cache.set(versionId, entry);
  }
  return entry;
}

function unconfirmedDelivery(effect: WorkflowEffect): Array<{ channel: string; result: DeliveryResult; error?: string }> | null {
  if (effect.route !== 'notify' || effect.status !== 'succeeded') return null;
  const report = effect.result as { delivered?: unknown; failed?: unknown; unknown?: unknown } | null | undefined;
  if (!report || !Array.isArray(report.unknown) || report.unknown.length === 0) return null;
  const entries = (list: unknown, result: DeliveryResult) => (Array.isArray(list) ? list : [])
    .map(item => typeof item === 'string' ? { channel: item, result }
      : item && typeof item === 'object' && typeof (item as { channel?: unknown }).channel === 'string'
        ? { channel: (item as { channel: string }).channel, result, ...(typeof (item as { error?: unknown }).error === 'string' ? { error: (item as { error: string }).error } : {}) }
        : null)
    .filter((item): item is { channel: string; result: DeliveryResult; error?: string } => item !== null);
  return [...entries(report.delivered, 'delivered'), ...entries(report.failed, 'failed'), ...entries(report.unknown, 'unknown')];
}

export function listOpenFailures(now = Date.now(), projectId?: string): OpenFailure[] {
  indexFinishedRuns(now);
  const db = getWorkflowDb();
  const dismissed = dismissedKeys(now);
  const workflows = new Map<string, Workflow>();
  const rows: OpenFailure[] = [];
  const groups = new Map<string, OpenFailure>();
  const settled: string[] = [];

  // The owning flow is authoritative, including for legacy run project columns.
  const open = db.query(`SELECT key, source, run_id, effect_id FROM open_failure
    ${projectId === undefined ? '' : 'WHERE flow_id IN (SELECT id FROM flow WHERE project_id = ?)'} ORDER BY at DESC, key`)
    .all(...(projectId === undefined ? [] : [projectId])) as Array<{ key: string; source: 'run' | 'delivery'; run_id: string; effect_id: string | null }>;
  for (const entry of open) {
    if (entry.source === 'run') {
      const run = getFlowRun(entry.run_id);
      const workflow = run ? workflowFor(run.flowVersionId, workflows) : null;
      const failure = run && workflow ? runFailure(run, undefined, workflow.nodes) : null;
      if (!run || !workflow || !failure || dismissed.has(failure.key)
        || (failure.effect === 'none' ? run.status === 'STOPPED' || succeededSince(run.flowId, run.created)
          : getRunRecovery(run.id)?.needsAttention === false)) {
        settled.push(entry.key);
        continue;
      }
      const row: OpenFailure = { failure, keys: [failure.key], repeats: 0, source: 'run', title: workflow.name,
        flowId: run.flowId, runId: run.id, at: run.finishTime ?? run.updated };
      // Newest first, so the first of a group is the row; older ones are its repeats.
      const group = [run.flowId, failure.category, failure.code ?? '', failure.links.stepName ?? '', failure.effect].join('\u0000');
      const first = groups.get(group);
      if (first) { first.keys.push(failure.key); first.repeats++; continue; }
      groups.set(group, row);
      rows.push(row);
    } else {
      const effect = entry.effect_id ? getWorkflowEffect(entry.effect_id) : null;
      const channels = effect ? unconfirmedDelivery(effect) : null;
      if (!effect || !channels) { settled.push(entry.key); continue; }
      const workflow = workflowFor(effect.versionId, workflows);
      const failure = projectFailure({ source: 'delivery', channels },
        { label: `The message from step "${workflow.steps.get(effect.stepName) ?? effect.stepName}"`, sideEffects: true },
        { runId: effect.runId, flowId: effect.flowId, stepName: effect.stepName, effectId: effect.id });
      if (dismissed.has(failure.key)) { settled.push(entry.key); continue; }
      rows.push({ failure, keys: [failure.key], repeats: 0, source: 'delivery', title: workflow.name, flowId: effect.flowId,
        runId: effect.runId, at: effect.finishedAt ?? effect.createdAt });
    }
  }
  if (settled.length) {
    db.transaction(() => { for (const key of settled) db.run('DELETE FROM open_failure WHERE key = ?', [key]); })();
  }

  for (const { failure, at } of listChatFailures()) {
    if (!dismissed.has(failure.key)) rows.push({ failure, keys: [failure.key], repeats: 0, source: 'chat', title: 'Chat', at });
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, LIMIT);
}

/** Dismiss failures by key. Unknown or malformed keys are ignored; returns how many were recorded. */
export function dismissFailures(keys: unknown, now = Date.now(), projectId?: string): number {
  if (!Array.isArray(keys)) return 0;
  let valid = [...new Set(keys.filter((key): key is string => typeof key === 'string' && KEY.test(key)))].slice(0, 200);
  if (projectId !== undefined) {
    // Only keys this project can currently inspect may be dismissed. This also
    // prevents pre-seeding a foreign or invented key as a future dismissal.
    const visible = new Set(listOpenFailures(now, projectId).flatMap(row => row.keys));
    valid = valid.filter(key => visible.has(key));
  }
  const db = getWorkflowDb();
  db.transaction(() => {
    for (const key of valid) db.run('INSERT OR IGNORE INTO failure_dismissal (key, dismissed_at) VALUES (?, ?)', [key, now]);
  })();
  dismissChatFailures(valid);
  return valid.length;
}
