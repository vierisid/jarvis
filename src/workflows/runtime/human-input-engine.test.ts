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
import { BriefCapabilities } from '../../brief/capabilities';
import { listWaitpointsByFlowRun } from '../db/repos/waitpoint';
/** Needs you is the Brief decisions feature: its answer routes refuse with it off (#1266). */
const decisionsOn = new BriefCapabilities([{ id: 'decisions', provider: { readiness: () => 'ready' as const } }], ['decisions']);
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
function fixture(kind: 'input' | 'approval' = 'input', legacy = false, links: boolean | string = false, shared = false, continueOnReject: boolean | string = false, errorHandling?: any) {
  const flow = createFlow();
  const finish = step('returned', '@jarvispieces/piece-jarvis-subflow', 'return_result', { result: '{{ask}}' });
  const ask = step('ask', legacy ? '@activepieces/piece-approval' : HUMAN_INPUT_PIECE, legacy ? 'wait_for_approval' : `request_${kind}`,
    legacy ? { prompt: 'Review the fixture proposal', ...(continueOnReject ? { continueOnReject } : {}), ...(links === true ? { requestId: '{{links.requestId}}' } : {}) } : { title: 'Daily operations update', prompt: 'What changed today?', fields, requestKey: '{{trigger.date}}', timeoutHours: 48, ...(shared ? { shareAcrossRuns: true } : {}) }, finish);
  if (errorHandling) ask.settings.errorHandlingOptions = errorHandling;
  const trigger: any = { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: links ? step('links', '@activepieces/piece-approval', 'create_approval_links', { prompt: 'Approve this fixture only' }, ask) : ask };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Fixture daily input', trigger });
  return { flow, version, async run(date: unknown = '2026-11-04') {
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
for (const outcome of ['reject', 'cancel', 'expire']) test(`legacy Wait for Approval stops the run on ${outcome} and the next step never runs`, async () => {
  const f = fixture('approval', true), run = await f.run(), request = requestFor(run.id);
  if (outcome === 'expire') resumeHumanInputs(request.deadline); else expect(respond(request, outcome).status).toBe(200);
  await finish(); const final = getFlowRun(run.id)!;
  expect(final.status).toBe('FAILED'); expect((final.steps as any).returned).toBeUndefined();
  const { runFailure } = await import('./run-failure'); const failure = runFailure(final)!;
  expect(failure).toMatchObject({ category: 'approval_denied', effect: 'none', code: outcome === 'expire' ? 'APPROVAL_EXPIRED' : 'APPROVAL_DENIED' });
  expect(final.failedStep?.errorMessage).toContain(outcome === 'expire' ? 'not answered in time' : outcome === 'cancel' ? 'was cancelled in Needs you' : 'was rejected in Needs you');
});
for (const outcome of ['reject', 'cancel', 'expire']) test(`legacy Wait for Approval with Continue when rejected returns approved:false on ${outcome}`, async () => {
  const f = fixture('approval', true, false, false, true), run = await f.run(), request = requestFor(run.id);
  if (outcome === 'expire') resumeHumanInputs(request.deadline); else expect(respond(request, outcome).status).toBe(200);
  await finish(); const final = getFlowRun(run.id)!;
  expect(final.status).toBe('SUCCEEDED'); expect((final.steps as any).returned.output.output).toEqual({ approved: false });
});
// The opt-in is the author's saved choice: an expression that trigger data (or an
// earlier step) resolves to true is not one, and neither is Continue on failure.
test('legacy Wait for Approval stops on reject when Continue when rejected is an expression trigger data sets to true', async () => {
  const f = fixture('approval', true, false, false, '{{trigger.date}}'), run = await f.run(true), request = requestFor(run.id);
  expect(respond(request, 'reject').status).toBe(200); await finish(); const final = getFlowRun(run.id)!;
  expect(final.status).toBe('FAILED'); expect((final.steps as any).returned).toBeUndefined();
});
test('legacy Wait for Approval stops on reject even with Continue on failure saved on the step', async () => {
  const f = fixture('approval', true, false, false, false, { continueOnFailure: { value: true }, retryOnFailure: { value: true } });
  const run = await f.run(), request = requestFor(run.id);
  expect(respond(request, 'reject').status).toBe(200); await finish(); const final = getFlowRun(run.id)!;
  expect(final.status).toBe('FAILED'); expect((final.steps as any).returned).toBeUndefined();
});
test('legacy Wait for Approval with a request ID no Create Approval Links step made says where it must come from', async () => {
  const flow = createFlow();
  const finishStep = step('returned', '@jarvispieces/piece-jarvis-subflow', 'return_result', { result: '{{ask}}' });
  const ask = step('ask', '@activepieces/piece-approval', 'wait_for_approval', { prompt: 'Review', requestId: 'not-made-by-links' }, finishStep);
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Bad request id', trigger: { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: ask } as any });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runs.push(run.id);
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: {} }, flowId: flow.id, flowRunId: run.id }); await worker.drain();
  const final = getFlowRun(run.id)!; expect(final.status).toBe('FAILED');
  expect(final.failedStep?.errorMessage).toContain('Create approval links');
});
test('public waitpoint URL and wrong project cannot answer a human request; stopping closes it', async () => {
  const f = fixture(), run = await f.run(), request = requestFor(run.id);
  expect(resolveHumanInput('wrong-project', request.id, { decision: 'submit', answers }).status).toBe(404);
  const routes = createWorkflowRoutes({ briefCapabilities: decisionsOn }); const wp = listWaitpointsByFlowRun(run.id)[0]!;
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
  expect(respond(pending[0]!, 'approve').status).toBe(200); await finish(); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
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
  const routes = createWorkflowRoutes({ briefCapabilities: decisionsOn });
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
  const run = await f.run(), request = requestFor(run.id), routes = createWorkflowRoutes({ briefCapabilities: decisionsOn });
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
  for (let i = 0; i < 21; i++) getWorkflowDb().run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status,closed_at) VALUES (?,?,?,?,?,?,'expired',?)`,
    [`crowd-${i}`, DEFAULT_IDS.project, f.flow.id, 'x', JSON.stringify({ ...request, id: `crowd-${i}`, runId: `crowd-run-${i}`, runs: undefined, created: later + i, deadline: later + i }), later + i, later + i]);
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
  const routes = createWorkflowRoutes({ briefCapabilities: decisionsOn });
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

test('older closed requests remain directly accessible and history uses closure time, not deadline', async () => {
  const f = fixture(), run = await f.run('history'), request = requestFor(run.id), db = getWorkflowDb();
  cancelFlowRun(run.id); listHumanInputs(DEFAULT_IDS.project);
  const closed = Date.now() + 1000;
  // Closed in creation order, with deadlines in the opposite order.
  for (let i = 0; i < 25; i++) {
    db.run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status,closed_at) VALUES (?,?,?,?,?,?,'submitted',?)`,
      [`history-${i}`, DEFAULT_IDS.project, f.flow.id, 'x', JSON.stringify({ ...request, id: `history-${i}`, created: closed + i, deadline: closed + 1000000 - i, answers }), closed + 1000000 - i, closed + i]);
  }
  const routes = createWorkflowRoutes({ briefCapabilities: decisionsOn });
  const get = async (path: string, key: string, params = {}) => routes[key]!.GET!(Object.assign(new Request('http://localhost' + path), { params }));
  const listed = await (await get('/api/workflow-inputs', '/api/workflow-inputs')).json();
  expect(listed.requests.some((r: HumanRequest) => r.id === 'history-24')).toBe(true);
  expect(listed.requests.some((r: HumanRequest) => r.id === request.id)).toBe(false);
  // The polled cursor is the one the first history page would hand back.
  const { humanInputHistory } = await import('./human-input');
  expect(listed.historyCursor).toBe(humanInputHistory(DEFAULT_IDS.project).nextCursor);
  const direct = await get('/api/workflow-inputs/' + request.id, '/api/workflow-inputs/:id', { id: request.id });
  expect(direct.status).toBe(200);
  expect((await direct.json()).request.status).toBe('cancelled');
  const page = await (await get('/api/workflow-inputs/history?cursor=' + encodeURIComponent(listed.historyCursor), '/api/workflow-inputs/history')).json();
  expect(page.requests.some((r: HumanRequest) => r.id === request.id)).toBe(true);
  const all = [...listed.requests, ...page.requests].filter((r: HumanRequest) => r.id.startsWith('history-'));
  expect(new Set(all.map((r: HumanRequest) => r.id)).size).toBe(25);
  expect((await get('/api/workflow-inputs/history?cursor=bad', '/api/workflow-inputs/history')).status).toBe(400);
  const { getHumanInput } = await import('./human-input');
  expect(getHumanInput('other-project', request.id)).toBeNull();
  db.run("DELETE FROM workflow_human_request WHERE id LIKE 'history-%'");
});

test('response and dismissal bodies are capped while they stream, without a declared length', async () => {
  const routes = createWorkflowRoutes({ briefCapabilities: decisionsOn });
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

test('close time is stamped once, when the request closes, and a later dismissal never moves it', async () => {
  const f = fixture();
  const graph = structuredClone(f.version.trigger);
  graph.nextAction!.nextAction = step('failed', '@jarvispieces/piece-jarvis-subflow', 'require_success', { result: { status: 'failed', code: 'FIXTURE_FAILURE' } });
  updateDraftVersion(f.version.id, { trigger: graph });
  const run = await f.run('closed-at'), request = requestFor(run.id), db = getWorkflowDb();
  const closedAt = () => db.query<{ closed_at: number | null }, [string]>('SELECT closed_at FROM workflow_human_request WHERE id=?').get(request.id)!.closed_at;
  expect(closedAt()).toBeNull();
  const answeredAt = Date.now() + 5000;
  expect(resolveHumanInput(DEFAULT_IDS.project, request.id, { decision: 'submit', generation: 0, answers }, answeredAt).request?.closedAt).toBe(answeredAt);
  await finish();
  expect(getFlowRun(run.id)?.status).toBe('FAILED');
  expect(closedAt()).toBe(answeredAt);
  // A row closed long ago (as a backfilled legacy row would be) stays where it was when it is dismissed.
  db.run('UPDATE workflow_human_request SET closed_at=? WHERE id=?', [1000, request.id]);
  expect(dismissHumanInput(DEFAULT_IDS.project, request.id, Date.now() + 10000).status).toBe(200);
  expect(closedAt()).toBe(1000);
  expect((await import('./human-input')).getHumanInput(DEFAULT_IDS.project, request.id)!.closedAt).toBe(1000);
  expect(JSON.parse(db.query<{ record: string }, [string]>('SELECT record FROM workflow_human_request WHERE id=?').get(request.id)!.record).closedAt).toBeUndefined();
});

test('an expired request closes at its deadline, not when the queue was next read', async () => {
  const f = fixture(), run = await f.run('expired-closed-at'), request = requestFor(run.id);
  listHumanInputs(DEFAULT_IDS.project, request.deadline + 3600000);
  const closed = listHumanInputs(DEFAULT_IDS.project).find(r => r.id === request.id) ?? (await import('./human-input')).getHumanInput(DEFAULT_IDS.project, request.id)!;
  expect(closed.status).toBe('expired');
  expect(closed.closedAt).toBe(request.deadline);
  cancelFlowRun(run.id);
});

test('a reopened shared form is pending with no close time until it closes again', async () => {
  const f = fixture('input', false, false, true), first = await f.run('reopen-closed-at'), db = getWorkflowDb();
  const closedAt = (id: string) => db.query<{ closed_at: number | null }, [string]>('SELECT closed_at FROM workflow_human_request WHERE id=?').get(id)!.closed_at;
  const expired = requestFor(first.id);
  listHumanInputs(DEFAULT_IDS.project, expired.deadline);
  expect(closedAt(expired.id)).toBe(expired.deadline);
  const second = await f.run('reopen-closed-at'), reopened = requestFor(second.id);
  expect(reopened.status).toBe('pending');
  expect(reopened.closedAt).toBeUndefined();
  expect(closedAt(reopened.id)).toBeNull();
  // Out of the closed history until it closes again.
  const { humanInputHistory } = await import('./human-input');
  expect(humanInputHistory(DEFAULT_IDS.project).requests.some(r => r.id === reopened.id)).toBe(false);
  const answeredAt = Date.now() + 1000;
  expect(resolveHumanInput(DEFAULT_IDS.project, reopened.id, { decision: 'submit', generation: 1, answers }, answeredAt).status).toBe(200);
  expect(closedAt(reopened.id)).toBe(answeredAt);
  await finish();
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

// #1266 follow-up: the cap of 20 pending requests a flow may have stays; a run refused by it says why.
test('a flow at its 20 unanswered requests fails the asking step with a reason a person can act on', async () => {
  const f = fixture(), db = getWorkflowDb();
  /** `n` requests still waiting, each for a run of the flow that is paused on it. */
  const seed = (n: number) => { for (let i = 0; i < n; i++) {
    const waiting = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id, status: 'PAUSED' }); runs.push(waiting.id);
    db.run(`INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,?,?,?,?,?,'pending')`,
      [`cap-${i}`, DEFAULT_IDS.project, f.flow.id, 'x', JSON.stringify({ id: `cap-${i}`, kind: 'input', title: 't', prompt: 'p', fields: [], flowId: f.flow.id, runId: waiting.id, created: Date.now(), deadline: Date.now() + 3_600_000, status: 'pending', answers: null }), Date.now() + 3_600_000]);
  } };
  seed(20);
  const run = await f.run('cap');
  expect(run.status).toBe('FAILED');
  // The engine's step error carries Jarvis's own reason, not "internal error".
  expect(run.failedStep?.errorMessage).toContain('This workflow already has 20 requests waiting for an answer in Needs you (the limit is 20). Answer, reject or cancel');
  expect(run.failedStep?.errorMessage).not.toContain('internal error');
  const { runFailure } = await import('./run-failure');
  expect(runFailure(run)).toMatchObject({ category: 'not_started', effect: 'none', code: 'HUMAN_INPUT_LIMIT',
    headline: 'The step "ask" did not run: this workflow already has 20 requests waiting for an answer in Needs you. Answer, reject or cancel some of them there, or stop runs waiting on them, first.',
    detail: expect.stringContaining('or stop runs that are waiting on them, then run it again.') });
  expect(listHumanInputs(DEFAULT_IDS.project).filter(r => r.runId === run.id)).toEqual([]);
  db.run("DELETE FROM workflow_human_request WHERE id LIKE 'cap-%'");
  // One under the limit, the step asks as before.
  seed(19);
  expect((await f.run('cap-under')).status).toBe('PAUSED');
  db.run("DELETE FROM workflow_human_request WHERE id LIKE 'cap-%'");
});
