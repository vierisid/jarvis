import { getFlowRun } from '../workflows/db/repos/flow-run';
import type { DocumentFactBindings } from './decision-document-bindings';
import type { Database } from 'bun:sqlite';
import { DASHBOARD_DECIDER, type ApprovalRequest } from '../authority/approval';
import type { ActionCategory } from '../roles/authority';
import { applyApprovalDecision, heldApprovalMessage, type ApprovalDecisionDeps } from '../daemon/approval-decision';
import type { DocumentReviewRow } from '../authority/decision-document-schema';
import { getDb } from '../vault/schema';
import { getWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { governedPieceToolDefinition, resolveGovernedPieceAction } from '../workflows/runtime/piece-effects';
import { defangPieceProjection } from '../workflows/runtime/piece-effect-receipt';
import { applyDocument, documentInput, projectDocument, type DecisionDocument } from '../workflows/runtime/decision-document';
import { digest } from '../workflows/runtime/effect-context';
import { assertRunNotCanceled } from '../workflows/runtime/cancellation';
import { DecisionError, DecisionQueue } from './decisions';
import type { QueuedDecision } from './decision-contracts';

export type DocumentAction = 'save' | 'approve' | 'keep_draft' | 'reopen' | 'reject';
export interface DocumentCommand { requestId: string; revision: string; action: DocumentAction; document?: DecisionDocument }
export interface DocumentView {
  decision: QueuedDecision; editable: boolean; document: DecisionDocument | null;
  generation: number | null; state: string; actions: DocumentAction[]; reason: string | null;
  /** Options are shown as read-only facts, never accepted in an edit. */
  options: { calendarId: string; notifications: string; createMeetLink: boolean; guestsCanModify: boolean;
    guestsCanInviteOthers: boolean; guestsCanSeeOtherGuests: boolean } | null;
}
export interface DocumentReceipt {
  requestId: string; decisionId: string; outcome: 'revision_saved' | 'permission_granted' | 'deferred' | 'reopened' | 'rejected';
  approvalId: string; generation: number; revision: string; decidedAt: number;
  /** No action here establishes that an external effect or result succeeded. */
  executed: false;
}
const idText = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 256;
type Prepared = { canonical: string; fingerprint: string; replay: DocumentReceipt | null };
export class DecisionDocuments {
  /**
   * Approve and reject go through the same decision path as every other
   * surface (`applyApprovalDecision`: Pause holds, audit, broadcast), guarded by
   * this document's revision in the write transaction. Revisions and deferral
   * are this module's own writes and are audited here.
   */
  constructor(private readonly db: Database, private readonly queue: DecisionQueue, private readonly authority: ApprovalDecisionDeps,
    private readonly factBindings?: DocumentFactBindings) {}
  private get approvals() { return this.authority.approvalManager; }
  readiness(): 'ready' | 'unavailable' { try { return this.factBindings?.available !== false && getDb() === this.db && this.queue.readiness() === 'ready' ? 'ready' : 'unavailable'; } catch { return 'unavailable'; } }
  private available() { if (this.readiness() !== 'ready') throw new DecisionError('Document reviews are unavailable', 503, 'unavailable'); }
  private row(id: string): DocumentReviewRow | null {
    return this.db.query<DocumentReviewRow, [string]>('SELECT * FROM brief_decision_document WHERE decision_id=?').get(id);
  }
  private mutable(row: DocumentReviewRow, effect: WorkflowEffect | null): boolean {
    if (!effect || effect.status !== 'pending' || effect.approvalId !== row.approval_id || row.disposition === 'rejected') return false;
    if ('bindings' in effect && !this.factBindings) return false; // no silent downgrade of an owner-bound document
    const approval = this.approvals.getRequest(row.approval_id);
    if (!approval || !['pending','expired'].includes(approval.status) || approval.execution_mode !== 'workflow' || approval.execution_claimed_at ||
      digest(JSON.parse(approval.tool_arguments)) !== digest(effect.arguments)) return false;
    const run = getFlowRun(effect.runId);
    if (!run || !['PAUSED','RUNNING'].includes(run.status)) return false;
    const waiting = this.db.query('SELECT 1 FROM waitpoint WHERE id=? AND resumed_at IS NULL').get(effect.waitpointId);
    if (!waiting) return false;
    try { assertRunNotCanceled(effect.runId); } catch { return false; }
    return true;
  }
  private project(id: string): DocumentView {
    const decision = this.queue.get(id), row = this.row(decision.decisionId);
    // The queue lists only effects in its own project, so a document whose effect
    // it does not reference belongs to another project and is not shown here.
    if (!row || !decision.refs.some(ref => ref.kind === 'effect' && ref.id === row.effect_id)) return { decision, editable: false, document: null, generation: null, state: decision.state, actions: [], reason: 'This action has no supported document adapter. Review it through its existing controls.', options: null };
    const effect = getWorkflowEffect(row.effect_id), approval = this.approvals.getRequest(row.approval_id);
    const input = effect && documentInput(effect.provenance.piece, effect.provenance.action, effect.arguments);
    const editable = !!input && this.mutable(row, effect);
    const state = approval?.status === 'denied' || row.disposition === 'rejected' ? 'rejected'
      : row.disposition === 'deferred' ? 'deferred' : approval?.status === 'expired' ? 'expired'
      : effect && ['blocked','failed','unknown','dispatching'].includes(effect.status) ? effect.status
      : effect?.status === 'succeeded' ? 'dispatch_authorized' : approval?.status === 'approved' ? 'permission_granted' : decision.state;
    const document = input && effect ? projectDocument(effect.provenance.piece, effect.provenance.action, input) : null;
    return { decision, editable, document, generation: row.generation, state,
      actions: editable ? (state === 'deferred' || state === 'expired' ? ['save','reopen','keep_draft','reject'] : ['save','approve','keep_draft','reject']) : [],
      reason: editable ? null : 'This document is no longer open for edits. Inspect its current decision and run state.',
      options: document?.kind === 'calendar' && input ? { calendarId: String(input.calendar_id), notifications: String(input.send_notifications),
        createMeetLink: input.create_meet_link === true, guestsCanModify: input.guests_can_modify === true,
        // The piece omits unspecified guest permissions; Google's defaults for
        // inviting others and seeing attendees are true (modify defaults false).
        guestsCanInviteOthers: input.guests_can_invite_others !== false, guestsCanSeeOtherGuests: input.guests_can_see_other_guests !== false } : null };
  }
  get(id: string): DocumentView { this.available(); return this.db.transaction(() => this.project(id))(); }
  receipt(id: string, requestId: string): DocumentReceipt | null {
    this.available(); if (!idText(requestId)) throw new DecisionError('Supply a request ID');
    const canonical = this.queue.get(id).decisionId;
    const row = this.db.query<{ receipt: string }, [string, string]>(
      'SELECT receipt FROM brief_decision_document_receipt WHERE decision_id=? AND request_id=?').get(canonical, requestId);
    return row ? JSON.parse(row.receipt) : null;
  }
  /** Replays a recorded receipt, or proves the command is current for this revision. Runs inside a write transaction. */
  private prepare(id: string, body: DocumentCommand): Prepared & { view: DocumentView } {
    const view = this.project(id), canonical = view.decision.decisionId;
    const fingerprint = digest({ id: canonical, ...body });
    const prior = this.db.query<{ fingerprint: string; receipt: string }, [string]>(
      'SELECT fingerprint,receipt FROM brief_decision_document_receipt WHERE request_id=?').get(body.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new DecisionError('Request ID was used for another command', 409, 'request_conflict');
      return { view, canonical, fingerprint, replay: JSON.parse(prior.receipt) as DocumentReceipt };
    }
    if (view.decision.revision !== body.revision) throw new DecisionError('Document changed; reload before acting', 409, 'revision_conflict');
    if (!view.actions.includes(body.action)) throw new DecisionError('Action is not available for this document', 409, 'unsupported_action');
    return { view, canonical, fingerprint, replay: null };
  }
  private record(body: DocumentCommand, prepared: Prepared, row: DocumentReviewRow, outcome: DocumentReceipt['outcome']): DocumentReceipt {
    this.db.run('UPDATE brief_decision_document SET approval_id=?,generation=?,disposition=? WHERE decision_id=?', [row.approval_id, row.generation, row.disposition, prepared.canonical]);
    const result: DocumentReceipt = { requestId: body.requestId, decisionId: prepared.canonical, outcome, approvalId: row.approval_id,
      generation: row.generation, revision: this.queue.get(prepared.canonical).revision, decidedAt: Date.now(), executed: false };
    this.db.run('INSERT INTO brief_decision_document_receipt VALUES (?,?,?,?)', [body.requestId, prepared.canonical, prepared.fingerprint, JSON.stringify(result)]);
    return result;
  }
  private audit(request: ApprovalRequest, decision: 'denied' | 'approval_required'): void {
    try {
      this.authority.auditTrail?.log({ agent_id: request.agent_id, agent_name: request.agent_name, tool_name: request.tool_name,
        action_category: request.action_category as ActionCategory, authority_decision: decision, approval_id: request.id,
        executed: false, channel: 'click' });
    } catch (err) { console.warn('[Brief] could not audit a document decision:', err instanceof Error ? err.message : err); }
  }
  private broadcast(approvalIds: string[]): void {
    for (const approvalId of approvalIds) {
      try { const request = this.approvals.getRequest(approvalId); if (request) this.authority.wsService?.broadcastApprovalUpdate(request); }
      catch { /* Persisted receipt and polling remain authoritative. */ }
    }
  }
  async act(id: string, body: DocumentCommand): Promise<DocumentReceipt> {
    this.available();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['requestId','revision','action','document'].includes(k)) ||
      !idText(body.requestId) || !idText(body.revision) || !['save','approve','keep_draft','reopen','reject'].includes(body.action) ||
      (body.action === 'save' ? body.document === undefined : body.document !== undefined)) throw new DecisionError('Invalid document command');
    if (body.action === 'approve' || (body.action === 'reject' && this.pendingApproval(id))) return this.decide(id, body);
    const changed: string[] = [];
    const receipt = this.db.transaction(() => {
      const prepared = this.prepare(id, body);
      if (prepared.replay) return prepared.replay;
      const { view, canonical } = prepared;
      const row = this.row(canonical)!, effect = getWorkflowEffect(row.effect_id)!;
      const old = this.approvals.getRequest(row.approval_id)!;
      let outcome: DocumentReceipt['outcome'];
      if (body.action === 'save' || body.action === 'reopen') {
        let args: Record<string, unknown>;
        try { args = applyDocument(effect.provenance.piece, effect.provenance.action, effect.arguments, body.action === 'save' ? body.document : view.document); }
        catch (e) { throw new DecisionError((e as Error).message); }
        // The text a card and the approval row carry is never one the delimiter
        // defang would rewrite (#634): refuse it rather than alter what is sent.
        if (digest(defangPieceProjection(args)) !== digest(args)) throw new DecisionError('Document text contains a reserved content delimiter');
        const resolved = resolveGovernedPieceAction(String(effect.provenance.piece), String(effect.provenance.action));
        if (!resolved) throw new DecisionError('Document adapter is unavailable', 409, 'unsupported_action');
        const target = governedPieceToolDefinition(resolved).workflowEffect!.target(args);
        const next = this.approvals.createRequest({ agentId: old.agent_id, agentName: old.agent_name,
          toolName: old.tool_name, toolArguments: args, actionCategory: old.action_category, urgency: old.urgency,
          reason: old.reason, context: JSON.stringify({ ...JSON.parse(old.context), target }), executionMode: 'workflow' });
        row.generation++;
        let bindingUpdate: Record<string, unknown> = {};
        if (this.factBindings) {
          try { bindingUpdate = { bindings: { ...((effect as WorkflowEffect & { bindings?: Record<string, unknown> }).bindings ?? {}), facts: this.factBindings.capture(args, (effect as WorkflowEffect & { bindings?: { facts?: unknown[] } }).bindings?.facts) } }; }
          catch { throw new DecisionError('Recipient facts are stale or unavailable; refresh them before saving', 409, 'binding_conflict'); }
        }
        const replacement = { ...effect, ...bindingUpdate, arguments: args, target, approvalId: next.id, documentRevision: row.generation };
        const write = this.db.run(`UPDATE workflow_effect SET approval_id=?,record=? WHERE id=? AND status='pending' AND approval_id=?
          AND coalesce(json_extract(record,'$.documentRevision'),0)=?`, [next.id, JSON.stringify(replacement), effect.id, old.id, row.generation - 1]);
        if (write.changes !== 1) throw new DecisionError('Effect changed; reload before acting', 409, 'revision_conflict');
        this.db.run(`UPDATE approval_requests SET status='expired',decided_at=?,decided_by='document_revision' WHERE id=? AND status='pending'`, [Date.now(), old.id]);
        row.approval_id = next.id; row.disposition = 'review';
        this.db.run('INSERT INTO brief_decision_document_revision VALUES (?,?,?,?,?)', [canonical, row.generation, next.id,
          JSON.stringify(projectDocument(effect.provenance.piece, effect.provenance.action, args)), Date.now()]);
        this.audit(next, 'approval_required');
        changed.push(old.id, next.id);
        outcome = body.action === 'save' ? 'revision_saved' : 'reopened';
      } else if (body.action === 'keep_draft') {
        this.db.run(`UPDATE approval_requests SET status='expired',decided_at=?,decided_by='keep_draft' WHERE id=? AND status='pending'`, [Date.now(), old.id]);
        row.disposition = 'deferred'; changed.push(old.id); outcome = 'deferred';
      } else {
        // An expired or kept draft has no pending approval for the shared
        // decision path to deny. It is still a pending workflow document, proven
        // above under this lock: reject it without granting or dispatching anything.
        const write = this.db.run(`UPDATE approval_requests SET status='denied',decided_at=?,decided_by=? WHERE id=? AND status='expired'`, [Date.now(), DASHBOARD_DECIDER, old.id]);
        if (write.changes !== 1) throw new DecisionError('Approval changed', 409, 'revision_conflict');
        const denied = this.approvals.getRequest(old.id)!;
        this.audit(denied, 'denied'); this.authority.deferredExecutor.recordDenial(denied);
        row.disposition = 'rejected'; changed.push(old.id); outcome = 'rejected';
      }
      return this.record(body, prepared, row, outcome);
    }).immediate();
    this.broadcast(changed);
    return receipt;
  }
  private pendingApproval(id: string): boolean {
    try { const approvalId = this.queue.get(id).approval?.approvalId; return !!approvalId && this.approvals.getRequest(approvalId)?.status === 'pending'; }
    catch { return false; }
  }
  /** Approve, or reject a pending review, through the shared decision path. */
  private async decide(id: string, body: DocumentCommand): Promise<DocumentReceipt> {
    let prepared!: Prepared;
    const replay = this.db.transaction(() => { prepared = this.prepare(id, body); return prepared.replay; })();
    if (replay) return replay;
    const approvalId = this.row(prepared.canonical)!.approval_id;
    // Rechecked in the same write transaction as the approval flip.
    const assertCurrent = () => { const current = this.prepare(id, body); if (current.replay) throw new DecisionError('Request already applied', 409, 'request_conflict'); };
    const result = await applyApprovalDecision(body.action === 'approve' ? 'approve' : 'deny', approvalId, DASHBOARD_DECIDER, { ...this.authority, assertCurrent });
    if (result.status === 'already_decided') throw new DecisionError('Approval changed', 409, 'revision_conflict');
    // Pause holds and Kill stops (Q-08): the card stays pending and says why.
    if (result.status === 'held') throw new DecisionError(heldApprovalMessage(result.state), 409, 'held');
    if (result.status === 'needs_dashboard') throw new DecisionError('Approve this on its dashboard approval card', 409, 'needs_dashboard');
    return this.db.transaction(() => {
      const row = this.row(prepared.canonical)!;
      if (body.action === 'reject') row.disposition = 'rejected';
      return this.record(body, prepared, row, body.action === 'approve' ? 'permission_granted' : 'rejected');
    }).immediate();
  }
}
