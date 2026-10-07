import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { getWorkflowEffect, listWorkflowEffects, saveWorkflowEffect, claimWorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { AuthorityEngine } from '../authority/engine';
import { ApprovalManager } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { EmergencyController } from '../authority/emergency';
import { DeferredExecutor } from '../authority/deferred-executor';
import { CredentialResolver } from '../workflows/credentials/adapter';
import { WorkflowEventBuffer } from '../workflows/runtime/event-buffer';
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from '../workflows/runtime/service-backends';
import { authorizePieceDispatch } from '../workflows/runtime/piece-effect-guard';
import { documentInput, validateDecisionDocument } from '../workflows/runtime/decision-document';
import { resumeResolvedWorkflowEffects } from '../workflows/runtime/effect-approval-scheduler';
import { DecisionQueue } from './decisions';
import { loadDocumentFactBindings } from './decision-document-bindings';
import { createEntity } from '../vault/entities';
import { createFact, deleteFact, correctFact } from '../vault/facts';
import { existsSync } from 'node:fs';
import { createWorkItem } from '../goals/work-items';
import { DecisionDocuments, type DocumentCommand } from './decision-documents';

const GMAIL = '@activepieces/piece-gmail', CAL = '@activepieces/piece-google-calendar';
const email = { receiver: ['first@example.test'], cc: [], bcc: [], subject: 'Follow up', body: 'Original body', body_type: 'plain_text', draft: false };
const event = { calendar_id: 'primary', title: 'Review', description: 'Original agenda', start_date_time: '2026-11-01T09:00:00Z', end_date_time: '2026-11-01T09:30:00Z', attendees: ['first@example.test'], location: '', send_notifications: 'all' };
let dir: string, file: string, manager: ApprovalManager, queue: DecisionQueue, documents: DecisionDocuments;
function wire() {
  manager = new ApprovalManager(); queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
  documents = new DecisionDocuments(getDb(), queue, manager);
}
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
  const request = { piece, action, input, documentProtocol: 1 as const };
  const authorize = () => backend.pieceAuthorize!(request, context);
  const pending = async () => { const reply = await authorize(); if (!reply.governed || reply.dispatch !== 'approval_required') throw Error('Expected approval'); return documents.get(`approval:${reply.approval.approvalId}`); };
  const command = (id: string, action: DocumentCommand['action'], document?: any) => documents.act(id, { requestId: crypto.randomUUID(), revision: documents.get(id).decision.revision, action, ...(document ? { document } : {}) });
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
  const receipt = f.command(id, 'save', edit), after = documents.get(id);
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
  f.command(id, 'approve');
  expect(documents.get(id).state).toBe('permission_granted');
  const execution = await f.engine();
  expect(execution.reply).toMatchObject({ dispatch: 'authorized' });
  expect(execution.processed).toMatchObject({ receiver: edit.to, body: edit.body, subject: edit.subject, auth: { access_token: 'ENGINE_ONLY_SECRET' } });
  expect(listWorkflowEffects(f.run.id)[0]!.arguments.body).toBe(edit.body);
  expect(documents.get(id).editable).toBe(false);
  expect(documents.get(id).state).toBe('dispatch_authorized');
  expect((await f.engine()).processed.body).toBe(edit.body); // engine retry gets the same approved document
});

test('date and attendee edits are frozen, calendar and notification options stay read-only', async () => {
  const f = setup(CAL, 'google_calendar_create_event', event), view = await f.pending(), id = view.decision.decisionId;
  const edit = { ...view.document!, start: '2026-12-03T14:00:00+01:00', end: '2026-12-03T15:00:00+01:00', attendees: ['second@example.test'] };
  f.command(id, 'save', edit); expect(manager.approve(view.decision.approval!.approvalId, 'legacy')).toBeNull();
  expect(documents.get(id).options).toMatchObject({ calendarId: 'primary', notifications: 'all' });
  expect(() => f.command(id, 'save', { ...edit, calendarId: 'attacker' })).toThrow(/Unknown/);
  f.command(id, 'approve'); const result = await f.engine();
  expect(result.processed).toMatchObject({ calendar_id: 'primary', send_notifications: 'all', start_date_time: edit.start, end_date_time: edit.end, attendees: edit.attendees });
});

test('deferral retires permission, survives expiry and restart, stays queued and requires fresh review', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const saved = f.command(id, 'keep_draft'); updateRun(f.run.id, { status: 'PAUSED' });
  expect(saved).toMatchObject({ outcome: 'deferred', executed: false });
  expect(manager.approve(saved.approvalId, 'legacy')).toBeNull(); expect(resumeResolvedWorkflowEffects()).toBe(0);
  manager.expireOld(0); closeDb(); initWorkflowDb(file); wire();
  const kept = documents.get(id); expect(kept.state).toBe('deferred'); expect(kept.editable).toBe(true);
  expect((await queue.read()).data.items.map(x => x.decisionId)).toEqual([id]);
  expect(queue.get(id).supportedActions).toEqual(['inspect']);
  expect(() => f.command(id, 'approve')).toThrow(/not available/);
  expect(f.command(id, 'keep_draft').outcome).toBe('deferred');
  const reopened = f.command(id, 'reopen'); expect(reopened.approvalId).not.toBe(saved.approvalId);
  expect(documents.get(id).decision.approval!.status).toBe('pending'); expect(resumeResolvedWorkflowEffects()).toBe(0);
  f.command(id, 'approve'); expect(resumeResolvedWorkflowEffects()).toBe(1); expect(resumeResolvedWorkflowEffects()).toBe(0);
});

test('an expired review can be edited and approved after reload without silently resuming', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  getDb().run('UPDATE approval_requests SET created_at=0 WHERE id=?', [view.decision.approval!.approvalId]);
  manager.expireOld(1); updateRun(f.run.id, { status: 'PAUSED' });
  expect(resumeResolvedWorkflowEffects()).toBe(0); expect(documents.get(id).state).toBe('expired');
  expect(() => f.command(id, 'approve')).toThrow(/not available/);
  f.command(id, 'save', { ...view.document!, body: 'New review after expiry' });
  expect(documents.get(id).decision.approval!.status).toBe('pending');
  f.command(id, 'approve'); expect(resumeResolvedWorkflowEffects()).toBe(1);
});

test.each(['review','deferred','expired'] as const)('rejecting %s never grants permission and resumes only to a blocked receipt', async state => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  if (state === 'deferred') f.command(id, 'keep_draft');
  if (state === 'expired') getDb().run("UPDATE approval_requests SET status='expired' WHERE id=?", [view.decision.approval!.approvalId]);
  const receipt = f.command(id, 'reject'); expect(receipt).toMatchObject({ outcome: 'rejected', executed: false });
  updateRun(f.run.id, { status: 'PAUSED' }); expect(resumeResolvedWorkflowEffects()).toBe(1);
  updateRun(f.run.id, { status: 'RUNNING' }); await expect(f.engine()).rejects.toThrow(/denied/);
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('blocked'); expect(documents.get(id).state).toBe('rejected');
  expect(documents.get(id).actions).toEqual([]); expect(manager.getRequest(receipt.approvalId)!.execution_outcome).toBeNull();
});

test('lost responses replay exact durable receipts; conflicting reuse and stale edits fail', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const body: DocumentCommand = { requestId: 'lost-save', revision: view.decision.revision, action: 'save', document: { ...view.document!, body: 'Retain me' } as any };
  const receipt = documents.act(id, body); f.command(id, 'keep_draft');
  closeDb(); initWorkflowDb(file); wire();
  expect(documents.act(id, body)).toEqual(receipt); expect(documents.receipt(id, body.requestId)).toEqual(receipt);
  expect(documents.get(id).state).toBe('deferred');
  expect(() => documents.act(id, { ...body, action: 'reopen', document: undefined })).toThrow(/Request ID/);
  expect(() => documents.act(id, { ...body, requestId: 'stale' })).toThrow(/changed/);
  expect(getDb().query('SELECT * FROM brief_decision_document_revision').all()).toHaveLength(2);
});

test.each(['save','keep_draft'] as const)('legacy approval wins against a subsequent %s without changing its reviewed arguments', async action => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  manager.approve(view.decision.approval!.approvalId, 'legacy');
  expect(() => documents.act(id, { requestId: crypto.randomUUID(), revision: view.decision.revision, action, ...(action === 'save' ? { document: view.document! } : {}) })).toThrow(/changed/);
  expect((await f.engine()).processed.body).toBe(email.body);
});

test('an edit during notification delivery replaces the in-memory approval snapshot without overwriting it', async () => {
  let release!: () => void, delivered!: () => void;
  const notification = new Promise<void>(resolve => { delivered = resolve; });
  const f = setup(GMAIL, 'send_email', email, { onWorkflowApproval: async () => { delivered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const pending = f.authorize(); await notification;
  const original = listWorkflowEffects(f.run.id)[0]!, id = `approval:${original.approvalId}`;
  const next = f.command(id, 'save', { ...documents.get(id).document!, body: 'Edit during delivery' }); release();
  expect(await pending).toMatchObject({ approval: { approvalId: next.approvalId } });
  expect(getWorkflowEffect(original.id)!.arguments.body).toBe('Edit during delivery');
});

test('old engines, changed workflow input and changed policy cannot dispatch an edited document', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  f.command(id, 'save', { ...view.document!, body: 'Changed' }); f.command(id, 'approve');
  await expect(f.backend.pieceAuthorize!({ piece: GMAIL, action: 'send_email', input: email }, f.context)).rejects.toThrow(/changed/);
  await expect(f.backend.pieceAuthorize!({ ...f.request, input: { ...email, subject: 'Changed upstream' } }, f.context)).rejects.toThrow(/changed/);
  f.authority.addOverride({ action: 'send_email', allowed: false });
  await expect(f.engine()).rejects.toThrow(/denied/); expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('blocked');
  expect(documents.get(id).state).toBe('blocked');
});

test('unsupported and pre-protocol actions stay read-only; enabling enrollment is explicit', async () => {
  const f = setup(GMAIL, 'send_email', email, { decisionDocumentsEnabled: false });
  const view = await f.pending(); expect(view.editable).toBe(false); expect(view.document).toBeNull();
  expect(() => f.command(view.decision.decisionId, 'keep_draft')).toThrow(/not available/);
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
  const text = JSON.stringify(view) + JSON.stringify(f.command(view.decision.decisionId, 'keep_draft'));
  for (const secret of ['ENGINE_ONLY_SECRET', effect.waitpointId!, 'tool_arguments', 'sandboxId', 'executionPath']) expect(text).not.toContain(secret);
});


test('F-13 links a revised document to the existing work and queue position', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const work = createWorkItem({ title: 'Fixture work' });
  getDb().run('UPDATE commitment_work SET run_id=? WHERE work_id=?', [f.run.id, work.id]);
  queue.place(id, documents.get(id).decision.revision, -5);
  f.command(id, 'save', { ...view.document!, body: 'Work-linked edit' });
  expect(queue.recommendWork(work.id, false)).toMatchObject({ decisionId: id, placement: -5, workItemId: work.id });
});

test('editing terminal or resumed runs is refused, even when an approval is still pending', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  updateRun(f.run.id, { status: 'FAILED' }); expect(documents.get(id).editable).toBe(false);
  updateRun(f.run.id, { status: 'RUNNING' });
  getDb().run('UPDATE waitpoint SET resumed_at=1 WHERE id=?', [listWorkflowEffects(f.run.id)[0]!.waitpointId]);
  expect(() => f.command(id, 'save', view.document)).toThrow(/not available/);
  expect(manager.getRequest(view.decision.approval!.approvalId)!.status).toBe('pending');
});

test('notification failures cannot erase committed document receipts', async () => {
  const f = setup(), view = await f.pending(), id = view.decision.decisionId;
  const noisy = new DecisionDocuments(getDb(), queue, manager, () => { throw Error('Socket closed'); });
  const command: DocumentCommand = { requestId: 'socket-failure', revision: view.decision.revision, action: 'keep_draft' };
  const receipt = noisy.act(id, command); expect(receipt.outcome).toBe('deferred');
  expect(noisy.act(id, command)).toEqual(receipt); expect(documents.get(id).state).toBe('deferred');
});

test('a bound effect cannot silently downgrade without its owner binding adapter', async () => {
  const f = setup(), view = await f.pending(), effect = listWorkflowEffects(f.run.id)[0]!;
  saveWorkflowEffect({ ...effect, bindings: { facts: [] } } as typeof effect);
  expect(documents.get(view.decision.decisionId).editable).toBe(false);
  const unavailable = new DecisionDocuments(getDb(), queue, manager, undefined, { available: false, capture: () => [] });
  expect(unavailable.readiness()).toBe('unavailable');
});

const hasQ05 = existsSync(new URL('../workflows/runtime/fact-bindings.ts', import.meta.url));
test.skipIf(!hasQ05)('actual Q-05 binds edited recipients and retains deleted original facts for unchanged recipients', async () => {
  const bindings = await loadDocumentFactBindings(); expect(bindings?.available).toBe(true);
  documents = new DecisionDocuments(getDb(), queue, manager, undefined, bindings);
  const first = createFact(createEntity('person', 'First').id, 'email', 'first@example.test', { confirmed: true });
  const second = createFact(createEntity('person', 'Second').id, 'email', 'second@example.test', { confirmed: true });
  const f = setup(), view = await f.pending(), effect = listWorkflowEffects(f.run.id)[0]!, id = view.decision.decisionId;
  saveWorkflowEffect({ ...effect, bindings: { facts: bindings!.capture(effect.arguments) } } as typeof effect);
  f.command(id, 'save', { ...view.document!, to: ['second@example.test'] });
  const edited = getWorkflowEffect(effect.id)! as typeof effect & { bindings: { facts: unknown[] } };
  expect(edited.bindings.facts).toEqual([{ value: 'second@example.test', factIds: [second.id] }]);
  deleteFact(first.id); // no longer a dependency after a deliberate address edit
  f.command(id, 'save', { ...documents.get(id).document!, body: 'Safe body edit' });
  deleteFact(second.id); const before = documents.get(id);
  expect(() => f.command(id, 'save', { ...before.document!, body: 'Must retain deleted dependency' })).toThrow(/Recipient facts/);
  expect(documents.get(id)).toEqual(before);
  const stale = createFact(createEntity('person', 'Stale').id, 'email', 'stale@example.test', { confirmed: true });
  correctFact(stale.id, 'current@example.test', 'Moved');
  expect(() => f.command(id, 'save', { ...before.document!, to: ['stale@example.test'] })).toThrow(/Recipient facts/);
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
    const manager=new ApprovalManager(), queue=new DecisionQueue(getDb(),{approvalManager:manager,deferredExecutor:new DeferredExecutor(manager,new AuditTrail())});
    const docs=new DecisionDocuments(getDb(),queue,manager);
    await Bun.write(ready,'ready');
    while(!existsSync(go)) await Bun.sleep(5);
    try { const receipt=docs.act(id,JSON.parse(body)); console.log(JSON.stringify({outcome:receipt.outcome})); }
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
