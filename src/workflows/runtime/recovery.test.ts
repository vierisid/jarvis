import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { getWorkflowEffect, listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
import { setEncryptionKey } from '../db/encryption';
import { upsertConnection } from '../db/repos/app-connection';
import { enqueue, claimNextJob, recoverOrphanedJobs, getJob } from '../db/repos/job-queue';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController, setActiveEmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { authorizePieceDispatch, executeAuthorizedPiece } from './piece-effect-guard';
import { createJarvisPieceAuthorizeRoute, createJarvisPieceReceiptRoute } from '../sandbox-api/routes/jarvis-pieces';
import { decideRunRecovery, getRunRecovery, listRunRecoveries } from './recovery';
import { createWorkflowRoutes } from '../api/routes';
import { recordPieceCompletion } from './piece-completion';
import { WorkflowEffectBoundary, workflowEffectId } from './effect-boundary';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE, wrapUntrusted } from '../../roles/untrusted';

let dir: string;
beforeEach(() => { setEncryptionKey(Buffer.alloc(32, 7)); dir = mkdtempSync(join(tmpdir(), 'jarvis-q07-')); initWorkflowDb(join(dir, 'fixture.db')); });
afterEach(() => { setActiveEmergencyController(null); setEncryptionKey(null); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); });
const GMAIL = '@activepieces/piece-gmail';
const SLACK = '@activepieces/piece-slack';
function fixture(piece = GMAIL, action = 'send_email') {
  const pieceVersion = piece === GMAIL ? '0.17.0' : '0.21.0';
  const connection = upsertConnection({ externalId: 'q07-account', displayName: 'Fixture account', type: 'OAUTH2',
    pieceName: piece, pieceVersion, value: { access_token: 'fixture-token-never-real' } });
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Q07 fixture', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: piece, pieceVersion, actionName: action,
      input: { auth: '{{connections.q07-account}}' } } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const job = enqueue({ jobType: 'RUN_FLOW', flowRunId: run.id, payload: { runId: run.id, executionType: 'BEGIN' }, maxAttempts: 10 });
  claimNextJob();
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const emergency = new EmergencyController(); setActiveEmergencyController(emergency);
  const approvals = new ApprovalManager();
  const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), authorityEngine: authority,
    emergencyController: emergency, approvalManager: approvals, auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const ctx = { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'send', executionPath: [] as Array<[string, number]> };
  const claims = { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'fixture' } as any;
  let dropReceipt = false; let loseReceiptReply = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const receipt = String(url).endsWith('/receipt');
    if (receipt && dropReceipt) throw new Error('lost before receipt');
    const handler = receipt ? createJarvisPieceReceiptRoute(backends) : createJarvisPieceAuthorizeRoute(backends);
    const response = await handler({ req: new Request(url, init), claims, params: {} });
    if (receipt && loseReceiptReply) throw new Error('lost after receipt');
    return response;
  }) as typeof fetch;
  const params = { apiUrl: 'http://fixture.test', engineToken: 'fixture', piece, action, stepName: 'send', executionPath: ctx.executionPath,
    input: { receiver: ['someone@example.test'], subject: 'Fixture', body: 'No real send', channel: 'C123', auth: connection.value }, fetchImpl };
  let sends = 0;
  const result = piece === GMAIL ? { id: 'a123', threadId: 'b234' } : { ok: true, channel: 'C123', ts: '123456.123456' };
  const invoke = async () => executeAuthorizedPiece(params, await authorizePieceDispatch(params), async () => { sends++; return result; });
  const fail = () => updateRun(run.id, { status: 'FAILED', steps: { earlier: { status: 'SUCCEEDED', output: 'retained' } } });
  const choice = (action: 'inspect' | 'reconcile', key = 'request_0001') => ({ action, requestId: key, revision: getRunRecovery(run.id)!.revision,
    ...(action === 'inspect' ? { note: 'Inspected the original account; outcome remains uncertain. I will review inputs before requesting a new run.' } : { effectId: listWorkflowEffects(run.id)[0]!.id }) });
  return { connection, flow, version, run, job, ctx, authority, emergency, approvals, backends, params, invoke, fail, choice, result,
    sends: () => sends, dropReceipt: () => { dropReceipt = true; }, loseReply: () => { loseReceiptReply = true; } };
}

for (const [piece, action] of [[GMAIL, 'send_email'], [GMAIL, 'gmail_send_email'], [SLACK, 'send_channel_message'], [SLACK, 'slack_post_message']]) {
  test(`${action}: lost response and repeated dispatch never send twice, also after restart`, async () => {
    const f = fixture(piece, action); f.dropReceipt();
    await expect(f.invoke()).rejects.toThrow('lost before receipt');
    await expect(f.invoke()).rejects.toThrow('replay is blocked');
    expect(f.sends()).toBe(1);
    closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); recoverOrphanedJobs();
    expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown', needsAttention: true, canReplay: false });
    expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('unknown');
    expect(getJob(f.job.id)).toMatchObject({ status: 'FAILED', maxAttempts: 1 });
    expect(claimNextJob()).toBeNull();
    await expect(f.invoke()).rejects.toThrow(); expect(f.sends()).toBe(1);
  });
}

test('a tracked send leaves an audit row at authorization, before any completion receipt', async () => {
  const f = fixture(); f.dropReceipt();
  await expect(f.invoke()).rejects.toThrow('lost before receipt');
  // The engine may have sent: the trail must say the dispatch was handed out
  // even though no completion receipt ever arrives.
  const rows = new AuditTrail().query({ agentId: `workflow:${f.run.id}` });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tool_name: 'piece:gmail/send_email', authority_decision: 'allowed', executed: 1 });
});

test('receipt persists before an engine reply is lost; replay returns the stored result without a second send', async () => {
  const f = fixture(); f.loseReply();
  await expect(f.invoke()).rejects.toThrow('lost after receipt');
  expect(await f.invoke()).toEqual(f.result); expect(f.sends()).toBe(1);
  f.fail(); closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); recoverOrphanedJobs();
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'recoverable', effects: [{ status: 'completed' }] });
  expect(getFlowRun(f.run.id)!.steps!.earlier).toMatchObject({ output: 'retained' });
});

test('provider failure during work remains dispatching/unknown and no retry can re-enter it', async () => {
  const f = fixture(); let sends = 0;
  const authorized = await authorizePieceDispatch(f.params);
  await expect(executeAuthorizedPiece(f.params, authorized, async () => { sends++; throw new Error('provider timed out after accepting'); })).rejects.toThrow('timed out');
  await expect(f.invoke()).rejects.toThrow('replay is blocked');
  f.fail(); expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('unknown'); expect(sends).toBe(1);
});

test('before dispatch: approval, changed inputs/version and current policy all fail closed', async () => {
  const f = fixture(); f.authority.setGovernedCategories(['send_email']);
  const pending = await authorizePieceDispatch(f.params);
  expect(pending).toMatchObject({ dispatch: 'approval_required' });
  const id = (pending as any).approval.approvalId;
  f.approvals.approve(id, 'user');
  await expect(authorizePieceDispatch({ ...f.params, input: { ...f.params.input, receiver: ['changed@example.test'] } })).rejects.toThrow('changed');
  f.authority.addOverride({ action: 'send_email', allowed: false });
  await expect(f.invoke()).rejects.toThrow('denied'); expect(f.sends()).toBe(0);
  f.fail(); expect(getRunRecovery(f.run.id)!.state).toBe('blocked');
});

test('version edits cannot reuse a pending send approval', async () => {
  const f = fixture(); f.authority.setGovernedCategories(['send_email']);
  const pending = await authorizePieceDispatch(f.params); f.approvals.approve((pending as any).approval.approvalId, 'user');
  const trigger = structuredClone(f.version.trigger); trigger.nextAction!.settings!.input = { ...trigger.nextAction!.settings!.input, subject: 'changed' };
  updateDraftVersion(f.version.id, { trigger });
  await expect(f.invoke()).rejects.toThrow('changed'); expect(f.sends()).toBe(0);
});

for (const state of ['pause', 'kill'] as const) test(`${state} holds new sends and provider lookups; inspection remains available`, async () => {
  const f = fixture(); await f.invoke(); f.fail(); f.emergency[state](); let lookups = 0;
  const receipt = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority, fetchImpl: (async () => { lookups++; return Response.json({}); }) as any });
  expect(receipt.evidence.outcome).toBe('blocked'); expect(lookups).toBe(0);
  await decideRunRecovery(f.run.id, f.choice('inspect', 'inspect_0001'));
  expect(getRunRecovery(f.run.id)!.needsAttention).toBe(false);
});

test('a receipt after Kill retains the completed effect but never revives the run', async () => {
  const f = fixture(); const permit = await authorizePieceDispatch(f.params) as any;
  f.emergency.kill(); updateRun(f.run.id, { status: 'STOPPED' });
  f.backends.pieceReceipt!(f.ctx, permit.effectId, f.result);
  expect(getFlowRun(f.run.id)!.status).toBe('STOPPED'); expect(getWorkflowEffect(permit.effectId)!.status).toBe('succeeded');
  await expect(f.invoke()).rejects.toThrow(); expect(f.sends()).toBe(0);
});

for (const piece of [GMAIL, SLACK]) test(`${piece}: real read-only receipt adapter confirms only the exact persisted provider id`, async () => {
  const f = fixture(piece, piece === GMAIL ? 'send_email' : 'slack_post_message'); await f.invoke(); f.fail();
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
    return Response.json(piece === GMAIL ? { id: 'a123', labelIds: ['SENT'] } : { ok: true, messages: [{ type: 'message', ts: '123456.123456' }] });
  }) as typeof fetch;
  const c = f.choice('reconcile'); const receipt = await decideRunRecovery(f.run.id, c, { authority: f.authority, fetchImpl });
  expect(receipt.evidence.outcome).toBe('confirmed'); expect(urls[0]).toContain(piece === GMAIL ? 'messages/a123?format=minimal' : 'conversations.history?');
  expect(await decideRunRecovery(f.run.id, c, { authority: f.authority, fetchImpl })).toEqual(receipt); expect(urls.length).toBe(1);
  expect(f.sends()).toBe(1); expect(getFlowRun(f.run.id)!.status).toBe('FAILED');
});

for (const response of [() => new Response('', { status: 404 }), () => Response.json({ id: 'wrong', labelIds: ['SENT'] }),
  () => Response.json({ id: 'a123', labelIds: ['DRAFT'] }), () => Response.json({ id: 'a123' }), () => new Response('not json')]) {
  test('missing, mismatched or malformed lookup evidence cannot establish no send', async () => {
    const f = fixture(); await f.invoke(); f.fail();
    const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority, fetchImpl: (async () => response()) as any });
    expect(r.evidence.outcome).toBe('inconclusive'); expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('completed'); expect(f.sends()).toBe(1);
  });
}

test('unsupported and missing receipts require inspection; acknowledgement is durable and does not assert success', async () => {
  const f = fixture(); f.dropReceipt(); await expect(f.invoke()).rejects.toThrow(); f.fail();
  const result = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority }); expect(result.evidence.outcome).toBe('unsupported');
  const c = f.choice('inspect', 'inspect_0001'); const r = await decideRunRecovery(f.run.id, c);
  closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); recoverOrphanedJobs();
  expect(await decideRunRecovery(f.run.id, c)).toEqual(r);
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown', needsAttention: false, canReplay: false, newRunRequired: true });
  expect(listRunRecoveries().recoveries).toHaveLength(0); expect(f.sends()).toBe(1);
  await expect(decideRunRecovery(f.run.id, { ...c, note: 'changed choice' })).rejects.toThrow('different recovery choice');
});

test('a late completion invalidates prior inspection; conflicting and foreign receipts are refused', async () => {
  const f = fixture(); const permit = await authorizePieceDispatch(f.params) as any; f.fail();
  await decideRunRecovery(f.run.id, f.choice('inspect'));
  expect(() => recordPieceCompletion({ ...f.ctx, runId: 'other' }, permit.effectId, f.result)).toThrow('identity');
  recordPieceCompletion(f.ctx, permit.effectId, f.result);
  expect(getRunRecovery(f.run.id)!.needsAttention).toBe(true);
  recordPieceCompletion(f.ctx, permit.effectId, f.result);
  expect(() => recordPieceCompletion(f.ctx, permit.effectId, { id: 'different' })).toThrow('Conflicting');
});

test('two different recovery choices on one revision yield one audit receipt; stale evidence is refused', async () => {
  const f = fixture(); f.dropReceipt(); await expect(f.invoke()).rejects.toThrow(); f.fail();
  const c = f.choice('inspect');
  const results = await Promise.allSettled([decideRunRecovery(f.run.id, c), decideRunRecovery(f.run.id, { ...c, requestId: 'request_0002' })]);
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']); expect(getRunRecovery(f.run.id)!.receipts).toHaveLength(1);
});

test('an interrupted recovery write leaves the outstanding decision and no audit receipt', async () => {
  const f = fixture(); f.fail();
  getWorkflowDb().run("CREATE TEMP TRIGGER reject_recovery BEFORE INSERT ON workflow_recovery_receipt BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  await expect(decideRunRecovery(f.run.id, f.choice('inspect'))).rejects.toThrow('write failed');
  expect(getRunRecovery(f.run.id)).toMatchObject({ needsAttention: true, receipts: [] });
});

test('connection rotation and revoked read authority block lookup without exposing credentials', async () => {
  const f = fixture(); await f.invoke(); f.fail();
  upsertConnection({ externalId: f.connection.externalId, displayName: 'Changed account', type: 'OAUTH2', pieceName: GMAIL, pieceVersion: '0.0.1', value: { access_token: 'different-token' } });
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority, fetchImpl: (async () => { throw new Error('must not fetch'); }) as any });
  expect(r.evidence.outcome).toBe('blocked'); expect(JSON.stringify(r)).not.toContain('token');
  f.authority.addOverride({ action: 'read_data', allowed: false });
  expect((await decideRunRecovery(f.run.id, f.choice('reconcile', 'request_0002'), { authority: f.authority })).evidence.outcome).toBe('blocked');
});

test('public run/effects/recovery/inbox projections agree and reject unbounded or execution choices', async () => {
  const f = fixture(); f.fail(); const routes = createWorkflowRoutes({ recoveryAuthority: f.authority });
  const request = (suffix: string, init?: RequestInit) => Object.assign(new Request(`http://fixture.test/api/workflow-runs/${f.run.id}${suffix}`, init), { params: { runId: f.run.id } });
  for (const path of ['/api/workflow-runs/:runId', '/api/workflow-runs/:runId/effects', '/api/workflow-runs/:runId/recovery']) {
    const response = await routes[path]!.GET!(request('') as any); expect((await response.json() as any).recovery).toEqual(getRunRecovery(f.run.id));
  }
  const post = routes['/api/workflow-runs/:runId/recovery']!.POST!;
  expect((await post(request('/recovery', { method: 'POST', body: JSON.stringify({ ...f.choice('inspect'), action: 'execute' }) }) as any)).status).toBe(400);
  expect((await post(request('/recovery', { method: 'POST', body: 'x'.repeat(8193) }) as any)).status).toBe(413);
  const response = await post(request('/recovery', { method: 'POST', body: JSON.stringify(f.choice('inspect')) }) as any);
  expect(response.status).toBe(200); expect(getRunRecovery(f.run.id)!.needsAttention).toBe(false);
});

test('an audit failure after a direct effect receipt cannot overwrite its success', async () => {
  const f = fixture(); let sends = 0;
  const boundary = new WorkflowEffectBoundary({ authorityEngine: f.authority, emergencyController: f.emergency,
    auditTrail: { log: () => { throw new Error('audit write failed'); } } as any });
  const input = { context: f.ctx, piece: GMAIL, action: 'send_email', route: 'tool', toolName: 'fixture-send', category: 'send_email' as const,
    toolCategory: 'fixture', request: {}, prepare: () => ({ arguments: {}, target: {} }), execute: async () => { sends++; return { sent: 'receipt' }; } };
  await expect(boundary.invoke(input)).rejects.toThrow('audit write failed');
  expect((await boundary.invoke(input)).result).toEqual({ sent: 'receipt' }); expect(sends).toBe(1);
});

for (const boundary of ['before', 'during', 'after']) test(`SIGKILL ${boundary} provider work preserves partial results and no-replay across boot`, async () => {
  const dbPath = join(dir, 'crash.db'); const providerLog = join(dir, 'provider.log');
  const child = Bun.spawn([process.execPath, new URL('./recovery-crash.fixture.ts', import.meta.url).pathname, dbPath, providerLog, boundary],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe(''); expect(exit).not.toBe(0);
  closeWorkflowDb(); initWorkflowDb(dbPath); recoverOrphanedJobs();
  const row = getWorkflowDb().query('SELECT id FROM flow_run').get() as { id: string };
  const recovery = getRunRecovery(row.id)!;
  expect(recovery.state).toBe(boundary === 'before' ? 'blocked' : boundary === 'during' ? 'unknown' : 'recoverable');
  expect(getFlowRun(row.id)!.steps!.previous).toEqual({ status: 'SUCCEEDED', output: 'partial result' });
  expect(await Bun.file(providerLog).exists() ? await Bun.file(providerLog).text() : '').toBe(boundary === 'before' ? '' : 'accepted\n');
  expect(claimNextJob()).toBeNull(); expect(recovery.canReplay).toBe(false); expect(recovery.needsAttention).toBe(true);
});

test('Gmail Gaxios receipts preserve data without transport credentials', async () => {
  const f = fixture(); const permit = await authorizePieceDispatch(f.params);
  const result = await executeAuthorizedPiece(f.params, permit, async () => ({ data: f.result, status: 200, config: { headers: { Authorization: 'Bearer PRIVATE' } } }));
  expect(result).toEqual({ data: f.result, status: 200 });
  f.fail(); expect(JSON.stringify(listWorkflowEffects(f.run.id))).not.toContain('PRIVATE');
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority, fetchImpl: (async () => Response.json({ id: 'a123', labelIds: ['SENT'] })) as any });
  expect(r.evidence.outcome).toBe('confirmed');
});

test('a legacy dispatch authorization cannot acquire a new send identity after upgrade', async () => {
  const f = fixture(); await f.invoke();
  const effect = listWorkflowEffects(f.run.id)[0]!;
  const { workflowEffectId } = await import('./effect-boundary');
  getWorkflowDb().run('DELETE FROM workflow_effect WHERE id=?', [effect.id]);
  saveWorkflowEffect({ ...effect, id: workflowEffectId(f.run.id, 'send', [], 'piece'), route: 'piece', result: { dispatch: 'authorized' } });
  await expect(f.invoke()).rejects.toThrow('Legacy piece authorization'); expect(f.sends()).toBe(1);
  f.fail(); expect(getRunRecovery(f.run.id)!.state).toBe('unknown');
});

test('lost-response negative control duplicates without the fence; guarded sends do not', async () => {
  let unguarded = 0;
  const rawSend = async () => { unguarded++; throw new Error('accepted, reply lost'); };
  for (let i = 0; i < 2; i++) await expect(rawSend()).rejects.toThrow('reply lost');
  expect(unguarded).toBe(2);
  const f = fixture(); f.dropReceipt();
  for (let i = 0; i < 2; i++) await expect(f.invoke()).rejects.toThrow();
  expect(f.sends()).toBe(1);
});

test('Pause parks a selected send before dispatch; Kill blocks it after reset is required', async () => {
  const f = fixture(); f.emergency.pause();
  expect(await authorizePieceDispatch(f.params)).toMatchObject({ dispatch: 'approval_required' }); expect(f.sends()).toBe(0);
  f.emergency.resume(); await f.invoke(); expect(f.sends()).toBe(1);
  const other = fixture(); other.emergency.kill(); await expect(other.invoke()).rejects.toThrow('killed'); expect(other.sends()).toBe(0);
});

test('receipt route bounds streaming input and leaves its dispatch uncertain on rejection', async () => {
  const f = fixture(); await authorizePieceDispatch(f.params);
  const route = createJarvisPieceReceiptRoute(f.backends);
  const req = new Request('http://fixture/receipt', { method: 'POST', body: JSON.stringify({ result: 'x'.repeat(262144) }) });
  expect((await route({ req, claims: {} as any, params: {} })).status).toBe(413);
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('dispatching');
});

test('an in-flight lookup cannot commit after a late receipt changes its evidence', async () => {
  const f = fixture(); await f.invoke(); f.fail();
  let release!: () => void; const waiting = new Promise<void>(r => { release = r; });
  const lookup = decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority, fetchImpl: (async () => {
    await waiting; return Response.json({ id: 'a123', labelIds: ['SENT'] });
  }) as any });
  updateRun(f.run.id, { steps: { late: { output: 'new evidence' } } }); release();
  await expect(lookup).rejects.toThrow('evidence changed'); expect(getRunRecovery(f.run.id)!.receipts).toHaveLength(0);
});

test('a persisted step receipt reconciles an uncertain dispatch without opening its fence', async () => {
  const f = fixture(); const permit = await authorizePieceDispatch(f.params) as any;
  updateRun(f.run.id, { status: 'FAILED', steps: { send: { status: 'SUCCEEDED', output: { data: f.result } } } });
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown', effects: [{ lookupSupported: true, status: 'unknown' }] });
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => Response.json({ id: 'a123', labelIds: ['SENT'] })) as any });
  expect(r.evidence.outcome).toBe('confirmed');
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'recoverable', canReplay: false, effects: [{ status: 'completed' }] });
  expect(getWorkflowEffect(permit.effectId)!.status).toBe('dispatching'); expect(getFlowRun(f.run.id)!.status).toBe('FAILED');
  expect(claimNextJob()).toBeNull(); expect(f.sends()).toBe(0);
});

test('a Gmail label change is tracked but has no send readback: its labeled message is never confirmed as a send', async () => {
  const f = fixture(GMAIL, 'gmail_add_label_to_email');
  await f.invoke(); expect(f.sends()).toBe(1);
  await expect(f.invoke()).resolves.toEqual(f.result); expect(f.sends()).toBe(1);
  f.fail(); let lookups = 0;
  // Its saved result still proves the change completed.
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'recoverable', effects: [{ status: 'completed', lookupSupported: false }] });
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => { lookups++; return Response.json({ id: 'a123', labelIds: ['SENT', 'INBOX'] }); }) as any });
  expect(r.evidence.outcome).toBe('unsupported'); expect(lookups).toBe(0);
});

test('unverified connector versions retain completions but have no lookup adapter', async () => {
  const f = fixture();
  const trigger = structuredClone(f.version.trigger); trigger.nextAction!.settings!.pieceVersion = '9.9.9';
  updateDraftVersion(f.version.id, { trigger });
  await f.invoke(); f.fail();
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => { throw new Error('must not fetch'); }) as any });
  expect(r.evidence.outcome).toBe('unsupported'); expect(getRunRecovery(f.run.id)!.effects[0]!.lookupSupported).toBe(false);
});

for (const unsupported of [{ sendAsUser: true }, { threadTs: '123456.000001' }, { file: 'fixture' }, { sendAsBot: false }]) {
  test(`Slack lookup refuses unsupported mode ${JSON.stringify(unsupported)}`, async () => {
    const f = fixture(SLACK, 'sendAsBot' in unsupported ? 'send_channel_message' : 'slack_post_message'); Object.assign(f.params.input, unsupported);
    await f.invoke(); f.fail(); let lookups = 0;
    const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
      fetchImpl: (async () => { lookups++; return Response.json({}); }) as any });
    expect(r.evidence.outcome).toBe('unsupported'); expect(lookups).toBe(0);
    expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'recoverable', effects: [{ status: 'completed', lookupSupported: false }] });
  });
}

test('malformed Slack results do not become completion evidence', async () => {
  const f = fixture(SLACK, 'send_channel_message'); const permit = await authorizePieceDispatch(f.params) as any;
  recordPieceCompletion(f.ctx, permit.effectId, { ok: false, error: 'not_sent' }); f.fail();
  expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('unknown');
});

test('confirmed send survives later inconclusive/blocked lookups, unrelated progress and restart', async () => {
  const f = fixture(); await authorizePieceDispatch(f.params);
  updateRun(f.run.id, { status: 'FAILED', steps: { send: { status: 'SUCCEEDED', output: f.result } } });
  await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => Response.json({ id: 'a123', labelIds: ['SENT'] })) as any });
  await decideRunRecovery(f.run.id, f.choice('reconcile', 'lookup_0002'), { authority: f.authority,
    fetchImpl: (async () => new Response('', { status: 404 })) as any });
  f.emergency.pause();
  await decideRunRecovery(f.run.id, f.choice('reconcile', 'lookup_0003'), { authority: f.authority });
  await decideRunRecovery(f.run.id, f.choice('inspect', 'inspect_0004'));
  updateRun(f.run.id, { steps: { send: { status: 'SUCCEEDED', output: f.result }, late: { output: 'unrelated evidence' } } });
  closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db'));
  const recovery = getRunRecovery(f.run.id)!;
  expect(recovery).toMatchObject({ state: 'recoverable', needsAttention: true,
    effects: [{ status: 'completed', providerEvidence: { outcome: 'confirmed' } }] });
  expect(recovery.receipts.map(r => r.evidence.outcome)).toEqual(['confirmed', 'inconclusive', 'blocked', 'inspected']);
  expect(listWorkflowEffects(f.run.id)[0]!.status).toBe('dispatching');
  // A different provider ID must not borrow that historical confirmation.
  updateRun(f.run.id, { steps: { send: { status: 'SUCCEEDED', output: { id: 'b234' } } } });
  expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('unknown');
});

test('legacy confirmation receipts remain valid for their original evidence snapshot', async () => {
  const f = fixture(); await authorizePieceDispatch(f.params);
  updateRun(f.run.id, { status: 'FAILED', steps: { send: { status: 'SUCCEEDED', output: f.result } } });
  const receipt = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => Response.json({ id: 'a123', labelIds: ['SENT'] })) as any });
  delete receipt.effectEvidenceVersion;
  getWorkflowDb().run('UPDATE workflow_recovery_receipt SET record=? WHERE id=?', [JSON.stringify(receipt), receipt.id]);
  await decideRunRecovery(f.run.id, f.choice('reconcile', 'lookup_0002'), { authority: f.authority,
    fetchImpl: (async () => new Response('', { status: 404 })) as any });
  expect(getRunRecovery(f.run.id)!.effects[0]!.status).toBe('completed');
});

test('an earlier loop completion cannot hide a later untracked failed instance', async () => {
  const f = fixture(); await f.invoke();
  const effect = listWorkflowEffects(f.run.id)[0]!;
  const path: Array<[string, number]> = [['loop', 0]];
  getWorkflowDb().run('DELETE FROM workflow_effect WHERE id=?', [effect.id]);
  saveWorkflowEffect({ ...effect, id: workflowEffectId(f.run.id, 'send', path, effect.route), executionPath: path });
  updateDraftVersion(f.version.id, { trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '[1,2]' }, firstLoopAction: f.version.trigger.nextAction } } });
  updateRun(f.run.id, { status: 'FAILED', failedStep: { name: 'send', displayName: 'Send' }, steps: {
    loop: { output: { iterations: [{ send: { status: 'SUCCEEDED', output: f.result } }, { send: { status: 'FAILED' } }] } } } });
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown',
    effects: [{ status: 'completed' }], untrackedSteps: [{ stepName: 'send', executionPath: [['loop', 1]], status: 'unknown' }] });
  // If the last iteration's log is lost, failedStep still demands inspection.
  updateRun(f.run.id, { steps: { loop: { output: { iterations: [{ send: { status: 'SUCCEEDED', output: f.result } }] } } } });
  expect(getRunRecovery(f.run.id)!.untrackedSteps).toEqual([{ stepName: 'send', executionPath: null, status: 'unknown' }]);
});

test('untracked interrupted CODE progress is unknown even without a failedStep', async () => {
  const f = fixture(); await f.invoke();
  const trigger = structuredClone(f.version.trigger);
  trigger.nextAction!.nextAction = { name: 'code', type: 'CODE', settings: {} };
  updateDraftVersion(f.version.id, { trigger });
  for (const status of ['RUNNING', undefined]) {
    updateRun(f.run.id, { status: 'INTERNAL_ERROR', steps: { code: { status, output: 'partial' } } });
    expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown',
      untrackedSteps: [{ stepName: 'code', executionPath: [], status: 'unknown' }] });
  }
  updateRun(f.run.id, { steps: { code: { status: 'SUCCEEDED', output: 'complete' } } });
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'recoverable', untrackedSteps: [] });
});

test('an inconclusive readback of a step receipt leaves the missing completion unknown', async () => {
  const f = fixture(); await authorizePieceDispatch(f.params);
  updateRun(f.run.id, { status: 'FAILED', steps: { send: { status: 'SUCCEEDED', output: f.result } } });
  const r = await decideRunRecovery(f.run.id, f.choice('reconcile'), { authority: f.authority,
    fetchImpl: (async () => new Response('', { status: 404 })) as any });
  expect(r.evidence.outcome).toBe('inconclusive');
  expect(getRunRecovery(f.run.id)).toMatchObject({ state: 'unknown', effects: [{ status: 'unknown' }] });
});

test('completion approval receipts and inspection notes cannot persist active framing delimiters', async () => {
  const f = fixture(); f.authority.setGovernedCategories(['send_email']);
  const pending = await authorizePieceDispatch(f.params) as any;
  f.approvals.approve(pending.approval.approvalId, 'user');
  const permit = await authorizePieceDispatch(f.params) as any;
  const result = { ...f.result, detail: wrapUntrusted('x'.repeat(4000), 'provider fixture') };
  recordPieceCompletion(f.ctx, permit.effectId, result, { approvalManager: f.approvals });
  const approvalReceipt = f.approvals.getRequest(pending.approval.approvalId)!.execution_result!;
  expect(approvalReceipt.length).toBeLessThanOrEqual(2000);
  expect(getWorkflowEffect(permit.effectId)!.result).toEqual(result);
  f.fail();
  const receipt = await decideRunRecovery(f.run.id, { ...f.choice('inspect'), note: wrapUntrusted('Inspection remains uncertain', 'inspection fixture') });
  for (const text of [approvalReceipt, receipt.evidence.reason]) {
    expect(text).not.toContain(UNTRUSTED_OPEN); expect(text).not.toContain(UNTRUSTED_CLOSE);
  }
});

test('project recovery routes refuse foreign reads and decisions, including repeated receipts', async () => {
  const project = 'recovery-private';
  const flow = createFlow({ projectId: project });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Private recovery', trigger: { name: 'trigger', type: 'EMPTY' } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'FAILED' });
  const own = createWorkflowRoutes({ callerProjectId: () => project });
  const foreign = createWorkflowRoutes();
  const choice = { action: 'inspect', requestId: 'private_inspect', revision: getRunRecovery(run.id)!.revision, note: 'Inspected without retrying.' };
  const request = (method = 'GET') => Object.assign(new Request(`http://fixture.test/api/workflow-runs/${run.id}/recovery`, {
    method, ...(method === 'POST' ? { body: JSON.stringify(choice) } : {}),
  }), { params: { runId: run.id } });
  const key = '/api/workflow-runs/:runId/recovery';
  expect((await foreign[key]!.GET!(request())).status).toBe(404);
  expect((await foreign[key]!.POST!(request('POST'))).status).toBe(404);
  expect(getRunRecovery(run.id)!.receipts).toHaveLength(0);
  expect((await own[key]!.GET!(request())).status).toBe(200);
  expect((await own[key]!.POST!(request('POST'))).status).toBe(200);
  expect(getRunRecovery(run.id)!.receipts).toHaveLength(1);
  expect((await foreign[key]!.POST!(request('POST'))).status).toBe(404);
  expect((await own[key]!.POST!(request('POST'))).status).toBe(200);
  expect(getRunRecovery(run.id)!.receipts).toHaveLength(1);
  expect(getFlowRun(run.id)?.status).toBe('FAILED');
  expect(getWorkflowDb().query('SELECT COUNT(*) AS count FROM workflow_job').get()).toEqual({ count: 0 });
});

test('project recovery pagination filters by flow ownership before applying the limit', async () => {
  const project = 'recovery-private';
  const seed = (projectId: string) => {
    const flow = createFlow({ projectId });
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Recovery page', trigger: { name: 'trigger', type: 'EMPTY' } });
    return createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'FAILED' });
  };
  const foreignA = seed(DEFAULT_IDS.project), ownA = seed(project), foreignB = seed(DEFAULT_IDS.project), ownB = seed(project);
  // A legacy or corrupt run column cannot widen the flow's project boundary.
  getWorkflowDb().run('UPDATE flow_run SET project_id = ?', [DEFAULT_IDS.project]);
  const routes = createWorkflowRoutes({ callerProjectId: () => project });
  const list = async (cursor?: string) => {
    const response = await routes['/api/workflow-recovery']!.GET!(new Request(`http://fixture.test/api/workflow-recovery?limit=1${cursor ? `&cursor=${cursor}` : ''}`));
    expect(response.status).toBe(200);
    return await response.json() as { recoveries: Array<{ runId: string }>; next: string | null };
  };
  const first = await list();
  expect(first.recoveries.map(r => r.runId)).toEqual([ownA.id]);
  expect(first.next).not.toBeNull();
  const second = await list(first.next!);
  expect(second.recoveries.map(r => r.runId)).toEqual([ownB.id]);
  expect(second.next).toBeNull();
  await decideRunRecovery(ownA.id, { action: 'inspect', requestId: 'page_inspect', revision: getRunRecovery(ownA.id)!.revision, note: 'Reviewed.' });
  const acknowledged = await list();
  expect(acknowledged.recoveries).toEqual([]);
  expect((await list(acknowledged.next!)).recoveries.map(r => r.runId)).toEqual([ownB.id]);
  const publicPage = await createWorkflowRoutes()['/api/workflow-recovery']!.GET!(new Request('http://fixture.test/api/workflow-recovery'));
  expect((await publicPage.json() as { recoveries: Array<{ runId: string }> }).recoveries.map(r => r.runId)).toEqual([foreignA.id, foreignB.id]);
});
