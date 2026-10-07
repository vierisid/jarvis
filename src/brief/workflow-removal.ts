import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { DEFAULT_IDS, getWorkflowDb } from '../workflows/db';
import { getFlow, updateFlowStatus, parseFlowMetadata, type FlowRow } from '../workflows/db/repos/flow';
import { getFlowVersion, getLatestDraft } from '../workflows/db/repos/flow-version';
import { versionReadiness, WorkflowReadinessError } from '../workflows/db/repos/flow-readiness';
import { CodeStepsRefusedError, ungrantedCodeSteps } from '../workflows/db/repos/flow-code-steps';
import type { TriggerManager } from '../workflows/runner/triggers/manager';
import type { ManagedWorkflow, RemovalReceipt, WorkflowManageCommand, WorkflowManageResult } from './workflow-removal-contracts';

export const WORKFLOW_REMOVAL_LIMITS = { undoMs: 30_000, flows: 1000, commands: 10_000, receipts: 10_000, runs: 1000, bytes: 16 * 1024 * 1024 } as const;
export const WORKFLOW_REMOVAL_SCOPE = {
  futureRuns: 'refused_while_removed', existingRuns: 'already_accepted_runs_continue_under_existing_authority',
  undo: 'same_identity_and_position_paused_no_run_replay', history: 'versions_runs_and_effects_retained_no_purge',
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
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, Promise<void>>();
  constructor(readonly db: Database, readonly projectId: string = DEFAULT_IDS.project,
    private readonly now = Date.now, private readonly enabled = () => process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL === '1') {}
  start(triggers: Pick<TriggerManager, 'refresh'>): void {
    this.stop(); this.triggers = triggers;
    this.recoverRegistration();
    this.timer = setInterval(() => this.recoverRegistration(), 5000); this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.triggers = undefined; this.pending.clear(); }
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
      trigger: version?.trigger.type === 'EMPTY' ? 'Manual' : version?.trigger.type ?? 'Unknown',
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
  request(requestId: string): WorkflowManageResult {
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
      const n = (this.db.query('SELECT COUNT(*) AS n FROM brief_workflow_commands').get() as { n: number }).n;
      if (n >= WORKFLOW_REMOVAL_LIMITS.commands) throw new WorkflowRemovalError('capacity_exceeded', 503);
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
      this.db.run('INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)',
        [this.projectId, c.requestId, c.flowId, digest, JSON.stringify(result), this.now()]);
      return result;
    }).immediate();
    if (result.status === 'accepted') void this.reconcileFlow(c.flowId);
    return result;
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
        this.db.run('UPDATE flow SET status = ?, updated = ? WHERE id = ?', ['DISABLED', this.now(), f.id]);
        this.db.run('UPDATE brief_workflow_slots SET receipt_id = ?, generation = generation + 1 WHERE flow_id = ?', [r.receipt_id, f.id]);
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
        await triggers.refresh(flowId);
        if (getWorkflowDb() === this.db && this.triggers === triggers) this.db.run(
          'UPDATE brief_workflow_slots SET reconcile_pending = 0 WHERE flow_id = ? AND reconcile_revision = ?', [flowId, row.reconcile_revision]);
      } catch { /* The DB fence is already closed; retry local teardown without replaying the command. */ }
      finally { if (this.pending.get(flowId) === work) this.pending.delete(flowId); }
    });
    this.pending.set(flowId, work); return work;
  }
}
