/** Real worker, engine subprocess, authenticated API handlers and file-backed SQLite. No provider calls. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS, getWorkflowDb } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, getFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
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
import { listHumanInputs, requestHumanInput, resolveHumanInput, resumeHumanInputs } from './human-input';
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
function fixture(kind: 'input' | 'approval' = 'input', legacy = false, links: boolean | string = false) {
  const flow = createFlow();
  const finish = step('returned', '@jarvispieces/piece-jarvis-subflow', 'return_result', { result: '{{ask}}' });
  const ask = step('ask', legacy ? '@activepieces/piece-approval' : HUMAN_INPUT_PIECE, legacy ? 'wait_for_approval' : `request_${kind}`,
    legacy ? { prompt: 'Review the fixture proposal', ...(links === true ? { requestId: '{{links.requestId}}' } : {}) } : { title: 'Daily operations update', prompt: 'What changed today?', fields, requestKey: '{{trigger.date}}', timeoutHours: 48 }, finish);
  const trigger: any = { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: links ? step('links', '@activepieces/piece-approval', 'create_approval_links', { prompt: 'Approve this fixture only' }, ask) : ask };
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Fixture daily input', trigger });
  return { flow, version, async run(date = '2026-11-04') {
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runs.push(run.id);
    enqueue({ jobType: RUN_FLOW, payload: { runId: run.id, payload: { date } }, flowId: flow.id, flowRunId: run.id }); await worker.drain(); return getFlowRun(run.id)!;
  } };
}
const requestFor = (runId: string) => listHumanInputs(DEFAULT_IDS.project).find(r => r.runId === runId)!;
async function finish() { resumeHumanInputs(); await worker.drain(); }
function respond(request: HumanRequest, decision = 'submit', values: unknown = answers) { return resolveHumanInput(DEFAULT_IDS.project, request.id, { decision, ...(decision === 'submit' ? { answers: values } : {}) }); }
test('saved disabled graph runs, pauses for a typed form, rejects invalid answers, resumes with zero/false, and deduplicates response and occurrence', async () => {
  const f = fixture(); expect(getFlow(f.flow.id)?.status).toBe('DISABLED'); expect(getFlow(f.flow.id)?.published_version_id).toBeNull();
  expect(versionReadiness(f.flow.id, f.version.id).ready).toBe(true);
  const run = await f.run(); expect(run.status).toBe('PAUSED'); const request = requestFor(run.id); expect(request.kind).toBe('input');
  expect(respond(request, 'submit', { count: '0', blocked: 'false' }).status).toBe(422);
  expect(getFlowRun(run.id)?.status).toBe('PAUSED'); expect(respond(request).status).toBe(200); expect(respond(request).status).toBe(200);
  expect(respond(request, 'submit', { ...answers, update: 'Changed' }).status).toBe(409);
  await finish(); const final = getFlowRun(run.id)!; expect(final.status).toBe('SUCCEEDED'); expect((final.steps as any).returned.output.output.answers).toEqual(answers);
  expect((await f.run()).status).toBe('SUCCEEDED'); expect(listHumanInputs(DEFAULT_IDS.project).filter(r => r.flowId === f.flow.id)).toHaveLength(1);
}, 60000);
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
