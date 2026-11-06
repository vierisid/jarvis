/** Real worker, engine subprocess, authenticated API handlers and file-backed SQLite. No provider calls. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, getFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun } from '../db/repos/flow-run';
import { enqueue } from '../db/repos/job-queue';
import { configureWorkflowReadiness, versionReadiness } from '../db/repos/flow-readiness';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { Worker } from '../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../runner/handler';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { HUMAN_INPUT_PIECE, type HumanRequest } from './human-input-contract';
import { dismissHumanInput, listHumanInputs, requestHumanInput, resolveHumanInput, resumeHumanInputs } from './human-input';
import { createWorkflowRoutes } from '../api/routes';
import { listWaitpointsByFlowRun } from '../db/repos/waitpoint';
let dir: string, api: SandboxApi, runtime: EngineRuntime, worker: Worker, catalog: PieceCatalog;
const runs: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-human-engine-')); initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 81));
  const bundle = await buildEngineBundle(), names: Array<{ name: string; version: string }> = [];
  for (const piece of ['jarvis/input', 'jarvis/subflow', 'core/approval']) {
    const path = join(import.meta.dir, '../activepieces/packages/pieces', piece); await buildPiece(path);
    const meta = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')); names.push(meta);
    const installed = join(dir, 'node_modules', meta.name); mkdirSync(dirname(installed), { recursive: true }); symlinkSync(join(path, 'dist'), installed, 'dir');
  }
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), authorityEngine: authority, approvalManager: new ApprovalManager(), emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: { chat: async () => { throw Error('No model calls'); } } as any, channelService: {} as any, wsService: {} as any });
  api = new SandboxApi({ services }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, pool: true, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  const handle = await runtime.acquire({ runId: 'human-metadata', projectId: DEFAULT_IDS.project });
  try { const entries = []; for (const meta of names) entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({ pieceName: meta.name, pieceVersion: meta.version }))); catalog = new PieceCatalog(entries); configureWorkflowReadiness({ pieces: catalog }); }
  finally { await handle.release(); }
  worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }) } });
}, 120000);
afterAll(async () => {
  await runtime?.shutdown(); await api?.stop(); closeWorkflowDb(); setEncryptionKey(null);
  for (const id of runs) rmSync(join(workflowLogsBase(), id + '.bin'), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const fields = [ { key: 'update', label: 'Daily update', type: 'long_text', required: true }, { key: 'count', label: 'Count', type: 'number', required: true }, { key: 'blocked', label: 'Blocked?', type: 'boolean', required: true } ];
const answers = { update: 'Finished the local fixture', count: 0, blocked: false };
function step(name: string, pieceName: string, actionName: string, input: any, nextAction?: any): any { return { name, type: 'PIECE', displayName: name, settings: { pieceName, pieceVersion: pieceName === '@activepieces/piece-approval' ? '0.1.19' : '0.0.1', actionName, input }, ...(nextAction ? { nextAction } : {}) }; }
function fixture(kind: 'input' | 'approval' = 'input', legacy = false, links: boolean | string = false, shared = false) {
  const flow = createFlow();
  const finish = step('returned', '@jarvispieces/piece-jarvis-subflow', 'return_result', { result: '{{ask}}' });
  const ask = step('ask', legacy ? '@activepieces/piece-approval' : HUMAN_INPUT_PIECE, legacy ? 'wait_for_approval' : `request_${kind}`,
    legacy ? { prompt: 'Review the fixture proposal', ...(links === true ? { requestId: '{{links.requestId}}' } : {}) } : { title: 'Daily operations update', prompt: 'What changed today?', fields, requestKey: '{{trigger.date}}', timeoutHours: 48, ...(shared ? { shareAcrossRuns: true } : {}) }, finish);
  const trigger: any = { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: links ? step('links', '@activepieces/piece-approval', 'create_approval_links', { prompt: 'Approve this fixture only' }, ask) : ask };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Fixture daily input', trigger });
  return { flow, version, async run(date = '2026-11-04') {
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runs.push(run.id);
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: { date } }, flowId: flow.id, flowRunId: run.id }); await worker.drain(); return getFlowRun(run.id)!;
  } };
}
const requestFor = (runId: string) => listHumanInputs(DEFAULT_IDS.project).find(r => r.runId === runId)!;
async function finish() { resumeHumanInputs(); await worker.drain(); }
function respond(request: HumanRequest, decision = 'submit', values: unknown = answers) { return resolveHumanInput(DEFAULT_IDS.project, request.id, { decision, generation: request.generation ?? 0, ...(decision === 'submit' ? { answers: values } : {}) }); }
test('saved disabled graph runs, pauses for a typed form, rejects invalid answers, resumes with zero/false, and deduplicates response and occurrence', async () => {
  const f = fixture(); expect(getFlow(f.flow.id)?.status).toBe('DISABLED'); expect(getFlow(f.flow.id)?.published_version_id).toBeNull();
  expect(versionReadiness(f.flow.id, f.version.id).ready).toBe(true);
  const run = await f.run(); expect(run.status).toBe('PAUSED'); const request = requestFor(run.id); expect(request.kind).toBe('input');
  expect(respond(request, 'submit', { count: '0', blocked: 'false' }).status).toBe(422);
  expect(getFlowRun(run.id)?.status).toBe('PAUSED'); expect(respond(request).status).toBe(200); expect(respond(request).status).toBe(200);
  expect(respond(request, 'submit', { ...answers, update: 'Changed' }).status).toBe(409);
  await finish(); const final = getFlowRun(run.id)!; expect(final.status).toBe('SUCCEEDED'); expect((final.steps as any).returned.output.output.answers).toEqual(answers);
  // A later run with the same key is a new occurrence: it asks again.
  const again = await f.run(); expect(again.status).toBe('PAUSED'); expect(requestFor(again.id).id).not.toBe(request.id);
  expect(listHumanInputs(DEFAULT_IDS.project).filter(r => r.flowId === f.flow.id)).toHaveLength(2);
  cancelFlowRun(again.id);
}, 60000);
test('a form that opts into sharing reuses one answer across runs with the same key', async () => {
  const f = fixture('input', false, false, true), first = await f.run('2026-12-01'), second = await f.run('2026-12-01');
  expect(first.status).toBe('PAUSED'); expect(second.status).toBe('PAUSED'); expect(requestFor(second.id)).toBeUndefined();
  // Stopping the run that created the shared form leaves it open for the run still waiting.
  expect(cancelFlowRun(first.id).accepted).toBe(true);
  const shared = listHumanInputs(DEFAULT_IDS.project).find(r => r.flowId === f.flow.id)!; expect(shared.status).toBe('pending');
  expect(respond(shared).status).toBe(200); await finish(); expect(getFlowRun(second.id)?.status).toBe('SUCCEEDED');
  expect((await f.run('2026-12-01')).status).toBe('SUCCEEDED');
  expect(listHumanInputs(DEFAULT_IDS.project).filter(r => r.flowId === f.flow.id)).toHaveLength(1);
});
for (const kind of ['input', 'approval'] as const) test(`${kind}: two runs with a static key are each asked, and stopping one leaves the other waiting`, async () => {
  const f = fixture(kind), one = await f.run('static'), two = await f.run('static');
  expect(one.status).toBe('PAUSED'); expect(two.status).toBe('PAUSED');
  const first = requestFor(one.id), second = requestFor(two.id); expect(first.id).not.toBe(second.id);
  expect(cancelFlowRun(one.id).accepted).toBe(true);
  expect(requestFor(one.id).status).toBe('cancelled'); expect(requestFor(two.id).status).toBe('pending'); expect(getFlowRun(two.id)?.status).toBe('PAUSED');
  if (kind === 'approval') {
    // A rejection in one run is never reused by a later run.
    expect(respond(second, 'reject').status).toBe(200); await finish(); expect(getFlowRun(two.id)?.status).toBe('FAILED');
    const three = await f.run('static'); expect(three.status).toBe('PAUSED'); expect(requestFor(three.id).status).toBe('pending');
    expect(respond(requestFor(three.id), 'approve').status).toBe(200); await finish(); expect(getFlowRun(three.id)?.status).toBe('SUCCEEDED');
  } else { expect(respond(second).status).toBe(200); await finish(); expect(getFlowRun(two.id)?.status).toBe('SUCCEEDED'); }
});
test('two daily occurrences answer out of order; file-backed database reopen preserves the correct response and waiting run', async () => {
  const f = fixture(), monday = await f.run('2026-11-09'), tuesday = await f.run('2026-11-10');
  expect(monday.status).toBe('PAUSED'); expect(tuesday.status).toBe('PAUSED');
  const second = requestFor(tuesday.id); expect(respond(second).status).toBe(200);
  closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 81)); configureWorkflowReadiness({ pieces: catalog });
  await finish(); expect(getFlowRun(tuesday.id)?.status).toBe('SUCCEEDED'); expect(getFlowRun(monday.id)?.status).toBe('PAUSED');
  expect(respond(requestFor(monday.id)).status).toBe(200); await finish(); expect(getFlowRun(monday.id)?.status).toBe('SUCCEEDED');
});
for (const decision of ['approve', 'reject', 'cancel']) test(`native approval ${decision} gates downstream result`, async () => {
  const f = fixture('approval'), run = await f.run(); expect(run.status).toBe('PAUSED'); expect(respond(requestFor(run.id), decision).status).toBe(200); await finish();
  expect(getFlowRun(run.id)?.status).toBe(decision === 'approve' ? 'SUCCEEDED' : 'FAILED');
  if (decision !== 'approve') expect((getFlowRun(run.id)?.steps as any).returned).toBeUndefined();
});
test('48 hour boundary expires request, refuses late approval, and fails without running the next step', async () => {
  const f = fixture('approval'), run = await f.run(), request = requestFor(run.id);
  expect(resolveHumanInput(DEFAULT_IDS.project, request.id, { decision: 'approve' }, request.deadline).status).toBe(409);
  await finish(); expect(getFlowRun(run.id)?.status).toBe('FAILED');
});
for (const links of [false, true, 'implicit']) test(`legacy approval has real controls and authenticated links: links=${links}`, async () => {
  const f = fixture('approval', true, links), run = await f.run(); expect(run.status).toBe('PAUSED');
  if (links) expect((run.steps as any).links.output.output.approvalLink).toContain('/?brief=1#/brief/needs-you');
  const request = requestFor(run.id); expect(request.kind).toBe('approval'); expect(respond(request, 'approve').status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
  expect((getFlowRun(run.id)?.steps as any).returned.output.output).toEqual({ approved: true });
});
for (const outcome of ['reject', 'cancel', 'expire']) test(`legacy Wait for Approval continues with approved:false on ${outcome}`, async () => {
  const f = fixture('approval', true), run = await f.run(), request = requestFor(run.id);
  if (outcome === 'expire') resumeHumanInputs(request.deadline); else expect(respond(request, outcome).status).toBe(200);
  await finish(); const final = getFlowRun(run.id)!;
  expect(final.status).toBe('SUCCEEDED'); expect((final.steps as any).returned.output.output).toEqual({ approved: false });
});
test('public waitpoint URL and wrong project cannot answer a human request; stopping closes it', async () => {
  const f = fixture(), run = await f.run(), request = requestFor(run.id);
  expect(resolveHumanInput('wrong-project', request.id, { decision: 'submit', answers }).status).toBe(404);
  const routes = createWorkflowRoutes(); const wp = listWaitpointsByFlowRun(run.id)[0]!;
  const req = Object.assign(new Request('http://localhost/api/webhooks/waitpoints/' + wp.id, { method: 'POST', body: JSON.stringify({ answers }) }), { params: { id: wp.id } });
  expect((await routes['/api/webhooks/waitpoints/:id']!.POST!(req)).status).toBe(403);
  expect(cancelFlowRun(run.id).accepted).toBe(true); expect(requestFor(run.id).status).toBe('cancelled'); expect(respond(request).status).toBe(409);
});
test('response before worker park survives and queues one continuation once paused', async () => {
  const f = fixture(), r = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id }); runs.push(r.id);
  getWorkflowDb().run("UPDATE flow_run SET status='RUNNING' WHERE id=?", [r.id]);
  const ctx = { runId: r.id, projectId: DEFAULT_IDS.project, stepName: 'ask', executionPath: [] };
  const waiting = await requestHumanInput({ title: 'Daily operations update', prompt: 'What changed today?', fields, requestKey: 'early', timeoutHours: 48 }, ctx) as any;
  expect(respond(requestFor(r.id)).status).toBe(200); expect(resumeHumanInputs()).toBe(0);
  getWorkflowDb().run("UPDATE flow_run SET status='PAUSED' WHERE id=?", [r.id]); expect(resumeHumanInputs()).toBe(1); expect(resumeHumanInputs()).toBe(0);
  // This deliberately constructed pre-park state has no engine checkpoint. Stop instead of executing that synthetic continuation.
  cancelFlowRun(r.id); expect(waiting.waitpointId).toBeTruthy();
});
test('answers must fit the response body cap together, and whitespace is no required answer', async () => {
  const { answerErrors, HUMAN_INPUT_MAX_BODY_BYTES } = await import('./human-input-contract');
  const many = Array.from({ length: 10 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: 'long_text' as const, required: true }));
  const long = Object.fromEntries(many.map(f => [f.key, 'x'.repeat(10000)]));
  expect(answerErrors(many, long)._form).toContain('too long together');
  expect(new TextEncoder().encode(JSON.stringify({ decision: 'submit', answers: long })).length).toBeGreaterThan(HUMAN_INPUT_MAX_BODY_BYTES);
  expect(answerErrors(fields as any, { ...answers, update: '  \t ' }).update).toBe('This answer is required');
  expect(answerErrors(fields as any, answers)).toEqual({});
});
test('reading the queue writes nothing unless a request actually closes', async () => {
  const f = fixture(), run = await f.run('2026-12-24'), changes = () => (getWorkflowDb().query('SELECT total_changes() AS n').get() as { n: number }).n;
  listHumanInputs(DEFAULT_IDS.project); const before = changes();
  for (let i = 0; i < 5; i++) listHumanInputs(DEFAULT_IDS.project);
  expect(changes()).toBe(before);
  listHumanInputs(DEFAULT_IDS.project, requestFor(run.id).deadline); expect(changes()).toBe(before + 1);
  expect(requestFor(run.id).status).toBe('expired'); cancelFlowRun(run.id);
});
test('a legacy Wait for Approval inside a loop asks again for every item', async () => {
  const flow = createFlow();
  const ask = step('ask', '@activepieces/piece-approval', 'wait_for_approval', { prompt: 'Approve {{loop.item}}' });
  const trigger: any = { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: { name: 'loop', type: 'LOOP_ON_ITEMS', displayName: 'loop', settings: { items: '{{trigger.items}}' }, firstLoopAction: ask } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Looped approvals', trigger });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runs.push(run.id);
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: { items: ['a', 'b'] } }, flowId: flow.id, flowRunId: run.id }); await worker.drain();
  expect(getFlowRun(run.id)?.status).toBe('PAUSED');
  const first = requestFor(run.id); expect(respond(first, 'approve').status).toBe(200); await finish();
  expect(getFlowRun(run.id)?.status).toBe('PAUSED');
  const pending = listHumanInputs(DEFAULT_IDS.project).filter(r => r.runId === run.id && r.status === 'pending');
  expect(pending).toHaveLength(1); expect(pending[0]!.id).not.toBe(first.id);
  expect(respond(pending[0]!, 'reject').status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
});

test('accepted answer exposes failed continuation and its exact run after database reopen', async () => {
  const f = fixture();
  const graph = structuredClone(f.version.trigger);
  graph.nextAction!.nextAction = step('failed', '@jarvispieces/piece-jarvis-subflow', 'require_success', { result: { status: 'failed', code: 'FIXTURE_FAILURE' } });
  updateDraftVersion(f.version.id, { trigger: graph });
  const run = await f.run(), request = requestFor(run.id);
  expect(respond(request).status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('FAILED');
  closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 81)); configureWorkflowReadiness({ pieces: catalog });
  const receipt = requestFor(run.id); expect(receipt.status).toBe('submitted');
  expect(receipt.runs).toEqual([{ runId: run.id, versionId: f.version.id, status: 'FAILED' }]);
  const { humanRequestNeedsAttention } = await import('./human-input-contract'); expect(humanRequestNeedsAttention(receipt)).toBe(true);
  const routes = createWorkflowRoutes();
  const response = await routes['/api/workflow-inputs']!.GET!(new Request('http://localhost/api/workflow-inputs'));
  expect((await response.json()).requests.find((r: HumanRequest) => r.id === receipt.id).runs).toEqual(receipt.runs);
});
test('editing a waiting draft withdraws the stale form before accepting an answer', async () => {
  const f = fixture(), run = await f.run(), request = requestFor(run.id);
  const graph = structuredClone(f.version.trigger); graph.nextAction!.settings!.input!.prompt = 'Changed question';
  updateDraftVersion(f.version.id, { trigger: graph });
  // A malformed response is refused before anything is withdrawn.
  expect(respond(request, 'approve').status).toBe(400); expect(requestFor(run.id).status).toBe('pending');
  const refused = respond(request); expect(refused.status).toBe(409); expect(refused.error).toContain('workflow changed'); await finish();
  const closed = requestFor(run.id); expect(closed).toMatchObject({ status: 'cancelled', closureReason: 'workflow_changed', answers: null });
  expect(getFlowRun(run.id)?.status).toBe('FAILED'); expect(getFlowRun(run.id)?.steps?.returned).toBeUndefined();
  const { humanRequestNeedsAttention } = await import('./human-input-contract'); expect(humanRequestNeedsAttention(closed)).toBe(true);
  expect(dismissHumanInput(DEFAULT_IDS.project, closed.id).status).toBe(200); expect(humanRequestNeedsAttention(requestFor(run.id))).toBe(false);
});
test('shared response receipts include each waiting run without hiding a stopped sibling', async () => {
  const f = fixture('input', false, false, true), first = await f.run('shared-outcomes'), second = await f.run('shared-outcomes');
  cancelFlowRun(first.id); const request = listHumanInputs(DEFAULT_IDS.project).find(r => r.flowId === f.flow.id)!;
  expect(request.status).toBe('pending'); expect(respond(request).status).toBe(200); await finish();
  const receipt = listHumanInputs(DEFAULT_IDS.project).find(r => r.id === request.id)!;
  expect(receipt.runs).toContainEqual({ runId: first.id, versionId: f.version.id, status: 'STOPPED' });
  expect(receipt.runs).toContainEqual({ runId: second.id, versionId: f.version.id, status: 'SUCCEEDED' });  // The user stopped that run: nothing about it needs attention.
  const { humanRequestNeedsAttention } = await import('./human-input-contract'); expect(humanRequestNeedsAttention(receipt)).toBe(false);
});
test('a shared form reopened after expiry reports only the runs that asked it again', async () => {
  const f = fixture('input', false, false, true), first = await f.run('reopened');
  const expired = requestFor(first.id); listHumanInputs(DEFAULT_IDS.project, expired.deadline);
  // The first run has not been resumed yet when the second run reopens the form.
  expect(getFlowRun(first.id)?.status).toBe('PAUSED');
  const second = await f.run('reopened'); expect(second.status).toBe('PAUSED');
  const reopened = requestFor(second.id); expect(reopened.id).toBe(expired.id); expect(reopened.status).toBe('pending');
  // It keeps the outcome it waited for and never takes the reopened form's answer.
  await finish(); expect(getFlowRun(first.id)?.status).toBe('FAILED'); expect(requestFor(second.id).status).toBe('pending');
  expect(respond(reopened).status).toBe(200); await finish(); expect(getFlowRun(second.id)?.status).toBe('SUCCEEDED');
  expect((getFlowRun(first.id)?.steps as any)?.returned).toBeUndefined();
  const receipt = listHumanInputs(DEFAULT_IDS.project).find(r => r.id === reopened.id)!;
  expect(receipt.runs).toEqual([{ runId: second.id, versionId: f.version.id, status: 'SUCCEEDED' }]);
  const { humanRequestNeedsAttention } = await import('./human-input-contract'); expect(humanRequestNeedsAttention(receipt)).toBe(false);
});
test('a failed continuation stays until dismissed in its own project, and dismissal survives a reread', async () => {
  const f = fixture();
  const graph = structuredClone(f.version.trigger);
  graph.nextAction!.nextAction = step('failed', '@jarvispieces/piece-jarvis-subflow', 'require_success', { result: { status: 'failed', code: 'FIXTURE_FAILURE' } });
  updateDraftVersion(f.version.id, { trigger: graph });
  const run = await f.run(), request = requestFor(run.id), routes = createWorkflowRoutes();
  const dismiss = (id: string) => routes['/api/workflow-inputs/:id/dismiss']!.POST!(Object.assign(
    new Request(`http://localhost/api/workflow-inputs/${id}/dismiss`, { method: 'POST' }), { params: { id } }));
  expect((await dismiss(request.id)).status).toBe(409);
  expect(respond(request).status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('FAILED');
  const { humanRequestNeedsAttention } = await import('./human-input-contract'); expect(humanRequestNeedsAttention(requestFor(run.id))).toBe(true);
  expect(dismissHumanInput('wrong-project', request.id).status).toBe(404);
  expect(humanRequestNeedsAttention(requestFor(run.id))).toBe(true);
  expect((await dismiss(request.id)).status).toBe(200);
  const after = requestFor(run.id); expect(after.dismissedAt).toBeNumber(); expect(after.runs?.[0]?.status).toBe('FAILED'); expect(humanRequestNeedsAttention(after)).toBe(false);
  expect((await dismiss('missing')).status).toBe(404);
});
test('editing a waiting draft and reverting it before answering lets the run continue', async () => {
  const f = fixture(), run = await f.run('reverted'), request = requestFor(run.id), original = structuredClone(f.version.trigger);
  const graph = structuredClone(original); graph.nextAction!.settings!.input!.prompt = 'Changed question';
  updateDraftVersion(f.version.id, { trigger: graph });
  // Polling and the scheduler tick never withdraw on a draft edit.
  listHumanInputs(DEFAULT_IDS.project); resumeHumanInputs(); expect(requestFor(run.id).status).toBe('pending');
  updateDraftVersion(f.version.id, { trigger: original });
  expect(respond(request).status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
});
test('an undismissed failure stays listed however many requests close after it', async () => {
  const f = fixture();
  const graph = structuredClone(f.version.trigger);
  graph.nextAction!.nextAction = step('failed', '@jarvispieces/piece-jarvis-subflow', 'require_success', { result: { status: 'failed', code: 'FIXTURE_FAILURE' } });
  updateDraftVersion(f.version.id, { trigger: graph });
  const run = await f.run('crowded'), request = requestFor(run.id);
  expect(respond(request).status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('FAILED');
  const later = Date.now() + 10 * 86400000;
  for (let i = 0; i < 21; i++) getWorkflowDb().run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,?,?,?,?,?,'expired')`,
    [`crowd-${i}`, DEFAULT_IDS.project, f.flow.id, 'x', JSON.stringify({ ...request, id: `crowd-${i}`, runId: `crowd-run-${i}`, runs: undefined, created: later + i, deadline: later + i }), later + i]);
  const { humanRequestNeedsAttention } = await import('./human-input-contract');
  expect(humanRequestNeedsAttention(requestFor(run.id))).toBe(true);
  expect(dismissHumanInput(DEFAULT_IDS.project, request.id).status).toBe(200);
  expect(requestFor(run.id)).toBeUndefined();
  getWorkflowDb().run("DELETE FROM workflow_human_request WHERE id LIKE 'crowd-%'");
});

for (const decision of ['submit', 'cancel']) test(`a delayed ${decision} cannot answer a reopened shared request`, async () => {
  const f = fixture('input', false, false, true), first = await f.run('stale-' + decision);
  const old = requestFor(first.id); listHumanInputs(DEFAULT_IDS.project, old.deadline);
  const second = await f.run('stale-' + decision), current = requestFor(second.id);
  expect(current.generation).toBe(1);
  const routes = createWorkflowRoutes();
  for (const generation of [undefined, 0, '1', -1, 1.5]) {
    const body = { decision, generation, ...(decision === 'submit' ? { answers } : {}) };
    const response = await routes['/api/workflow-inputs/:id']!.POST!(Object.assign(new Request('http://localhost/api/workflow-inputs/' + old.id,
      { method: 'POST', body: JSON.stringify(body) }), { params: { id: old.id } }));
    expect(response.status).toBe(409);
    expect(requestFor(second.id).status).toBe('pending');
  }
  expect(respond(current).status).toBe(200); expect(respond(current).status).toBe(200);
  expect(respond(old).status).toBe(409);
  await finish(); expect(getFlowRun(first.id)?.status).toBe('FAILED'); expect(getFlowRun(second.id)?.status).toBe('SUCCEEDED');
});

test('a delayed dismissal cannot acknowledge the failed result of a reopened request', async () => {
  const f = fixture('input', false, false, true);
  const graph = structuredClone(f.version.trigger);
  graph.nextAction!.nextAction = step('failed', '@jarvispieces/piece-jarvis-subflow', 'require_success', { result: { status: 'failed', code: 'FIXTURE_FAILURE' } });
  updateDraftVersion(f.version.id, { trigger: graph });
  const first = await f.run('dismiss-generation'), old = requestFor(first.id);
  listHumanInputs(DEFAULT_IDS.project, old.deadline);
  const second = await f.run('dismiss-generation'), current = requestFor(second.id);
  expect(respond(current).status).toBe(200); await finish(); expect(getFlowRun(second.id)?.status).toBe('FAILED');
  expect(dismissHumanInput(DEFAULT_IDS.project, current.id).status).toBe(409);
  expect(dismissHumanInput(DEFAULT_IDS.project, current.id, Date.now(), 0).status).toBe(409);
  expect(requestFor(second.id).dismissedAt).toBeUndefined();
  expect(dismissHumanInput(DEFAULT_IDS.project, current.id, Date.now(), 1).status).toBe(200);
});

test('response and dismissal bodies are capped while they stream, without a declared length', async () => {
  const routes = createWorkflowRoutes();
  // 64 chunks of 16 KB, pulled one at a time, so the test sees how much of the body was read.
  let pulled = 0;
  const post = (path: string, id: string) => {
    pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 64) controller.close(); else controller.enqueue(new Uint8Array(16_000).fill(32));
      },
    });
    return Object.assign(new Request(`http://localhost${path}`, { method: 'POST', body, duplex: 'half' } as RequestInit), { params: { id } });
  };
  const response = await routes['/api/workflow-inputs/:id']!.POST!(post('/api/workflow-inputs/missing', 'missing'));
  expect(response.status).toBe(413);
  expect(pulled).toBeLessThan(10);
  const dismissal = await routes['/api/workflow-inputs/:id/dismiss']!.POST!(post('/api/workflow-inputs/missing/dismiss', 'missing'));
  expect(dismissal.status).toBe(413);
  expect(pulled).toBeLessThan(4);
  // Under the cap the same route reaches the lookup.
  const small = Object.assign(new Request('http://localhost/api/workflow-inputs/missing/dismiss', { method: 'POST', body: '{}' }), { params: { id: 'missing' } });
  expect((await routes['/api/workflow-inputs/:id/dismiss']!.POST!(small)).status).toBe(404);
});

for (const reference of ['{{loop}}', '{{loop.iterations}}']) test(`loop answers can be consumed as ${reference} after durable waits`, async () => {
  const flow = createFlow();
  const ask = step('ask', HUMAN_INPUT_PIECE, 'request_input', { title: 'Review item', prompt: 'Review {{loop.item}}', fields, requestKey: 'review', timeoutHours: 1 });
  const trigger: any = { name: 'trigger', type: 'EMPTY', nextAction: {
    name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' }, firstLoopAction: ask,
    nextAction: step('returned', '@jarvispieces/piece-jarvis-subflow', 'return_result', { result: { collected: reference } }),
  } };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Collected reviews', trigger });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runs.push(run.id);
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: { items: ['a', 'b'] } }, flowId: flow.id, flowRunId: run.id }); await worker.drain();
  for (let i = 0; i < 2; i++) {
    expect(getFlowRun(run.id)?.status).toBe('PAUSED');
    const pending = listHumanInputs(DEFAULT_IDS.project).find(r => r.runId === run.id && r.status === 'pending')!;
    expect(respond(pending, 'submit', { ...answers, count: i ? 2.25 : 0 }).status).toBe(200);
    closeWorkflowDb(); initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 81)); configureWorkflowReadiness({ pieces: catalog });
    await finish();
  }
  const final = getFlowRun(run.id)!; expect(final.status).toBe('SUCCEEDED');
  const result = (final.steps as any).returned.output.output.collected;
  const iterations = reference === '{{loop}}' ? result.iterations : result;
  expect(iterations.map((i: any) => i.ask.output.answers.count)).toEqual([0, 2.25]);
  expect(iterations.every((i: any) => i.ask.output.answers.blocked === false)).toBe(true);
}, 60000);
