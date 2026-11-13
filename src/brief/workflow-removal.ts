import { createHash } from 'node:crypto';
import { workflowTriggerLabel } from './workflow-trigger-label';
import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../workflows/db';
import { getFlow, updateFlowStatus, parseFlowMetadata, type FlowRow } from '../workflows/db/repos/flow';
import { getFlowRun } from '../workflows/db/repos/flow-run';
import { continuedFailureHeadline, continuedFailures } from '../workflows/runtime/continued-failures';
import { getFlowVersion, getLatestDraft } from '../workflows/db/repos/flow-version';
import { versionReadiness, WorkflowReadinessError } from '../workflows/db/repos/flow-readiness';
import { CodeStepsRefusedError, ungrantedCodeSteps } from '../workflows/db/repos/flow-code-steps';
import type { TriggerManager } from '../workflows/runner/triggers/manager';
import { stopRunsOfTurnedOffFlow } from '../workflows/db/repos/flow-turn-off';
import { addCounts, deleteFlowHistoryBatch, deleteFlowRows, flowHasLiveRun, flowHistoryOverBatch, NO_COUNTS,
  removeFlowFiles, removeRunFiles, stopEverythingOfFlow, type FlowDeleteCounts } from '../workflows/db/repos/flow-deletion';
import { effectDispatchInFlight } from '../workflows/runtime/effect-inflight';
import type { ManagedWorkflow, RemovalReceipt, WorkflowManageCommand, WorkflowManageResult,
  WorkflowPurgeCommand, WorkflowPurgeResult } from './workflow-removal-contracts';

export const WORKFLOW_REMOVAL_LIMITS = { undoMs: 30_000, flows: 1000, commands: 10_000, receipts: 10_000, runs: 1000, bytes: 16 * 1024 * 1024 } as const;
export const WORKFLOW_REMOVAL_SCOPE = {
  futureRuns: 'refused_while_removed', existingRuns: 'queued_and_waiting_runs_stopped_running_runs_finish_but_never_resume',
  undo: 'same_identity_and_position_paused_no_run_replay', history: 'versions_runs_and_effects_retained_until_a_person_purges',
  registration: 'local_delivery_fenced_immediately_external_unsubscribe_best_effort',
} as const;
export class WorkflowRemovalError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
type StoredReceipt = { receipt_id: string; flow_id: string; project_id: string; version_id: string | null;
  before_revision: string; removed_at: number; expires_at: number; restored_at: number | null };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
/** A pending purge's counts so far (#1154 batches); none before the first batch. */
const parseCounts = (raw: string | null): FlowDeleteCounts => {
  try { const v = raw ? JSON.parse(raw) : null; return v && typeof v === 'object' ? { ...NO_COUNTS, ...v } : { ...NO_COUNTS }; } catch { return { ...NO_COUNTS }; }
};
const parseIds = (raw: string | null): string[] => {
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.filter(id) : []; } catch { return []; }
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (r: StoredReceipt): RemovalReceipt => ({ scopeId: r.project_id, flowId: r.flow_id,
  versionId: r.version_id, receiptId: r.receipt_id, expiresAt: r.expires_at });

export class WorkflowRemoval {
  private triggers?: Pick<TriggerManager, 'refresh'> & Partial<Pick<TriggerManager, 'registrationProblem'>>;
  private onCardClosed?: (approvalId: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, Promise<void>>();
  /** Purge failures already logged, so a stuck purge does not log every pass. */
  private readonly purgeFailures = new Map<string, string>();
  /**
   * A completed purge whose WAL frames are not yet truncated (wipeWal). True
   * at start: a purge the last process completed but could not wipe (a crash,
   * or a close while another connection held the file) left no other trace.
   */
  private walWipePending = true;
  constructor(readonly db: Database, readonly projectId: string = DEFAULT_IDS.project,
    private readonly now = Date.now, private readonly enabled = () => process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL === '1') {}
  /** `onCardClosed` hears each workflow card a purge closed, so the dashboard stops offering it (#1039). */
  start(triggers: Pick<TriggerManager, 'refresh'> & Partial<Pick<TriggerManager, 'registrationProblem'>>, opts: { onCardClosed?: (approvalId: string) => void } = {}): void {
    this.stop(); this.triggers = triggers; this.onCardClosed = opts.onCardClosed;
    this.recover();
    this.timer = setInterval(() => this.recover(), 5000); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.triggers = undefined; this.onCardClosed = undefined; this.pending.clear(); }
  private recover(): void { this.recoverPurges(); this.recoverRegistration(); if (this.walWipePending && getWorkflowDb() === this.db) this.wipeWal(); }
  /**
   * secure_delete zeroes what a purge deletes, but the zeroed pages reach
   * vault.db only at a checkpoint, and the WAL keeps the frames that wrote
   * the rows until it is truncated. So a completed purge checkpoints and
   * truncates the WAL. Another connection (a `jarvis backup` reading, an
   * `enroll` writing) makes that busy; it is not waited for, as the daemon's
   * busy_timeout would block the event loop, but retried on each recovery
   * pass, and once on the first pass after every start.
   */
  private wipeWal(): void {
    const db = this.db;
    try {
      const timeout = (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      db.run('PRAGMA busy_timeout = 0');
      let busy = 1;
      try { busy = (db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy; }
      finally { db.run(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`); }
      if (busy === 0) { this.walWipePending = false; this.purgeFailures.delete('wal'); return; }
      this.walWipePending = true;
      if (!this.purgeFailures.has('wal')) console.warn('[Workflow Removal] WAL checkpoint after a purge is pending while another connection holds the database; retrying');
      this.purgeFailures.set('wal', 'busy');
    } catch (error) {
      this.walWipePending = true;
      const message = error instanceof Error ? error.message : String(error);
      if (this.purgeFailures.get('wal') !== message) console.error('[Workflow Removal] WAL checkpoint after a purge failed:', error);
      this.purgeFailures.set('wal', message);
    }
  }
  readiness(): 'ready' | 'unavailable' {
    try { return this.enabled() && this.triggers && getWorkflowDb() === this.db
      && this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'brief_workflow_commands'").get() ? 'ready' : 'unavailable'; }
    catch { return 'unavailable'; }
  }
  private ready(): void { if (this.readiness() !== 'ready') throw new WorkflowRemovalError('unavailable', 503); }
  private flow(flowId: string): FlowRow {
    const f = getFlow(flowId);
    if (!f || f.project_id !== this.projectId) throw new WorkflowRemovalError('not_found', 404);
    return f;
  }
  /**
   * The workflow as listed. One that is on but whose trigger could not be
   * registered reads blocked with the reason, not ready (nothing would run).
   */
  private item(f: FlowRow): ManagedWorkflow {
    const item = this.baseItem(f);
    const problem = f.status === 'ENABLED' && item.readiness.state === 'ready' ? this.triggers?.registrationProblem?.(f.id) : null;
    return problem ? { ...item, readiness: { ...item.readiness, state: 'blocked', reason: problem } } : item;
  }
  private baseItem(f: FlowRow): ManagedWorkflow {
    const version = f.published_version_id ? getFlowVersion(f.published_version_id) : getLatestDraft(f.id);
    if (version && version.flowId !== f.id) throw new WorkflowRemovalError('unavailable', 503);
    const state = this.db.query<{ generation: number }, [string]>('SELECT generation FROM brief_workflow_slots WHERE flow_id = ?').get(f.id);
    if (!state) throw new WorkflowRemovalError('unavailable', 503);
    const metadata = parseFlowMetadata(f);
    const readiness = version ? versionReadiness(f.id, version.id) : null;
    const ready = readiness?.ready === true && !ungrantedCodeSteps(f, version!.trigger);
    const last = this.db.query<{ id: string; status: string }, [string]>(
      'SELECT id, status FROM flow_run WHERE flow_id = ? ORDER BY created DESC, id DESC LIMIT 1').get(f.id);
    return { flowId: f.id, versionId: version?.id ?? null,
      // Engine subscription state and sample outputs are not an authoring revision.
      revision: hash([f, version && { id: version.id, name: version.displayName, trigger: version.trigger,
        state: version.state, valid: version.valid, schemaVersion: version.schemaVersion,
        agentIds: version.agentIds, connectionIds: version.connectionIds, notes: version.notes }, state.generation]),
      name: (version?.displayName || 'Untitled workflow').slice(0, 4000),
      description: typeof metadata?.description === 'string' ? metadata.description.slice(0, 4000) : '',
      trigger: workflowTriggerLabel(version?.trigger),
      activation: f.status, publication: f.published_version_id ? 'published' : 'unpublished',
      readiness: { state: ready ? 'ready' : 'blocked', reason: ready ? null : 'Workflow setup or permission needs review before enabling' },
      latestRun: last ? { runId: last.id, label: last.status === 'SUCCEEDED' && continuedFailures(getFlowRun(last.id)!).length ? continuedFailureHeadline(1) : last.status } : null };
  }
  read() {
    this.ready();
    return this.db.transaction(() => {
      const rows = this.db.query<FlowRow & { position: number; receipt_id: string | null; reconcile_pending: number }, [string, number]>(
        `SELECT f.*, s.position, s.receipt_id, s.reconcile_pending FROM flow f JOIN brief_workflow_slots s ON s.flow_id = f.id
         WHERE f.project_id = ? ORDER BY s.position DESC LIMIT ?`).all(this.projectId, WORKFLOW_REMOVAL_LIMITS.flows + 1);
      if (rows.length > WORKFLOW_REMOVAL_LIMITS.flows) throw new WorkflowRemovalError('capacity_exceeded', 503);
      const items: ManagedWorkflow[] = [], removals = [];
      for (const row of rows) {
        if (!row.receipt_id) { items.push(this.item(this.flow(row.id))); continue; }
        const r = this.db.query<StoredReceipt, [string]>('SELECT * FROM brief_workflow_removals WHERE receipt_id = ?').get(row.receipt_id);
        if (!r) throw new WorkflowRemovalError('unavailable', 503);
        const runs = this.db.query<{ runId: string; status: string }, [string, number]>(
          `SELECT id AS runId, status FROM flow_run WHERE flow_id = ? AND status IN ('QUEUED','RUNNING','PAUSED')
           ORDER BY created, id LIMIT ?`).all(row.id, WORKFLOW_REMOVAL_LIMITS.runs + 1);
        if (runs.length > WORKFLOW_REMOVAL_LIMITS.runs) throw new WorkflowRemovalError('capacity_exceeded', 503);
        removals.push({ ...receipt(r), expectedRevision: r.before_revision, position: row.position,
          removedAt: r.removed_at, undoAvailable: this.now() < r.expires_at, runs, item: this.item(this.flow(row.id)),
          registration: row.reconcile_pending ? 'pending' : 'reconciled' });
      }
      const data = { scopeId: this.projectId, items, removals, slots: rows.map(r => ({ flowId: r.id, position: r.position })), scope: WORKFLOW_REMOVAL_SCOPE };
      if (Buffer.byteLength(JSON.stringify(data)) > WORKFLOW_REMOVAL_LIMITS.bytes) throw new WorkflowRemovalError('capacity_exceeded', 503);
      return { state: items.length || removals.length ? 'ready' as const : 'empty' as const, data, asOf: this.now() };
    })();
  }
  request(requestId: string): WorkflowManageResult | WorkflowPurgeResult {
    this.ready(); if (!id(requestId)) throw new WorkflowRemovalError('invalid_request_id');
    const row = this.db.query<{ result: string }, [string, string]>(
      'SELECT result FROM brief_workflow_commands WHERE project_id = ? AND request_id = ?').get(this.projectId, requestId);
    if (!row) throw new WorkflowRemovalError('not_found', 404);
    return JSON.parse(row.result);
  }
  change(raw: unknown): WorkflowManageResult {
    this.ready(); const c = this.command(raw);
    const digest = hash([c.scopeId, c.flowId, c.versionId, c.expectedRevision, c.action, c.activation ?? null, c.receiptId ?? null]);
    const result = this.db.transaction(() => {
      const existing = this.db.query<{ command_digest: string; result: string }, [string, string]>(
        'SELECT command_digest, result FROM brief_workflow_commands WHERE project_id = ? AND request_id = ?').get(this.projectId, c.requestId);
      if (existing) {
        if (existing.command_digest !== digest) throw new WorkflowRemovalError('request_conflict', 409);
        return JSON.parse(existing.result) as WorkflowManageResult;
      }
      this.flow(c.flowId); // Scope lookup before any mutation or durable rejection.
      const identity = { scopeId: this.projectId, flowId: c.flowId, requestId: c.requestId, action: c.action };
      let result: WorkflowManageResult;
      try { result = this.db.transaction(() => this.apply(c)).immediate(); }
      catch (error) {
        if (error instanceof WorkflowRemovalError && error.status === 409) {
          result = { ...identity, status: 'rejected', code: error.code, message: error.code };
        } else if (error instanceof WorkflowReadinessError || error instanceof CodeStepsRefusedError) {
          result = { ...identity, status: 'rejected', code: 'not_ready', message: 'Workflow setup or permission needs review before enabling' };
        } else throw error;
      }
      // Every removal receipt reserves exactly one successful Undo outcome, even
      // when ordinary commands are full. apply() consumes the receipt atomically;
      // rejected/fabricated/reused Undo requests cannot claim this reserved slot.
      // Total storage is bounded by commands + receipts; neither is evicted.
      if (!(c.action === 'restore' && result.status === 'accepted')) {
        const n = (this.db.query(`SELECT COUNT(*) AS n FROM brief_workflow_commands
          WHERE json_extract(result, '$.action') IS NOT 'restore'
             OR json_extract(result, '$.status') IS NOT 'accepted'`).get() as { n: number }).n;
        if (n >= WORKFLOW_REMOVAL_LIMITS.commands) throw new WorkflowRemovalError('capacity_exceeded', 503);
      }
      this.db.run('INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)',
        [this.projectId, c.requestId, c.flowId, digest, JSON.stringify(result), this.now()]);
      return result;
    }).immediate();
    if (result.status === 'accepted') void this.reconcileFlow(c.flowId);
    return result;
  }
  /**
   * #1096: hard-delete a workflow that F-20 removal history otherwise keeps
   * forever. A person's path only: this service is reached from the
   * authenticated dashboard route, never from manage_workflow or an agent
   * tool. It applies to a restored workflow, or to a removed one whose Undo
   * has expired, at the revision the person saw.
   *
   * Acceptance and refusal are recorded under the request id like any
   * command, so a retry returns the original outcome. Runs are stopped only
   * after the acceptance commits (Q-06): a refused purge stops nothing.
   */
  purge(raw: unknown, actor: string): WorkflowPurgeResult {
    this.ready(); const c = this.purgeCommand(raw);
    if (!/^[\x21-\x7e]{1,300}$/.test(actor)) throw new WorkflowRemovalError('invalid_actor');
    const digest = hash(['purge', c.scopeId, c.flowId, c.versionId, c.expectedRevision]);
    const result = this.db.transaction(() => {
      const existing = this.db.query<{ command_digest: string; result: string }, [string, string]>(
        'SELECT command_digest, result FROM brief_workflow_commands WHERE project_id = ? AND request_id = ?').get(this.projectId, c.requestId);
      if (existing) {
        if (existing.command_digest !== digest) throw new WorkflowRemovalError('request_conflict', 409);
        return JSON.parse(existing.result) as WorkflowPurgeResult;
      }
      this.flow(c.flowId); // Scope lookup before any mutation or durable rejection.
      let result: WorkflowPurgeResult;
      try { result = this.db.transaction(() => this.acceptPurge(c, actor)).immediate(); }
      catch (error) {
        if (!(error instanceof WorkflowRemovalError && error.status === 409)) throw error;
        result = { scopeId: this.projectId, flowId: c.flowId, requestId: c.requestId, action: 'purge', status: 'rejected', code: error.code, message: error.code };
      }
      // A purge outcome is an ordinary command: it never uses Undo's reserved capacity.
      const n = (this.db.query(`SELECT COUNT(*) AS n FROM brief_workflow_commands
        WHERE json_extract(result, '$.action') IS NOT 'restore'
           OR json_extract(result, '$.status') IS NOT 'accepted'`).get() as { n: number }).n;
      if (n >= WORKFLOW_REMOVAL_LIMITS.commands) throw new WorkflowRemovalError('capacity_exceeded', 503);
      this.db.run('INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)',
        [this.projectId, c.requestId, c.flowId, digest, JSON.stringify(result), this.now()]);
      return result;
    }).immediate();
    if (result.status === 'accepted') this.finishPurge(c.flowId, true);
    return result;
  }
  private purgeCommand(raw: unknown): WorkflowPurgeCommand {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowRemovalError('invalid_command');
    const c = raw as WorkflowPurgeCommand;
    if (Object.keys(c).some(k => !['scopeId','flowId','versionId','expectedRevision','requestId'].includes(k))
      || !id(c.scopeId) || !id(c.flowId) || !(c.versionId === null || id(c.versionId)) || !id(c.requestId)
      || typeof c.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(c.expectedRevision)) throw new WorkflowRemovalError('invalid_command');
    if (c.scopeId !== this.projectId) throw new WorkflowRemovalError('not_found', 404);
    return c;
  }
  /** Caller holds the transaction. Every refusal throws before anything is written. */
  private acceptPurge(c: WorkflowPurgeCommand, actor: string): WorkflowPurgeResult {
    const f = this.flow(c.flowId), current = this.item(f);
    const slot = this.db.query<{ receipt_id: string | null; generation: number }, [string]>(
      'SELECT receipt_id, generation FROM brief_workflow_slots WHERE flow_id = ?').get(f.id);
    if (!slot) throw new WorkflowRemovalError('unavailable', 503);
    // A workflow never removed has no retained history; the ordinary delete serves it.
    if (!this.db.query('SELECT 1 FROM brief_workflow_removals WHERE flow_id = ? LIMIT 1').get(f.id)) throw new WorkflowRemovalError('not_removed', 409);
    if (this.db.query('SELECT 1 FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(f.id)) throw new WorkflowRemovalError('purge_pending', 409);
    if (slot.receipt_id) {
      const r = this.db.query<StoredReceipt, [string]>('SELECT * FROM brief_workflow_removals WHERE receipt_id = ?').get(slot.receipt_id);
      if (!r) throw new WorkflowRemovalError('unavailable', 503);
      // While Undo is still possible the person has not finished deciding.
      if (this.now() < r.expires_at) throw new WorkflowRemovalError('undo_available', 409);
    }
    if (current.revision !== c.expectedRevision || current.versionId !== c.versionId) throw new WorkflowRemovalError('revision_conflict', 409);
    const purge = { purgeId: crypto.randomUUID(), flowId: f.id, generation: slot.generation, acceptedAt: this.now() };
    this.db.run(`INSERT INTO brief_workflow_purges (purge_id, flow_id, project_id, request_id, generation, actor, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [purge.purgeId, f.id, this.projectId, c.requestId, purge.generation, actor, purge.acceptedAt]);
    // Turned off now (Q-06), so its triggers stop and nothing created before continues.
    this.db.run('UPDATE flow SET status = ?, updated = ?, disabled_at = ? WHERE id = ?', ['DISABLED', this.now(), this.now(), f.id]);
    return { scopeId: this.projectId, flowId: f.id, requestId: c.requestId, action: 'purge', status: 'accepted', purge };
  }
  /**
   * Finish an accepted purge: stop its runs, close their cards, then delete
   * the flow, its versions and its run payloads (db/repos/flow-deletion.ts,
   * shared with the ordinary delete). The receipt and the audit rows (command
   * outcomes, trigger ledger, recovery receipts, approval records) stay.
   * Idempotent; a failure leaves the purge pending for the next recovery pass.
   *
   * Held, deleting nothing, while a run is live again or an effect of the
   * flow is still being dispatched in this process (#1154): its record and
   * approval receipt are written when it returns. A large history goes in
   * batches, one per event-loop turn (#1154); the receipt's counts and its
   * leftover-file list carry over between them, so a crash between batches
   * loses neither.
   */
  private finishPurge(flowId: string, accepting = false): void {
    const db = this.db;
    if (!db.query('SELECT 1 FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(flowId)) return;
    let completed: string | null = null, held: 'live_run' | 'dispatching' | null = null, runIds: string[] = [];
    let batch: { purgeId: string; runIds: string[] } | null = null;
    const report = (approvalId: string) => {
      try { this.onCardClosed?.(approvalId); } catch (error) { console.error('[Workflow Removal] closed card update failed:', error); }
    };
    try {
      stopEverythingOfFlow(flowId, report, db);
      // A purge is the delete a person asks for so the data is gone, so its
      // rows are zeroed rather than unlinked into free pages (wipeWal does
      // the WAL). Only the purge pays for it: a bulk delete under
      // secure_delete writes every freed byte again. Not reached by this:
      // bytes an EARLIER update of a row (an edited draft, a rewritten store
      // value) left in page free space, and anything freed before this
      // shipped. Only a VACUUM rewrites those away.
      const secureDelete = (db.query('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
      db.run('PRAGMA secure_delete = ON');
      try { db.transaction(() => {
        const p = db.query<{ purge_id: string; counts: string | null; files_pending: string | null }, [string]>(
          'SELECT purge_id, counts, files_pending FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(flowId);
        if (!p) return;
        // brief_purge_pending_run refuses new runs, but an engine can still set a
        // stopped run live again before it notices; the next pass stops it first.
        if (flowHasLiveRun(flowId, db)) { held = 'live_run'; return; }
        if (effectDispatchInFlight(flowId)) { held = 'dispatching'; return; }
        const carried = parseCounts(p.counts), pending = parseIds(p.files_pending);
        db.run('UPDATE brief_workflow_purges SET granted = 1 WHERE purge_id = ?', [p.purge_id]);
        if (flowHistoryOverBatch(flowId, db)) {
          const part = deleteFlowHistoryBatch(flowId, db);
          // Still pending: the counts so far and the files to remove ride on the receipt.
          db.run('UPDATE brief_workflow_purges SET granted = 0, counts = ?, files_pending = ? WHERE purge_id = ?',
            [JSON.stringify(addCounts(carried, part.counts)), JSON.stringify([...pending, ...part.runIds]), p.purge_id]);
          batch = { purgeId: p.purge_id, runIds: part.runIds };
          return;
        }
        const last = deleteFlowRows(flowId, this.projectId, db);
        if (!last.deleted) throw new Error('purge_flow_missing');
        runIds = [...pending, ...last.runIds];
        // The run ids name the payload files kept beside the database, removed after commit.
        db.run('UPDATE brief_workflow_purges SET granted = 0, completed_at = ?, counts = ?, files_pending = ? WHERE purge_id = ?',
          [this.now(), JSON.stringify(addCounts(carried, last.counts)), JSON.stringify(runIds), p.purge_id]);
        completed = p.purge_id;
      }).immediate(); } finally { db.run(`PRAGMA secure_delete = ${secureDelete === 2 ? 'FAST' : secureDelete ? 'ON' : 'OFF'}`); }
      if (held) {
        if (this.purgeFailures.get(`flow:${flowId}`) !== held) {
          console.warn(`[Workflow Removal] purge of ${flowId} waits for ${held === 'live_run' ? 'a run that is still live' : 'an effect still being dispatched'}`);
        }
        this.purgeFailures.set(`flow:${flowId}`, held);
      } else this.purgeFailures.delete(`flow:${flowId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.purgeFailures.get(`flow:${flowId}`) !== message) console.error('[Workflow Removal] purge left pending for retry:', error);
      this.purgeFailures.set(`flow:${flowId}`, message);
    }
    if (batch) {
      const { purgeId, runIds: done } = batch as { purgeId: string; runIds: string[] };
      this.removeBatchFiles(purgeId, done);
      // The next batch on the next turn of the event loop, not at the next recovery pass.
      if (!this.batching.has(flowId)) {
        this.batching.add(flowId);
        setImmediate(() => {
          this.batching.delete(flowId);
          // Stopped meanwhile (shutdown): recovery finishes it when the service runs again.
          try {
            if (!this.triggers || getWorkflowDb() !== this.db) return;
            this.finishPurge(flowId);
          } catch (error) { console.error('[Workflow Removal] purge batch failed; recovery retries it:', error); }
        });
      }
    }
    // Run payloads kept beside the database: the engine's execution-state
    // backups and the disk copies of step files. Best effort once the rows are gone.
    // A recovery pass that completes many purges wipes once, at its end.
    if (completed) { this.walWipePending = true; if (accepting) this.wipeWal(); this.removePurgedFiles(completed, flowId, runIds); }
    // Unregister at acceptance (the flow is off) and once it is gone; a pass that changed nothing does not.
    if (completed || accepting) void this.triggers?.refresh(flowId).catch(() => { /* Local delivery is fenced by the missing flow. */ });
  }
  private readonly batching = new Set<string>();
  /** A batch's run files, removed now and taken off the still-pending receipt's list. */
  private removeBatchFiles(purgeId: string, runIds: string[]): void {
    try {
      removeRunFiles(runIds);
      const gone = new Set(runIds);
      const p = this.db.query<{ files_pending: string | null }, [string]>(
        'SELECT files_pending FROM brief_workflow_purges WHERE purge_id = ? AND completed_at IS NULL').get(purgeId);
      if (p) this.db.run('UPDATE brief_workflow_purges SET files_pending = ? WHERE purge_id = ?',
        [JSON.stringify(parseIds(p.files_pending).filter(r => !gone.has(r))), purgeId]);
    } catch (error) {
      // Left on the receipt's list; the purge's completion removes them.
      const message = error instanceof Error ? error.message : String(error);
      if (this.purgeFailures.get(`files:${purgeId}`) !== message) console.error('[Workflow Removal] purged run files could not all be removed:', error);
      this.purgeFailures.set(`files:${purgeId}`, message);
    }
  }
  /**
   * Run payloads kept beside the database: the engine's execution-state
   * backups and the disk copies of step files. The receipt keeps the list
   * until they are gone, so recovery retries a removal a crash or an error cut short.
   */
  private removePurgedFiles(purgeId: string, flowId: string, runIds: string[]): void {
    try {
      removeRunFiles(runIds.filter(id));
      if (id(flowId)) removeFlowFiles(flowId);
      this.db.run('UPDATE brief_workflow_purges SET files_pending = NULL WHERE purge_id = ?', [purgeId]);
      this.purgeFailures.delete(`files:${purgeId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.purgeFailures.get(`files:${purgeId}`) !== message) console.error('[Workflow Removal] purged run files could not all be removed:', error);
      this.purgeFailures.set(`files:${purgeId}`, message);
    }
  }
  private recoverPurges(): void {
    try {
      if (getWorkflowDb() !== this.db) return;
      // Only a purge the service accepted: its own command outcome names this receipt.
      for (const { flow_id } of this.db.query<{ flow_id: string }, [string]>(`SELECT p.flow_id FROM brief_workflow_purges p
        JOIN brief_workflow_commands c ON c.project_id = p.project_id AND c.request_id = p.request_id AND c.flow_id = p.flow_id
        WHERE p.completed_at IS NULL AND p.project_id = ?1
          AND json_extract(c.result, '$.action') = 'purge' AND json_extract(c.result, '$.status') = 'accepted'
          AND json_extract(c.result, '$.purge.purgeId') = p.purge_id
        ORDER BY p.accepted_at LIMIT 100`).all(this.projectId)) this.finishPurge(flow_id);
      for (const p of this.db.query<{ purge_id: string; flow_id: string; files_pending: string }, [string]>(`SELECT purge_id, flow_id, files_pending
        FROM brief_workflow_purges WHERE completed_at IS NOT NULL AND files_pending IS NOT NULL AND project_id = ? LIMIT 100`).all(this.projectId)) {
        let runIds: unknown; try { runIds = JSON.parse(p.files_pending); } catch { runIds = []; }
        this.removePurgedFiles(p.purge_id, p.flow_id, Array.isArray(runIds) ? runIds.filter((r): r is string => typeof r === 'string') : []);
      }
    } catch { /* Retried on the next pass. */ }
  }
  private command(raw: unknown): WorkflowManageCommand {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowRemovalError('invalid_command');
    const c = raw as WorkflowManageCommand;
    if (Object.keys(c).some(k => !['scopeId','flowId','versionId','expectedRevision','requestId','action','activation','receiptId'].includes(k))
      || !id(c.scopeId) || !id(c.flowId) || !(c.versionId === null || id(c.versionId)) || !id(c.requestId)
      || typeof c.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(c.expectedRevision)
      || !['activation','remove','restore'].includes(c.action)
      || (c.action === 'activation' ? !['ENABLED','DISABLED'].includes(c.activation!) : c.activation !== undefined)
      || (c.action === 'restore' ? !id(c.receiptId) : c.receiptId !== undefined)) throw new WorkflowRemovalError('invalid_command');
    if (c.scopeId !== this.projectId) throw new WorkflowRemovalError('not_found', 404);
    return c;
  }
  private apply(c: WorkflowManageCommand): WorkflowManageResult {
    const f = this.flow(c.flowId), current = this.item(f);
    const slot = this.db.query<{ receipt_id: string | null }, [string]>('SELECT receipt_id FROM brief_workflow_slots WHERE flow_id = ?').get(f.id)!;
    const base = { scopeId: this.projectId, flowId: f.id, requestId: c.requestId, action: c.action, status: 'accepted' as const };
    // An accepted purge owns the workflow until it finishes: no new receipt, no re-enable.
    if (this.db.query('SELECT 1 FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(f.id)) throw new WorkflowRemovalError('purge_pending', 409);
    if (c.action === 'restore') {
      const r = this.db.query<StoredReceipt, [string, string, string]>(
        'SELECT * FROM brief_workflow_removals WHERE receipt_id = ? AND flow_id = ? AND project_id = ?').get(c.receiptId!, f.id, this.projectId);
      if (!r || slot.receipt_id !== r.receipt_id || r.restored_at !== null) throw new WorkflowRemovalError('receipt_conflict', 409);
      if (this.now() >= r.expires_at) throw new WorkflowRemovalError('undo_expired', 409);
      if (r.before_revision !== c.expectedRevision || r.version_id !== c.versionId || current.versionId !== c.versionId) throw new WorkflowRemovalError('revision_conflict', 409);
      this.db.run('UPDATE brief_workflow_slots SET receipt_id = NULL WHERE flow_id = ?', [f.id]);
      this.db.run('UPDATE flow SET status = ?, updated = ? WHERE id = ?', ['DISABLED', this.now(), f.id]);
      this.db.run('UPDATE brief_workflow_removals SET restored_at = ? WHERE receipt_id = ?', [this.now(), r.receipt_id]);
    } else {
      if (slot.receipt_id) throw new WorkflowRemovalError('workflow_removed', 409);
      if (current.revision !== c.expectedRevision || current.versionId !== c.versionId) throw new WorkflowRemovalError('revision_conflict', 409);
      if (c.action === 'remove') {
        const count = (this.db.query('SELECT COUNT(*) AS n FROM brief_workflow_removals').get() as { n: number }).n;
        if (count >= WORKFLOW_REMOVAL_LIMITS.receipts) throw new WorkflowRemovalError('capacity_exceeded', 503);
        const r: StoredReceipt = { receipt_id: crypto.randomUUID(), flow_id: f.id, project_id: this.projectId,
          version_id: current.versionId, before_revision: current.revision, removed_at: this.now(), expires_at: this.now() + WORKFLOW_REMOVAL_LIMITS.undoMs, restored_at: null };
        this.db.run('INSERT INTO brief_workflow_removals VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
          [r.receipt_id, f.id, this.projectId, r.version_id, r.before_revision, r.removed_at, r.expires_at]);
        // Removal turns the workflow off (Q-06) whatever its state: every run
        // created before now is stopped if queued or waiting and never continues.
        this.db.run('UPDATE flow SET status = ?, updated = ?, disabled_at = ? WHERE id = ?', ['DISABLED', this.now(), this.now(), f.id]);
        this.db.run('UPDATE brief_workflow_slots SET receipt_id = ?, generation = generation + 1, pinned_draft_id = ? WHERE flow_id = ?',
          [r.receipt_id, f.published_version_id ? null : r.version_id, f.id]);
        this.markRegistration(f.id);
        return { ...base, receipt: receipt(r) };
      }
      updateFlowStatus(f.id, c.activation!); // Existing CODE, readiness and publication semantics.
    }
    this.markRegistration(f.id);
    return { ...base, item: this.item(this.flow(f.id)) };
  }
  private markRegistration(flowId: string): void {
    this.db.run('UPDATE brief_workflow_slots SET reconcile_pending = 1, reconcile_revision = reconcile_revision + 1 WHERE flow_id = ?', [flowId]);
  }
  private recoverRegistration(): void {
    try {
      if (!this.triggers || getWorkflowDb() !== this.db) return;
      const busy = [...this.pending.keys()];
      const exclude = busy.length ? `AND flow_id NOT IN (${busy.map(() => '?').join(',')})` : '';
      for (const { flow_id } of this.db.query<{ flow_id: string }, string[]>(`SELECT flow_id FROM brief_workflow_slots
        WHERE reconcile_pending = 1 ${exclude} ORDER BY position LIMIT 100`).all(...busy)) {
        void this.reconcileFlow(flow_id);
      }
    } catch { /* Keep durable pending work for the next boot/interval. */ }
  }
  /** Runtime reconciliation is retriable; command and receipt reads never re-dispatch it. */
  async reconcileFlow(flowId: string): Promise<void> {
    if (this.pending.has(flowId)) return this.pending.get(flowId);
    const triggers = this.triggers; if (!triggers || getWorkflowDb() !== this.db) return;
    const row = this.db.query<{ reconcile_revision: number; reconcile_pending: number }, [string]>(
      'SELECT reconcile_revision, reconcile_pending FROM brief_workflow_slots WHERE flow_id = ?').get(flowId);
    if (!row?.reconcile_pending) return;
    const work = Promise.resolve().then(async () => {
      try {
        // Stop what a turned-off or removed workflow had queued or waiting (Q-06);
        // idempotent, and retried with registration until it settles.
        if (getFlow(flowId)?.status === 'DISABLED') stopRunsOfTurnedOffFlow(flowId);
        await triggers.refresh(flowId);
        if (getWorkflowDb() === this.db && this.triggers === triggers) this.db.run(
          'UPDATE brief_workflow_slots SET reconcile_pending = 0 WHERE flow_id = ? AND reconcile_revision = ?', [flowId, row.reconcile_revision]);
      } catch { /* The DB fence is already closed; retry local teardown without replaying the command. */ }
      finally { if (this.pending.get(flowId) === work) this.pending.delete(flowId); }
    });
    this.pending.set(flowId, work); return work;
  }
}
