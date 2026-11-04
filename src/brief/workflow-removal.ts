import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { workflowFileBase, workflowLogsBase } from '../workflows/sandbox-api/config';
import { workflowTriggerLabel } from './workflow-trigger-label';
import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../workflows/db';
import { getFlow, updateFlowStatus, parseFlowMetadata, type FlowRow } from '../workflows/db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../workflows/db/repos/flow-version';
import { versionReadiness, WorkflowReadinessError } from '../workflows/db/repos/flow-readiness';
import { CodeStepsRefusedError, ungrantedCodeSteps } from '../workflows/db/repos/flow-code-steps';
import type { TriggerManager } from '../workflows/runner/triggers/manager';
import { stopRunsOfDeletedFlow, stopRunsOfTurnedOffFlow } from '../workflows/db/repos/flow-turn-off';
import { retireTerminalRunWaits } from '../workflows/db/repos/run-cancellation';
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
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (r: StoredReceipt): RemovalReceipt => ({ scopeId: r.project_id, flowId: r.flow_id,
  versionId: r.version_id, receiptId: r.receipt_id, expiresAt: r.expires_at });

export class WorkflowRemoval {
  private triggers?: Pick<TriggerManager, 'refresh'>;
  private onCardClosed?: (approvalId: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, Promise<void>>();
  /** Purge failures already logged, so a stuck purge does not log every pass. */
  private readonly purgeFailures = new Map<string, string>();
  constructor(readonly db: Database, readonly projectId: string = DEFAULT_IDS.project,
    private readonly now = Date.now, private readonly enabled = () => process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL === '1') {}
  /** `onCardClosed` hears each workflow card a purge closed, so the dashboard stops offering it (#1039). */
  start(triggers: Pick<TriggerManager, 'refresh'>, opts: { onCardClosed?: (approvalId: string) => void } = {}): void {
    this.stop(); this.triggers = triggers; this.onCardClosed = opts.onCardClosed;
    this.recover();
    this.timer = setInterval(() => this.recover(), 5000); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.triggers = undefined; this.onCardClosed = undefined; this.pending.clear(); }
  private recover(): void { this.recoverPurges(); this.recoverRegistration(); }
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
  private item(f: FlowRow): ManagedWorkflow {
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
      latestRun: last ? { runId: last.id, label: last.status } : null };
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
   * the flow, its versions and its run payloads in one transaction. The
   * receipt and the audit rows (command outcomes, trigger ledger, recovery
   * receipts, approval records) stay. Idempotent; a failure leaves the purge
   * pending for the next recovery pass.
   */
  private finishPurge(flowId: string, accepting = false): void {
    const db = this.db;
    if (!db.query('SELECT 1 FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(flowId)) return;
    let completed: string | null = null, held = false, runIds: string[] = [];
    const report = (approvalId: string) => {
      try { this.onCardClosed?.(approvalId); } catch (error) { console.error('[Workflow Removal] closed card update failed:', error); }
    };
    try {
      stopRunsOfDeletedFlow(flowId, report);
      // A run that ended before it parked can still hold a pending card or an
      // open waitpoint (#1039); the cascade below would leave its card approvable.
      for (const { id } of db.query<{ id: string }, [string]>(`SELECT r.id FROM flow_run r WHERE r.flow_id = ?
        AND r.status NOT IN ('QUEUED','RUNNING','PAUSED') AND (
          EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id = r.id AND e.status = 'pending')
          OR EXISTS (SELECT 1 FROM waitpoint w WHERE w.flow_run_id = r.id AND w.resumed_at IS NULL))`).all(flowId)) {
        retireTerminalRunWaits(id).forEach(report);
      }
      db.transaction(() => {
        const p = db.query<{ purge_id: string }, [string]>(
          'SELECT purge_id FROM brief_workflow_purges WHERE flow_id = ? AND completed_at IS NULL').get(flowId);
        if (!p) return;
        // brief_purge_pending_run refuses new runs, but an engine can still set a
        // stopped run live again before it notices; the next pass stops it first.
        if (db.query("SELECT 1 FROM flow_run WHERE flow_id = ? AND status IN ('QUEUED','RUNNING','PAUSED') LIMIT 1").get(flowId)) { held = true; return; }
        const count = (sql: string, ...more: string[]) => (db.query(sql).get(flowId, ...more) as { n: number }).n;
        const runs = `SELECT id FROM flow_run WHERE flow_id = ?1`;
        // Every job of the flow or its runs: the runs are all stopped, so none can run.
        const jobs = `FROM workflow_job WHERE (flow_id = ?1 OR flow_run_id IN (${runs})
          OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END IN (${runs})))`;
        // FLOW-scoped piece store keys, as the engine writes them (piece-context/store.ts).
        const store = `FROM store_entry WHERE project_id = ?2 AND (substr(key, 1, length('flow_' || ?1 || '/')) = 'flow_' || ?1 || '/'
          OR substr(key, 1, length('testflow_' || ?1 || '/')) = 'testflow_' || ?1 || '/')`;
        const counts = {
          versions: count('SELECT COUNT(*) AS n FROM flow_version WHERE flow_id = ?1'),
          runs: count('SELECT COUNT(*) AS n FROM flow_run WHERE flow_id = ?1'),
          removals: count('SELECT COUNT(*) AS n FROM brief_workflow_removals WHERE flow_id = ?1'),
          triggerEvents: count('SELECT COUNT(*) AS n FROM trigger_event WHERE flow_id = ?1'),
          files: count('SELECT COUNT(*) AS n FROM workflow_file WHERE flow_id = ?1'),
          jobs: count(`SELECT COUNT(*) AS n ${jobs}`),
          storeEntries: count(`SELECT COUNT(*) AS n ${store}`, this.projectId),
        };
        runIds = db.query<{ id: string }, [string]>('SELECT id FROM flow_run WHERE flow_id = ?').all(flowId).map(r => r.id);
        db.run('UPDATE brief_workflow_purges SET granted = 1 WHERE purge_id = ?', [p.purge_id]);
        db.run(`DELETE ${jobs}`, [flowId]);
        db.run(`DELETE ${store}`, [flowId, this.projectId]);
        db.run('DELETE FROM workflow_file WHERE flow_id = ?', [flowId]);
        db.run('DELETE FROM open_failure WHERE flow_id = ?', [flowId]);
        // The receipts' foreign key requires them gone before the flow.
        db.run('DELETE FROM brief_workflow_removals WHERE flow_id = ?', [flowId]);
        // Versions, runs, effects, waitpoints, trigger events and the slot cascade.
        if (db.run('DELETE FROM flow WHERE id = ? AND project_id = ?', [flowId, this.projectId]).changes === 0) throw new Error('purge_flow_missing');
        // The run ids name the payload files kept beside the database, removed after commit.
        db.run('UPDATE brief_workflow_purges SET granted = 0, completed_at = ?, counts = ?, files_pending = ? WHERE purge_id = ?',
          [this.now(), JSON.stringify(counts), JSON.stringify(runIds), p.purge_id]);
        completed = p.purge_id;
      }).immediate();
      if (held) {
        if (this.purgeFailures.get(`flow:${flowId}`) !== 'live_run') console.warn(`[Workflow Removal] purge of ${flowId} waits for a run that is still live`);
        this.purgeFailures.set(`flow:${flowId}`, 'live_run');
      } else this.purgeFailures.delete(`flow:${flowId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.purgeFailures.get(`flow:${flowId}`) !== message) console.error('[Workflow Removal] purge left pending for retry:', error);
      this.purgeFailures.set(`flow:${flowId}`, message);
    }
    // Run payloads kept beside the database: the engine's execution-state
    // backups and the disk copies of step files. Best effort once the rows are gone.
    if (completed) this.removePurgedFiles(completed, flowId, runIds);
    // Unregister at acceptance (the flow is off) and once it is gone; a pass that changed nothing does not.
    if (completed || accepting) void this.triggers?.refresh(flowId).catch(() => { /* Local delivery is fenced by the missing flow. */ });
  }
  /**
   * Run payloads kept beside the database: the engine's execution-state
   * backups and the disk copies of step files. The receipt keeps the list
   * until they are gone, so recovery retries a removal a crash or an error cut short.
   */
  private removePurgedFiles(purgeId: string, flowId: string, runIds: string[]): void {
    try {
      for (const runId of runIds) if (id(runId)) rmSync(resolve(workflowLogsBase(), `${runId}.bin`), { force: true });
      if (id(flowId)) rmSync(resolve(workflowFileBase(), flowId), { recursive: true, force: true });
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
