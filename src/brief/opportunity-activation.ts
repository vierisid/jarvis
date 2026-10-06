import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { getWorkflowDb } from '../workflows/db';
import { getFlow } from '../workflows/db/repos/flow';
import { getFlowVersion } from '../workflows/db/repos/flow-version';
import { publishFlowVersion } from '../workflows/db/repos/flow-publication';
import { digest } from '../workflows/runtime/effect-context';
import type { BriefPreparedOpportunity } from './contracts';
import type { BriefProvider } from './providers';

/** Structural F09 seam: this service never composes or edits a reviewed graph. */
export interface PreparedActionSource extends BriefProvider {
  get(id: string): BriefPreparedOpportunity & { canApprove: boolean };
}
export interface ActivationTriggers {
  refresh(flowId: string): Promise<void>;
  registrationState(flowId: string, versionId: string): 'registered' | 'pending' | 'blocked' | 'changed';
}
type Decision = 'approve' | 'dismiss';
type Registration = 'pending' | 'registered' | 'blocked' | 'not_required';
interface ActionRow {
  id: string; proposal_id: string; revision: string; decision: Decision; registration: Registration;
  flow_id: string | null; version_id: string | null; version_digest: string | null;
  lease_token: string | null; lease_until: number; created_at: number; updated_at: number;
}
interface ProposalRow {
  id: string; revision: string; flow_id: string | null; version_id: string | null; version_digest: string | null;
  accepted_at: number | null; dismissed_at: number | null;
}
export interface OpportunityActionReceipt {
  receiptId: string; proposalId: string; revision: string; decision: Decision;
  workflow: { flowId: string; versionId: string; versionDigest: string } | null;
  registration: { state: Registration; message: string | null };
  currentActivation: 'enabled' | 'paused' | 'changed' | 'missing' | 'not_applicable';
  decidedAt: number; updatedAt: number; nextProposalId: string | null;
}
export class OpportunityActionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const registrationMessage = (state: Registration): string | null => state === 'pending'
  ? 'Approval is saved. Trigger registration is pending; this is not a completed workflow run.'
  : state === 'blocked' ? 'Approval is saved, but registration needs attention. Inspect the workflow and retry with the same request key.' : null;
function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new OpportunityActionError(`${field} must be non-empty text of at most 256 characters`);
}

/** Database publication and receipt are one commit. Trigger reconciliation is a recoverable second phase. */
export class OpportunityActivation {
  private source: PreparedActionSource | null = null;
  private triggers: ActivationTriggers | null = null;
  private stopped = false;
  private healthy = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly db: Database, private readonly leaseMs = 30_000) {
    db.run(`CREATE TABLE IF NOT EXISTS brief_opportunity_actions (
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, revision TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve','dismiss')),
      registration TEXT NOT NULL CHECK(registration IN ('pending','registered','blocked','not_required')),
      flow_id TEXT, version_id TEXT, version_digest TEXT,
      lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS brief_opportunity_action_requests (
      request_key TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES brief_opportunity_actions(id)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_opportunity_action_pending ON brief_opportunity_actions(registration, lease_until)');
  }
  configure(source: PreparedActionSource, triggers: ActivationTriggers): void { this.source = source; this.triggers = triggers; }
  private current(): boolean { try { return this.db === getWorkflowDb() && !!this.db.query('SELECT 1').get(); } catch { return false; } }
  readiness(): 'ready' | 'unavailable' {
    return !this.stopped && this.healthy && this.current() && this.source?.readiness() === 'ready' && this.triggers ? 'ready' : 'unavailable';
  }
  private assertReady(): void { if (this.readiness() !== 'ready') throw new OpportunityActionError('Opportunity activation is unavailable', 503); }
  private row(proposalId: string): ActionRow | null {
    return this.db.query<ActionRow, [string]>('SELECT * FROM brief_opportunity_actions WHERE proposal_id = ?').get(proposalId);
  }
  private activation(row: ActionRow): OpportunityActionReceipt['currentActivation'] {
    if (row.decision === 'dismiss') return 'not_applicable';
    const flow = getFlow(row.flow_id!), version = getFlowVersion(row.version_id!);
    if (!flow || !version) return 'missing';
    if (version.flowId !== flow.id || version.state !== 'LOCKED' || digest(version.trigger) !== row.version_digest || flow.published_version_id !== version.id) return 'changed';
    return flow.status === 'ENABLED' ? 'enabled' : 'paused';
  }
  private next(proposalId: string): string | null {
    const rows = this.db.query<{ id: string }, [string]>(`SELECT id FROM prepared_opportunities WHERE id <> ?
      AND state = 'draft_ready' AND accepted_at IS NULL AND dismissed_at IS NULL ORDER BY created_at DESC, id`).all(proposalId);
    for (const row of rows) { try { if (this.source?.get(row.id).canApprove) return row.id; } catch { /* An unavailable candidate is not actionable. */ } }
    return null;
  }
  get(proposalId: string): OpportunityActionReceipt {
    identifier(proposalId, 'proposalId');
    if (!this.current()) throw new OpportunityActionError('Opportunity activation is unavailable', 503);
    const row = this.row(proposalId); if (!row) throw new OpportunityActionError('Activation receipt not found', 404);
    const currentActivation = this.activation(row);
    let state: Registration = row.decision === 'approve' && currentActivation !== 'enabled' ? 'blocked' : row.registration;
    if (state === 'registered' && this.triggers) {
      const observed = this.triggers.registrationState(row.flow_id!, row.version_id!);
      state = observed === 'changed' ? 'blocked' : observed;
    }
    return { receiptId: row.id, proposalId: row.proposal_id, revision: row.revision, decision: row.decision,
      workflow: row.flow_id ? { flowId: row.flow_id, versionId: row.version_id!, versionDigest: row.version_digest! } : null,
      registration: { state, message: registrationMessage(state) }, currentActivation,
      decidedAt: row.created_at, updatedAt: row.updated_at, nextProposalId: this.next(proposalId) };
  }
  submit(proposalId: string, revision: string, requestKey: string, decision: Decision): { created: boolean; receipt: OpportunityActionReceipt } {
    this.assertReady(); identifier(proposalId, 'proposalId'); identifier(revision, 'revision'); identifier(requestKey, 'idempotencyKey');
    if (decision !== 'approve' && decision !== 'dismiss') throw new OpportunityActionError('Unknown opportunity action');
    const created = this.db.transaction(() => {
      const prior = this.db.query<ActionRow, [string]>(`SELECT a.* FROM brief_opportunity_actions a
        JOIN brief_opportunity_action_requests r ON r.receipt_id = a.id WHERE r.request_key = ?`).get(requestKey);
      const existing = prior ?? this.row(proposalId);
      if (existing) {
        if (existing.proposal_id !== proposalId || existing.revision !== revision || existing.decision !== decision) throw new OpportunityActionError('This request or proposal was already settled differently', 409);
        this.db.run('INSERT OR IGNORE INTO brief_opportunity_action_requests VALUES (?, ?)', [requestKey, existing.id]);
        // Explicit retries may reconcile registration, but never republish or re-enable.
        if (existing.registration === 'blocked') this.db.run("UPDATE brief_opportunity_actions SET registration = 'pending', lease_until = 0 WHERE id = ? AND lease_token IS NULL", [existing.id]);
        return false;
      }
      const proposal = this.db.query<ProposalRow, [string]>('SELECT * FROM prepared_opportunities WHERE id = ?').get(proposalId);
      if (!proposal) throw new OpportunityActionError('Prepared opportunity not found', 404);
      if (proposal.revision !== revision) throw new OpportunityActionError('Proposal changed; reload it before deciding', 409);
      if (proposal.accepted_at || (proposal.dismissed_at && decision !== 'dismiss')) throw new OpportunityActionError('Proposal is already resolved', 409);
      if (decision === 'approve') {
        // Synchronous current qualification, including source/goal/account/target, inside the publication transaction.
        const view = this.source!.get(proposalId);
        if (view.revision !== revision || view.state === 'stale') throw new OpportunityActionError('Proposal changed; review a new prepared revision', 409);
        if (!view.canApprove || view.state !== 'ready') throw new OpportunityActionError('Proposal is not ready; review its current blockers', 422);
        const flow = proposal.flow_id ? getFlow(proposal.flow_id) : null, version = proposal.version_id ? getFlowVersion(proposal.version_id) : null;
        if (!flow || !version || flow.status !== 'DISABLED' || flow.published_version_id !== null || version.state !== 'LOCKED'
          || version.flowId !== flow.id || view.workflow?.flowId !== flow.id || view.workflow.versionId !== version.id || digest(version.trigger) !== proposal.version_digest) {
          throw new OpportunityActionError('Reviewed workflow changed; reload the proposal', 409);
        }
        try { publishFlowVersion(flow.id, version.id); }
        catch { throw new OpportunityActionError('Workflow readiness changed; review its current setup', 422); }
        this.db.run('UPDATE prepared_opportunities SET accepted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), proposalId]);
      } else {
        this.db.run(`UPDATE prepared_opportunities SET dismissed_at = COALESCE(dismissed_at, ?),
          state = CASE WHEN state IN ('queued','running') THEN 'failed' ELSE state END,
          lease_token = NULL, lease_until = 0, updated_at = ? WHERE id = ?`, [Date.now(), Date.now(), proposalId]);
      }
      const id = randomUUID(), now = Date.now();
      this.db.run(`INSERT INTO brief_opportunity_actions
        (id, proposal_id, revision, decision, registration, flow_id, version_id, version_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, proposalId, revision, decision, decision === 'approve' ? 'pending' : 'not_required',
        decision === 'approve' ? proposal.flow_id : null, decision === 'approve' ? proposal.version_id : null,
        decision === 'approve' ? proposal.version_digest : null, now, now]);
      this.db.run('INSERT INTO brief_opportunity_action_requests VALUES (?, ?)', [requestKey, id]);
      return true;
    }).immediate();
    this.kick(); return { created, receipt: this.get(proposalId) };
  }
  start(): void {
    if (this.timer || this.stopped) return;
    // A persisted registration is historical; the new runtime must observe its own subscriptions.
    this.db.run("UPDATE brief_opportunity_actions SET registration = 'pending' WHERE registration = 'registered'");
    this.timer = setInterval(() => this.kick(), 5_000); this.timer.unref(); this.kick();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  async idle(): Promise<void> { await Promise.all([...this.running.values()]); }
  kick(): void {
    if (this.stopped || !this.current() || !this.triggers) return;
    try {
      const now = Date.now();
      const rows = this.db.query<ActionRow, [number, string]>(`SELECT * FROM brief_opportunity_actions
        WHERE decision = 'approve' AND registration IN ('pending','blocked') AND lease_until <= ?
          AND id NOT IN (SELECT value FROM json_each(?))
        ORDER BY CASE registration WHEN 'pending' THEN 0 ELSE 1 END, lease_until, created_at, id LIMIT 20`)
        .all(now, JSON.stringify([...this.running.keys()]));
      for (const row of rows) {
        if (row.registration === 'blocked' && this.triggers.registrationState(row.flow_id!, row.version_id!) !== 'registered') {
          // Rotate observations as well as work: old blocked receipts must not
          // occupy every batch forever, nor can a hung local refresh do so.
          this.db.run(`UPDATE brief_opportunity_actions SET lease_until = ?
            WHERE id = ? AND registration = 'blocked' AND lease_token IS NULL AND lease_until <= ?`, [now + 5_000, row.id, now]);
          continue;
        }
        const token = randomUUID();
        const claimed = this.db.run(`UPDATE brief_opportunity_actions SET lease_token = ?, lease_until = ?
          WHERE id = ? AND lease_until <= ?`, [token, Date.now() + this.leaseMs, row.id, Date.now()]);
        if (!claimed.changes) continue;
        const work = Promise.resolve().then(() => this.reconcile(row, token)).catch(() => { this.healthy = false; })
          .finally(() => { this.running.delete(row.id); });
        this.running.set(row.id, work);
      }
      this.healthy = true;
    } catch { this.healthy = false; }
  }
  private async reconcile(row: ActionRow, token: string): Promise<void> {
    const owns = () => !this.stopped && this.current() && this.row(row.proposal_id)?.lease_token === token;
    const finish = (state: Registration) => {
      if (owns()) this.db.run(`UPDATE brief_opportunity_actions SET registration = ?, lease_token = NULL, lease_until = ?, updated_at = ?
        WHERE id = ? AND lease_token = ?`, [state, state === 'pending' ? Date.now() + 5_000 : 0, Date.now(), row.id, token]);
    };
    try {
      if (!owns()) return;
      if (this.activation(row) !== 'enabled') { finish('blocked'); return; }
      if (this.triggers!.registrationState(row.flow_id!, row.version_id!) !== 'registered') await this.triggers!.refresh(row.flow_id!);
      if (!owns()) return;
      const state = this.activation(row) === 'enabled' ? this.triggers!.registrationState(row.flow_id!, row.version_id!) : 'changed';
      finish(state === 'changed' ? 'blocked' : state);
    } catch { finish('blocked'); }
  }
}
