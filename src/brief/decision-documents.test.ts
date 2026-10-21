import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { cancelFlowRun, retireTerminalRunWaits } from '../workflows/db/repos/run-cancellation';
import { getWorkflowEffect, listWorkflowEffects, saveWorkflowEffect, claimWorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { AuthorityEngine } from '../authority/engine';
import { ApprovalManager } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { EmergencyController, setActiveEmergencyController } from '../authority/emergency';
import { DeferredExecutor } from '../authority/deferred-executor';
import { CredentialResolver } from '../workflows/credentials/adapter';
import { WorkflowEventBuffer } from '../workflows/runtime/event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from '../workflows/runtime/service-backends';
import { authorizePieceDispatch } from '../workflows/runtime/piece-effect-guard';
import { reprojectPieceInput, sanitizePieceInput } from '../workflows/runtime/piece-effects';
import { defangPieceProjection } from '../workflows/runtime/piece-effect-receipt';
import { digest } from '../workflows/runtime/effect-context';
import { documentInput, validateDecisionDocument } from '../workflows/runtime/decision-document';
import { resumeResolvedWorkflowEffects } from '../workflows/runtime/effect-approval-scheduler';
import { DecisionQueue } from './decisions';
import { documentFactBindings } from './decision-document-bindings';
import { createHash } from 'node:crypto';
import { createEntity } from '../vault/entities';
import { createFact, deleteFact, correctFact } from '../vault/facts';
import { existsSync } from 'node:fs';
import { createWorkItem } from '../goals/work-items';
import { DecisionDocuments, type DocumentCommand } from './decision-documents';

const GMAIL = '@activepieces/piece-gmail', CAL = '@activepieces/piece-google-calendar';
const email = { receiver: ['first@example.test'], cc: [], bcc: [], subject: 'Follow up', body: 'Original body', body_type: 'plain_text', draft: false };
const event = { calendar_id: 'primary', title: 'Review', description: 'Original agenda', start_date_time: '2026-11-01T09:00:00Z', end_date_time: '2026-11-01T09:30:00Z', attendees: ['first@example.test'], location: '', send_notifications: 'all' };
let dir: string, file: string, manager: ApprovalManager, queue: DecisionQueue, documents: DecisionDocuments;
let deps: { approvalManager: ApprovalManager; deferredExecutor: DeferredExecutor };
function wire() {
  manager = new ApprovalManager(); deps = { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) };
  queue = new DecisionQueue(getDb(), deps);
  documents = new DecisionDocuments(getDb(), queue, deps);
}
/** What the engine sends for the fixture token on a tracked send (Q-07). */
const CREDENTIAL_DIGEST = createHash('sha256').update(JSON.stringify('ENGINE_ONLY_SECRET')).digest('hex');
/** The engine's Q-08 digest of a step's whole input (`pieceInputDigest`), computed synchronously. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item) ?? 'null';
const inputDigest = (input: Record<string, unknown>) => { const { auth: _auth, ...rest } = input; return createHash('sha256').update(canonical(rest)).digest('hex'); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-f14-')); file = join(dir, 'db.sqlite'); initWorkflowDb(file); wire(); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
function setup(piece = GMAIL, action = 'send_email', input: Record<string, unknown> = email, extra: Partial<BuildServiceBackendsOptions> = {}) {
  const flow = createFlow({}), version = createDraftVersion({ flowId: flow.id, displayName: 'Document fixture', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: { pieceName: piece, pieceVersion: '0.0.1', actionName: action, input: {} } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: ['send_email','write_data'], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const emergency = new EmergencyController();
  const options: BuildServiceBackendsOptions = { decisionDocumentsEnabled: true, credentialResolver: new CredentialResolver(), llmManager: {} as any,
    authorityEngine: authority, emergencyController: emergency, auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(), approvalManager: manager,
    channelService: {} as any, wsService: {} as any, ...extra };
  const backend = buildSandboxServiceBackends(options), context = { runId: run.id, projectId: run.projectId, stepName: 'action', executionPath: [] };
  const request = { piece, action, input, documentProtocol: 1 as const, inputDigest: inputDigest(input), credentialDigest: CREDENTIAL_DIGEST };
  const authorize = () => backend.pieceAuthorize!(request, context);
  const pending = async () => { const reply = await authorize(); if (!reply.governed || reply.dispatch !== 'approval_required') throw Error('Expected approval'); return documents.get(`approval:${reply.approval.approvalId}`); };
  const command = async (id: string, action: DocumentCommand['action'], document?: any) => documents.act(id, { requestId: crypto.randomUUID(), revision: documents.get(id).decision.revision, action, ...(document ? { document } : {}) });
  const engine = async () => {
    const processed: Record<string, unknown> = { ...structuredClone(input), auth: { access_token: 'ENGINE_ONLY_SECRET' } };
    const reply = await authorizePieceDispatch({ apiUrl: 'http://fixture', engineToken: 'fixture', piece, action, stepName: 'action', executionPath: [], input: processed,
      fetchImpl: (async (_url, init) => { const req = JSON.parse(String(init!.body)); expect(JSON.stringify(req)).not.toContain('ENGINE_ONLY_SECRET'); return Response.json(await backend.pieceAuthorize!(req, context)); }) as typeof fetch });
    return { reply, processed };
  };
  return { flow, version, run, authority, emergency, backend, context, request, authorize, pending, command, engine };
}

test('email edit saves a new pending revision, retires every old approval control and dispatches edited parameters only', async () => {
  const f = setup(), initial = await f.pending(), id = initial.decision.decisionId, old = initial.decision.approval!.approvalId;
  queue.place(id, initial.decision.revision, -3);
  const before = documents.get(id), originalEffect = listWorkflowEffects(f.run.id)[0]!;
  const edit = { ...before.document!, to: ['second@example.test'], subject: 'Revised', body: 'Edited body '.repeat(200) };
  const receipt = await f.command(id, 'save', edit), after = documents.get(id);
  expect(receipt).toMatchObject({ outcome: 'revision_saved', executed: false, generation: 1 });
  expect(after.document).toEqual(edit); expect(after.decision.placement).toBe(-3); expect(after.decision.createdAt).toBe(initial.decision.createdAt);
  expect(after.decision.decisionId).toBe(id); expect(after.decision.approval!.status).toBe('pending');
  expect(after.decision.approval!.approvalId).not.toBe(old); expect(manager.getRequest(old)!.status).toBe('expired');
  expect(manager.approve(old, 'legacy')).toBeNull();
  await expect(queue.resolve(id, { revision: before.decision.revision, action: 'approve_permission' })).rejects.toThrow(/changed/);
  expect(claimWorkflowEffect(originalEffect)).toBe(false);
  expect(() => saveWorkflowEffect({ ...originalEffect, status: 'blocked' })).toThrow(/stale/);
  expect((await queue.read()).data.items.map(x => x.decisionId)).toEqual([id]);
  expect(queue.get(`effect:${originalEffect.id}`).decisionId).toBe(id);
  expect((await f.engine()).reply).toMatchObject({ dispatch: 'approval_required' });
  await f.command(id, 'approve');
  expect(documents.get(id).state).toBe('permission_granted');
  const execution = await f.engine();
  expect(execution.reply).toMatchObject({ dispatch: 'authorized' });
  expect(execution.processed).toMatchObject({ receiver: edit.to, body: edit.body, subject: edit.subject, auth: { access_token: 'ENGINE_ONLY_SECRET' } });
  expect(listWorkflowEffects(f.run.id)[0]!.arguments.body).toBe(edit.body);
  expect(documents.get(id).editable).toBe(false);
  // A tracked send (Q-07) stays dispatching until the engine's completion receipt,
  // and a retry before it is refused rather than sent again.
  expect(documents.get(id).state).toBe('dispatching');
  await expect(f.engine()).rejects.toThrow(/in flight/);
});

test('date and attendee edits are frozen, calendar and notification options stay read-only', async () => {
  const f = setup(CAL, 'google_calendar_create_event', event), view = await f.pending(), id = view.decision.decisionId;
  const edit = { ...view.document!, start: '2026-12-03T14:00:00+01:00', end: '2026-12-03T15:00:00+01:00', attendees: ['second@example.test'] };
  await f.command(id, 'save', edit); expect(manager.approve(view.decision.approval!.approvalId, 'legacy')).toBeNull();
  expect(documents.get(id).options).toMatchObject({ calendarId: 'primary', notifications: 'all' });
  await expect(f.command(id, 'save', { ...edit, calendarId: 'attacker' })).rejects.toThrow(/Unknown/);
  await f.command(id, 'approve'); const result = await f.engine();
  expect(result.processed).toMatchObject({ calendar_id: 'primary', send_notifications: 'all', start_date_time: edit.start, end_date_time: edit.end, attendees: edit.attendees });
});

test('deferral retires permission, survives expiry and restart, stays queued and requires fresh review', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const saved = await f.command(id, 'keep_draft'); updateRun(f.run.id, { status: 'PAUSED' });
  expect(saved).toMatchObject({ outcome: 'deferred', executed: false });
  expect(manager.approve(saved.approvalId, 'legacy')).toBeNull(); expect(resumeResolvedWorkflowEffects()).toBe(0);
  manager.expireOld(0); closeDb(); initWorkflowDb(file); wire();
  const kept = documents.get(id); expect(kept.state).toBe('deferred'); expect(kept.editable).toBe(true);
  expect((await queue.read()).data.items.map(x => x.decisionId)).toEqual([id]);
  expect(queue.get(id).supportedActions).toEqual(['inspect']);
  await expect(f.command(id, 'approve')).rejects.toThrow(/not available/);
  expect((await f.command(id, 'keep_draft')).outcome).toBe('deferred');
  const reopened = await f.command(id, 'reopen'); expect(reopened.approvalId).not.toBe(saved.approvalId);
  expect(documents.get(id).decision.approval!.status).toBe('pending'); expect(resumeResolvedWorkflowEffects()).toBe(0);
  await f.command(id, 'approve'); expect(resumeResolvedWorkflowEffects()).toBe(1); expect(resumeResolvedWorkflowEffects()).toBe(0);
});

test.each(['canceled','finished'] as const)('a kept draft whose run is %s reads blocked, not deferred, in the document and the queue (#1094)', async how => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  await f.command(id, 'keep_draft'); expect(documents.get(id).state).toBe('deferred'); expect(queue.get(id).state).toBe('deferred');
  if (how === 'canceled') expect(cancelFlowRun(f.run.id).accepted).toBe(true);
  else { updateRun(f.run.id, { status: 'SUCCEEDED' }); retireTerminalRunWaits(f.run.id); }
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('blocked');
  expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('expired');
  const kept = documents.get(id); expect(kept.state).toBe('blocked'); expect(kept.editable).toBe(false); expect(kept.actions).toEqual([]);
  expect(queue.get(id).state).toBe('blocked');
});

test('a kept draft whose effect row is gone still reads deferred in the queue (#1094 fallback)', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  await f.command(id, 'keep_draft');
  getDb().run('DELETE FROM workflow_effect WHERE run_id=?', [f.run.id]); expect(listWorkflowEffects(f.run.id)).toEqual([]);
  expect(queue.get(id).state).toBe('deferred');
});

test('an expired review whose run is canceled reads blocked like the queue, not expired (#1094)', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  getDb().run('UPDATE approval_requests SET created_at=0 WHERE id=?', [view.decision.approval!.approvalId]);
  manager.expireOld(1); expect(documents.get(id).state).toBe('expired');
  expect(cancelFlowRun(f.run.id).accepted).toBe(true);
  expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('expired');
  expect(documents.get(id).state).toBe('blocked'); expect(queue.get(id).state).toBe('blocked');
});

test('an expired review can be edited and approved after reload without silently resuming', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  getDb().run('UPDATE approval_requests SET created_at=0 WHERE id=?', [view.decision.approval!.approvalId]);
  manager.expireOld(1); updateRun(f.run.id, { status: 'PAUSED' });
  expect(resumeResolvedWorkflowEffects()).toBe(0); expect(documents.get(id).state).toBe('expired');
  await expect(f.command(id, 'approve')).rejects.toThrow(/not available/);
  await f.command(id, 'save', { ...view.document!, body: 'New review after expiry' });
  expect(documents.get(id).decision.approval!.status).toBe('pending');
  await f.command(id, 'approve'); expect(resumeResolvedWorkflowEffects()).toBe(1);
});

test.each(['review','deferred','expired'] as const)('rejecting %s never grants permission and resumes only to a blocked receipt', async state => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  if (state === 'deferred') await f.command(id, 'keep_draft');
  if (state === 'expired') getDb().run("UPDATE approval_requests SET status='expired' WHERE id=?", [view.decision.approval!.approvalId]);
  const receipt = await f.command(id, 'reject'); expect(receipt).toMatchObject({ outcome: 'rejected', executed: false });
  updateRun(f.run.id, { status: 'PAUSED' }); expect(resumeResolvedWorkflowEffects()).toBe(1);
  updateRun(f.run.id, { status: 'RUNNING' }); await expect(f.engine()).rejects.toThrow(/denied/);
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('blocked'); expect(documents.get(id).state).toBe('rejected');
  expect(documents.get(id).actions).toEqual([]); expect(manager.getRequest(receipt.approvalId)!.execution_outcome).toBeNull();
});

test('lost responses replay exact durable receipts; conflicting reuse and stale edits fail', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const body: DocumentCommand = { requestId: 'lost-save', revision: view.decision.revision, action: 'save', document: { ...view.document!, body: 'Retain me' } as any };
  const receipt = await documents.act(id, body); await f.command(id, 'keep_draft');
  closeDb(); initWorkflowDb(file); wire();
  expect(await documents.act(id, body)).toEqual(receipt); expect(documents.receipt(id, body.requestId)).toEqual(receipt);
  expect(documents.get(id).state).toBe('deferred');
  await expect(documents.act(id, { ...body, action: 'reopen', document: undefined })).rejects.toThrow(/Request ID/);
  await expect(documents.act(id, { ...body, requestId: 'stale' })).rejects.toThrow(/changed/);
  expect(getDb().query('SELECT * FROM brief_decision_document_revision').all()).toHaveLength(2);
});

test.each(['save','keep_draft'] as const)('legacy approval wins against a subsequent %s without changing its reviewed arguments', async action => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  manager.approve(view.decision.approval!.approvalId, 'legacy');
  await expect(documents.act(id, { requestId: crypto.randomUUID(), revision: view.decision.revision, action, ...(action === 'save' ? { document: view.document! } : {}) })).rejects.toThrow(/changed/);
  expect((await f.engine()).processed.body).toBe(email.body);
});

test('an edit during notification delivery replaces the in-memory approval snapshot without overwriting it', async () => {
  let release!: () => void, delivered!: () => void;
  const notification = new Promise<void>(resolve => { delivered = resolve; });
  const f = setup(GMAIL, 'send_email', email, { onWorkflowApproval: async () => { delivered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const pending = f.authorize(); await notification;
  const original = listWorkflowEffects(f.run.id)[0]!, id = `approval:${original.approvalId}`;
  const next = await f.command(id, 'save', { ...documents.get(id).document!, body: 'Edit during delivery' }); release();
  expect(await pending).toMatchObject({ approval: { approvalId: next.approvalId } });
  expect(getWorkflowEffect(original.id)!.arguments.body).toBe('Edit during delivery');
});

test('old engines, changed workflow input and changed policy cannot dispatch an edited document', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  await f.command(id, 'save', { ...view.document!, body: 'Changed' }); await f.command(id, 'approve');
  await expect(f.backend.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input: sanitizePieceInput(email), inputDigest: inputDigest(email), credentialDigest: CREDENTIAL_DIGEST }, f.context)).rejects.toThrow(/changed/);
  await expect(f.backend.pieceAuthorize!({ ...f.request, input: { ...email, subject: 'Changed upstream' } }, f.context)).rejects.toThrow(/changed/);
  f.authority.addOverride({ action: 'send_email', allowed: false });
  await expect(f.engine()).rejects.toThrow(/denied/); expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('blocked');
  expect(documents.get(id).state).toBe('blocked');
});

test('unsupported and pre-protocol actions stay read-only; enabling enrollment is explicit', async () => {
  const f = setup(GMAIL, 'send_email', email, { decisionDocumentsEnabled: false });
  const view = await f.pending(); expect(view.editable).toBe(false); expect(view.document).toBeNull();
  await expect(f.command(view.decision.decisionId, 'keep_draft')).rejects.toThrow(/not available/);
  for (const input of [{ ...email, body_type: 'html' }, { ...email, attachments: [{ file: 'x' }] }, { ...email, from: 'other@example.test' }, { ...email, body: 'x'.repeat(16001) }, { ...email, secret: 'not allowed' }, { ...email, body: '<<<UNTRUSTED_CONTENT hostile' }]) expect(documentInput(GMAIL, 'send_email', input)).toBeNull();
  expect(documentInput(GMAIL, 'custom_api_call', email)).toBeNull();
});

test('strict edits reject injection, malformed recipients, unknown fields, reversed dates and oversized documents', () => {
  for (const doc of [ { kind: 'email', to: ['person@example.test\nBcc: other@example.test'], cc: [], bcc: [], subject: 'Hi', body: 'Body' },
    { kind: 'email', to: ['person@example.test'], cc: [], bcc: [], subject: 'Hi', body: 'x'.repeat(16001) },
    { kind: 'email', to: ['person@example.test'], cc: [], bcc: [], subject: 'Hi', body: '<<<UNTRUSTED_CONTENT invalid' },
    { kind: 'calendar', title: 'Hi', description: '', start: '2026-01-01T10:00:00', end: '2026-01-01T11:00:00', attendees: [], location: '' },
    { kind: 'calendar', title: 'Hi', description: '', start: '2026-01-01T10:00:00Z', end: '2026-01-01T09:00:00Z', attendees: [], location: '' } ]) expect(() => validateDecisionDocument(doc)).toThrow();
});

test('document views and receipts never expose credentials, raw approval context or waitpoint secrets', async () => {
  const f = setup(), view = await f.pending(), effect = listWorkflowEffects(f.run.id)[0]!;
  const text = JSON.stringify(view) + JSON.stringify(await f.command(view.decision.decisionId, 'keep_draft'));
  for (const secret of ['ENGINE_ONLY_SECRET', effect.waitpointId!, 'tool_arguments', 'sandboxId', 'executionPath']) expect(text).not.toContain(secret);
});


test('F-13 links a revised document to the existing work and queue position', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const work = createWorkItem({ title: 'Fixture work' });
  getDb().run('UPDATE commitment_work SET run_id=? WHERE work_id=?', [f.run.id, work.id]);
  queue.place(id, documents.get(id).decision.revision, -5);
  await f.command(id, 'save', { ...view.document!, body: 'Work-linked edit' });
  expect(queue.recommendWork(work.id, false)).toMatchObject({ decisionId: id, placement: -5, workItemId: work.id });
});

test('editing terminal or resumed runs is refused, even when an approval is still pending', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  updateRun(f.run.id, { status: 'FAILED' }); expect(documents.get(id).editable).toBe(false);
  updateRun(f.run.id, { status: 'RUNNING' });
  getDb().run('UPDATE waitpoint SET resumed_at=1 WHERE id=?', [listWorkflowEffects(f.run.id)[0]!.waitpointId]);
  await expect(f.command(id, 'save', view.document)).rejects.toThrow(/not available/);
  expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('pending');
});

test('notification failures cannot erase committed document receipts', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const noisy = new DecisionDocuments(getDb(), queue, { ...deps, wsService: { broadcastApprovalUpdate() { throw Error('Socket closed'); } } });
  const command: DocumentCommand = { requestId: 'socket-failure', revision: view.decision.revision, action: 'keep_draft' };
  const receipt = await noisy.act(id, command); expect(receipt.outcome).toBe('deferred');
  expect(await noisy.act(id, command)).toEqual(receipt); expect(documents.get(id).state).toBe('deferred');
});

test('a bound effect cannot silently downgrade without its owner binding adapter', async () => {
  const f = setup(), view = await f.pending(), effect = listWorkflowEffects(f.run.id)[0]!;
  saveWorkflowEffect({ ...effect, bindings: { facts: [] } } as typeof effect);
  expect(documents.get(view.decision.decisionId).editable).toBe(false);
  const unavailable = new DecisionDocuments(getDb(), queue, deps, { available: false, capture: () => [] });
  expect(unavailable.readiness()).toBe('unavailable');
});

test('actual Q-05 binds edited recipients and retains deleted original facts for unchanged recipients', async () => {
  const bindings = documentFactBindings();
  documents = new DecisionDocuments(getDb(), queue, deps, bindings);
  const first = createFact(createEntity('person', 'First').id, 'email', 'first@example.test', { confirmed: true });
  const second = createFact(createEntity('person', 'Second').id, 'email', 'second@example.test', { confirmed: true });
  const f = setup(), view = await f.pending(), effect = listWorkflowEffects(f.run.id)[0]!, id = view.decision.decisionId;
  saveWorkflowEffect({ ...effect, bindings: { facts: bindings.capture(effect.arguments) } } as typeof effect);
  await f.command(id, 'save', { ...view.document!, to: ['second@example.test'] });
  const edited = getWorkflowEffect(effect.id)! as typeof effect & { bindings: { facts: unknown[] } };
  expect(edited.bindings.facts).toEqual([{ value: 'second@example.test', factIds: [second.id] }]);
  deleteFact(first.id); // no longer a dependency after a deliberate address edit
  await f.command(id, 'save', { ...documents.get(id).document!, body: 'Safe body edit' });
  deleteFact(second.id); const before = documents.get(id);
  await expect(f.command(id, 'save', { ...before.document!, body: 'Must retain deleted dependency' })).rejects.toThrow(/Recipient facts/);
  expect(documents.get(id)).toEqual(before);
  const stale = createFact(createEntity('person', 'Stale').id, 'email', 'stale@example.test', { confirmed: true });
  correctFact(stale.id, 'current@example.test', 'Moved');
  await expect(f.command(id, 'save', { ...before.document!, to: ['stale@example.test'] })).rejects.toThrow(/Recipient facts/);
  expect(documents.get(id)).toEqual(before);
});

test('two independent processes cannot save and approve the same document revision', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const script = join(dir, 'worker.ts');
  const root = new URL('../../', import.meta.url).pathname;
  await Bun.write(script, `
    import { initWorkflowDb } from '${root}src/workflows/db';
    import { getDb, closeDb } from '${root}src/vault/schema';
    import { ApprovalManager } from '${root}src/authority/approval';
    import { AuditTrail } from '${root}src/authority/audit';
    import { DeferredExecutor } from '${root}src/authority/deferred-executor';
    import { DecisionQueue } from '${root}src/brief/decisions';
    import { DecisionDocuments } from '${root}src/brief/decision-documents';
    import { existsSync } from 'node:fs';
    const [file,id,body,ready,go]=process.argv.slice(2);
    initWorkflowDb(file); getDb().run('PRAGMA busy_timeout=5000');
    const manager=new ApprovalManager(), deps={approvalManager:manager,deferredExecutor:new DeferredExecutor(manager,new AuditTrail())}, queue=new DecisionQueue(getDb(),deps);
    const docs=new DecisionDocuments(getDb(),queue,deps);
    await Bun.write(ready,'ready');
    while(!existsSync(go)) await Bun.sleep(5);
    try { const receipt=await docs.act(id,JSON.parse(body)); console.log(JSON.stringify({outcome:receipt.outcome})); }
    catch(e) { console.log(JSON.stringify({error:e.code})); } finally { closeDb(); }
  `);
  const go = join(dir, 'go');
  const bodies = [ { requestId: 'concurrent-save', revision: view.decision.revision, action: 'save', document: { ...view.document!, body: 'Concurrent body' } },
    { requestId: 'concurrent-approve', revision: view.decision.revision, action: 'approve' } ];
  const workers: Bun.Subprocess<'ignore','pipe','pipe'>[] = [];
  try {
    // Schema migration is a boot operation. Initialize connections serially,
    // then race only the approval/edit transaction being tested.
    for (const [i, body] of bodies.entries()) {
      const ready = join(dir, `ready${i}`);
      const child = Bun.spawn([process.execPath, script, file, id, JSON.stringify(body), ready, go], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      workers.push(child);
      const until = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < until && child.exitCode === null) await Bun.sleep(10);
      if (child.exitCode !== null) throw Error(await new Response(child.stderr).text());
      expect(existsSync(ready)).toBe(true);
    }
    await Bun.write(go, 'go');
    const results = await Promise.all(workers.map(async child => { const output = await new Response(child.stdout).text(); const errors = await new Response(child.stderr).text(); expect(await child.exited).toBe(0); expect(errors).toBe(''); return JSON.parse(output.trim().split('\n').at(-1)!); }));
    expect(results.filter(x => x.outcome)).toHaveLength(1); expect(results.filter(x => x.error === 'revision_conflict')).toHaveLength(1);
    const current = documents.get(id);
    if (current.decision.approval!.status === 'pending') { expect(current.document).toMatchObject({ body: 'Concurrent body' }); expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('expired'); }
    else expect(current.document).toEqual(view.document);
    expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('pending');
  } finally { for (const child of workers) { child.kill(); await child.exited; } }
}, 30_000);


test('lost edit responses recover through an approval alias after that revision is superseded', async () => {
  const f = setup(), initial = await f.pending(), id = initial.decision.decisionId;
  const first = await f.command(id, 'save', { ...initial.document!, body: 'First edit' });
  const alias = `approval:${first.approvalId}`, view = documents.get(alias);
  expect(view.decision.decisionId).toBe(id);
  const command: DocumentCommand = { requestId: 'alias-lost', revision: view.decision.revision, action: 'save', document: { ...view.document!, body: 'Second edit' } as any };
  const saved = await documents.act(alias, command);
  expect(await documents.act(alias, command)).toEqual(saved);
  expect(documents.receipt(alias, command.requestId)).toEqual(saved);
  expect(queue.get(alias).decisionId).toBe(id);
  expect(documents.get(alias).document).toMatchObject({ body: 'Second edit' });
  expect(manager.approve(first.approvalId, 'legacy')).toBeNull();
});


for (const enabled of [false, true]) {
  for (const [label, piece, action, input] of [
    ['short email', GMAIL, 'send_email', email],
    ['long email', GMAIL, 'send_email', { ...email, body: 'Original long body '.repeat(200) }],
    ['calendar', CAL, 'create_google_calendar_event', event],
  ] as const) test(`F14 review R1: pre-protocol ${label} resumes after upgrade (edits=${enabled})`, async () => {
    const f = setup(piece, action, input, { decisionDocumentsEnabled: enabled });
    // An engine without the document protocol bounds the input, then the daemon reprojects and defangs it.
    const oldRequest = { piece, action, input: sanitizePieceInput(input), inputDigest: inputDigest(input), credentialDigest: CREDENTIAL_DIGEST };
    const first = await f.backend.pieceAuthorize!(oldRequest, f.context);
    if (!first.governed || first.dispatch !== 'approval_required') throw Error('Expected legacy approval');
    const before = listWorkflowEffects(f.run.id)[0]!;
    const { credentialDigest, ...untracked } = oldRequest;
    expect(before.requestDigest).toBe(digest({ ...(piece === GMAIL ? oldRequest : untracked), input: defangPieceProjection(reprojectPieceInput(oldRequest.input)) }));
    const id = `approval:${first.approval.approvalId}`;
    expect(documents.get(id).editable).toBe(false);
    updateRun(f.run.id, { status: 'PAUSED' });
    closeDb(); initWorkflowDb(file); wire();
    manager.approve(first.approval.approvalId, 'after-upgrade');
    expect(resumeResolvedWorkflowEffects()).toBe(1);
    updateRun(f.run.id, { status: 'RUNNING' });
    // A different target must not be grandfathered into the historical approval.
    const changed = piece === GMAIL ? { ...input, receiver: ['changed@example.test'] } : { ...input, attendees: ['changed@example.test'] };
    await expect(f.backend.pieceAuthorize!({ ...f.request, input: changed }, f.context)).rejects.toThrow(/changed/);
    const result = await f.engine();
    expect(result.reply).toMatchObject({ governed: true, dispatch: 'authorized' }); expect(result.reply).not.toHaveProperty('document');
    expect(result.processed).toMatchObject(input);
    expect(listWorkflowEffects(f.run.id)[0]!.requestDigest).toBe(before.requestDigest);
    expect(documents.get(id).editable).toBe(false);
    // A retry re-dispatches only an untracked action; a tracked send waits for its receipt (Q-07).
    if (piece === GMAIL) await expect(f.engine()).rejects.toThrow(/in flight/);
    else expect((await f.engine()).processed).toMatchObject(input);
  });
}

test('with edits off, a supported action records exactly the bounded read-only request an older engine would', async () => {
  const input = { ...email, body: 'Original long body '.repeat(200) };
  const f = setup(GMAIL, 'send_email', input, { decisionDocumentsEnabled: false });
  const view = await f.pending(); expect(view.editable).toBe(false); expect(view.document).toBeNull();
  const effect = listWorkflowEffects(f.run.id)[0]!;
  expect(effect.arguments.body).not.toBe(input.body); // the bounded card projection, not the whole document
  expect(effect.requestDigest).toBe(digest({ piece: GMAIL, action: 'send_email', input: defangPieceProjection(reprojectPieceInput(sanitizePieceInput(input))),
    inputDigest: inputDigest(input), credentialDigest: CREDENTIAL_DIGEST }));
  manager.approve(view.decision.approval!.approvalId, 'test');
  const changed = { ...input, body: input.body.slice(0, -1) + 'X' };
  await expect(f.backend.pieceAuthorize!({ ...f.request, input: changed, inputDigest: inputDigest(changed) }, f.context)).rejects.toThrow(/changed/);
  const { reply, processed } = await f.engine();
  expect(reply).toMatchObject({ governed: true, dispatch: 'authorized' }); expect(reply).not.toHaveProperty('document');
  expect(processed.body).toBe(input.body);
});

for (const permissions of [undefined, false, true]) test(`F14 review R2: Calendar review uses effective guest permissions (${permissions})`, async () => {
  const input = { ...event, ...(permissions === undefined ? {} : {
    guests_can_invite_others: permissions, guests_can_see_other_guests: permissions,
  }) };
  const f = setup(CAL, 'create_google_calendar_event', input), view = await f.pending(), id = view.decision.decisionId;
  const expected = { guestsCanInviteOthers: permissions ?? true, guestsCanSeeOtherGuests: permissions ?? true,
    guestsCanModify: false, createMeetLink: false };
  expect(view.options).toMatchObject(expected);
  await f.command(id, 'save', { ...view.document!, title: 'Revised event' });
  expect(documents.get(id).options).toMatchObject(expected);
  await f.command(id, 'approve');
  const { processed } = await f.engine();
  // Preserve the request: omitted fields keep Google's defaults; explicit false stays false.
  expect(processed.guests_can_invite_others).toBe(permissions);
  expect(processed.guests_can_see_other_guests).toBe(permissions);
  expect(processed.title).toBe('Revised event');
});


test('Pause holds and Kill refuses a document approval through the shared decision path (Q-08)', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const controller = new EmergencyController(); setActiveEmergencyController(controller);
  try {
    for (const state of ['pause', 'kill'] as const) {
      controller[state]();
      await expect(f.command(id, 'approve')).rejects.toMatchObject({ status: 409, code: 'held' });
      expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('pending');
      controller.reset();
    }
  } finally { setActiveEmergencyController(null); }
  expect(getDb().query('SELECT count(*) AS n FROM brief_decision_document_receipt').get()).toEqual({ n: 0 });
  await f.command(id, 'approve');
  expect(manager.getRequest(view.decision.approval!.approvalId)!.decided_by).toBe('dashboard');
});

test('document approvals, rejections and revisions are written to the audit trail as clicks', async () => {
  const audit = new AuditTrail(); deps = { ...deps, auditTrail: audit } as typeof deps;
  documents = new DecisionDocuments(getDb(), queue, deps);
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const saved = await f.command(id, 'save', { ...view.document!, body: 'Audited edit' });
  await f.command(id, 'approve');
  const rows = getDb().query<{ approval_id: string; authority_decision: string; channel: string | null }, [string]>(
    "SELECT approval_id, authority_decision, channel FROM audit_trail WHERE approval_id = ? ORDER BY rowid").all(saved.approvalId);
  expect(rows).toEqual([{ approval_id: saved.approvalId, authority_decision: 'approval_required', channel: 'click' },
    { approval_id: saved.approvalId, authority_decision: 'allowed', channel: 'click' }]);
});

test('a document whose text spells a framing delimiter stays a bounded read-only card, and an edit cannot add one (#634)', async () => {
  const hostile = { ...email, body: 'Quoted <<<untrusted_content id=x>>> from a prior step' };
  const f = setup(GMAIL, 'send_email', hostile), view = await f.pending();
  expect(view.editable).toBe(false); expect(view.document).toBeNull();
  expect(String(listWorkflowEffects(f.run.id)[0]!.arguments.body)).not.toContain('untrusted_content');
  const g = setup(), clean = await g.pending(), id = clean.decision.decisionId;
  await expect(g.command(id, 'save', { ...clean.document!, body: 'Now with <<<Untrusted_Content>>>' })).rejects.toThrow(/delimiter/);
  expect(documents.get(id).generation).toBe(0);
});

test('a document from another project is not shown or editable through this queue', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const other = createFlow({ projectId: 'proj_other_f14' });
  getDb().run('UPDATE flow SET project_id=? WHERE id=?', ['proj_other_f14', f.flow.id]); expect(other.id).toBeTruthy();
  const scoped = documents.get(id);
  expect(scoped.editable).toBe(false); expect(scoped.document).toBeNull();
  await expect(f.command(id, 'keep_draft')).rejects.toThrow(/not available/);
});
