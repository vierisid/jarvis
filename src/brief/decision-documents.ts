import { getFlowRun } from '../workflows/db/repos/flow-run';
import type { DocumentFactBindings } from './decision-document-bindings';
import type { Database } from 'bun:sqlite';
import { ApprovalManager } from '../authority/approval';
import type { DocumentReviewRow } from '../authority/decision-document-schema';
import { getDb } from '../vault/schema';
import { getWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { governedPieceToolDefinition, resolveGovernedPieceAction } from '../workflows/runtime/piece-effects';
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
export class DecisionDocuments {
  constructor(private readonly db: Database, private readonly queue: DecisionQueue, private readonly approvals: ApprovalManager,
    private readonly updated?: (approvalId: string) => void, private readonly factBindings?: DocumentFactBindings) {}
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
    if (!row) return { decision, editable: false, document: null, generation: null, state: decision.state, actions: [], reason: 'This action has no supported document adapter. Review it through its existing controls.', options: null };
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
        guestsCanInviteOthers: input.guests_can_invite_others === true, guestsCanSeeOtherGuests: input.guests_can_see_other_guests === true } : null };
  }
  get(id: string): DocumentView { this.available(); return this.db.transaction(() => this.project(id))(); }
  receipt(id: string, requestId: string): DocumentReceipt | null {
    this.available(); if (!idText(requestId)) throw new DecisionError('Supply a request ID');
    const canonical = this.queue.get(id).decisionId;
    const row = this.db.query<{ receipt: string }, [string, string]>(
      'SELECT receipt FROM brief_decision_document_receipt WHERE decision_id=? AND request_id=?').get(canonical, requestId);
    return row ? JSON.parse(row.receipt) : null;
  }
  /** One immediate transaction serializes edits, legacy decisions, expiry and receipt replay. */
  act(id: string, body: DocumentCommand): DocumentReceipt {
    this.available();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['requestId','revision','action','document'].includes(k)) ||
      !idText(body.requestId) || !idText(body.revision) || !['save','approve','keep_draft','reopen','reject'].includes(body.action) ||
      (body.action === 'save' ? body.document === undefined : body.document !== undefined)) throw new DecisionError('Invalid document command');
    const changed: string[] = [];
    const receipt = this.db.transaction(() => {
      const view = this.project(id), canonical = view.decision.decisionId;
      const fingerprint = digest({ id: canonical, ...body });
      const prior = this.db.query<{ fingerprint: string; receipt: string }, [string]>(
        'SELECT fingerprint,receipt FROM brief_decision_document_receipt WHERE request_id=?').get(body.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new DecisionError('Request ID was used for another command', 409, 'request_conflict');
        return JSON.parse(prior.receipt) as DocumentReceipt;
      }
      if (view.decision.revision !== body.revision) throw new DecisionError('Document changed; reload before acting', 409, 'revision_conflict');
      if (!view.actions.includes(body.action)) throw new DecisionError('Action is not available for this document', 409, 'unsupported_action');
      const row = this.row(canonical)!, effect = getWorkflowEffect(row.effect_id)!;
      const old = this.approvals.getRequest(row.approval_id)!;
      let outcome: DocumentReceipt['outcome'];
      if (body.action === 'save' || body.action === 'reopen') {
        let args: Record<string, unknown>;
        try { args = applyDocument(effect.provenance.piece, effect.provenance.action, effect.arguments, body.action === 'save' ? body.document : view.document); }
        catch (e) { throw new DecisionError((e as Error).message); }
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
        if (!write.changes) throw new DecisionError('Effect changed; reload before acting', 409, 'revision_conflict');
        this.db.run(`UPDATE approval_requests SET status='expired',decided_at=?,decided_by='document_revision' WHERE id=? AND status='pending'`, [Date.now(), old.id]);
        row.approval_id = next.id; row.disposition = 'review';
        this.db.run('INSERT INTO brief_decision_document_revision VALUES (?,?,?,?,?)', [canonical, row.generation, next.id,
          JSON.stringify(projectDocument(effect.provenance.piece, effect.provenance.action, args)), Date.now()]);
        changed.push(old.id, next.id);
        outcome = body.action === 'save' ? 'revision_saved' : 'reopened';
      } else if (body.action === 'approve') {
        if (!this.approvals.approve(old.id, 'dashboard')) throw new DecisionError('Approval changed', 409, 'revision_conflict');
        changed.push(old.id); outcome = 'permission_granted';
      } else if (body.action === 'keep_draft') {
        this.db.run(`UPDATE approval_requests SET status='expired',decided_at=?,decided_by='keep_draft' WHERE id=? AND status='pending'`, [Date.now(), old.id]);
        row.disposition = 'deferred'; changed.push(old.id); outcome = 'deferred';
      } else {
        // The retained expired row is still a pending workflow document, proven
        // above under this lock. Reject it without granting or dispatching anything.
        if (old.status === 'pending') this.approvals.deny(old.id, 'dashboard');
        else this.db.run(`UPDATE approval_requests SET status='denied',decided_at=?,decided_by='dashboard' WHERE id=? AND status='expired'`, [Date.now(), old.id]);
        row.disposition = 'rejected'; changed.push(old.id); outcome = 'rejected';
      }
      this.db.run('UPDATE brief_decision_document SET approval_id=?,generation=?,disposition=? WHERE decision_id=?', [row.approval_id, row.generation, row.disposition, canonical]);
      const result: DocumentReceipt = { requestId: body.requestId, decisionId: canonical, outcome, approvalId: row.approval_id,
        generation: row.generation, revision: this.queue.get(canonical).revision, decidedAt: Date.now(), executed: false };
      this.db.run('INSERT INTO brief_decision_document_receipt VALUES (?,?,?,?)', [body.requestId, canonical, fingerprint, JSON.stringify(result)]);
      return result;
    }).immediate();
    for (const approvalId of changed) { try { this.updated?.(approvalId); } catch { /* Persisted receipt and polling remain authoritative. */ } }
    return receipt;
  }
}
