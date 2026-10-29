/** Published 0.7.3 metadata and all managed actions qualified in the real engine against local provider fixtures. */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {initWorkflowDb, closeWorkflowDb, DEFAULT_IDS} from '../db';
import {createFlow} from '../db/repos/flow';
import {createDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {CredentialResolver} from '../credentials/adapter';
import {JarvisGitHubConnectionSource} from '../credentials/github-source';
import {AuthorityEngine} from '../../authority/engine';
import {ApprovalManager} from '../../authority/approval';
import {AuditTrail} from '../../authority/audit';
import {EmergencyController} from '../../authority/emergency';
import {WorkflowEventBuffer} from '../runtime/event-buffer';
import {buildSandboxServiceBackends} from '../runtime/service-backends';
import {buildPieceCatalog} from '../runtime/piece-catalog';
import {SandboxApi} from '../sandbox-api/server';
import {workflowLogsBase} from '../sandbox-api/config';
import {buildEngineBundle} from '../runner/engine-runtime/build';
import {EngineRuntime} from '../runner/engine-runtime/engine-runtime';
import {EngineFlowExecutor} from '../runner/engine-runtime/engine-flow-executor';
import {createRunFlowHandler} from '../runner/handler';
import {Worker} from '../queue/worker';
const gate = process.env.JARVIS_TEST_GITHUB_ENGINE === '1';
const piece = '@activepieces/piece-github';
let dir: string, api: SandboxApi, runtime: EngineRuntime, provider: ReturnType<typeof Bun.serve>;
let runId: string | undefined;
const requests: Array<{method: string; path: string; body: unknown; auth: string | null}> = [];
beforeAll(async () => {
 if (!gate) return;
 dir = mkdtempSync(join(tmpdir(), 'jarvis-github-engine-'));
 initWorkflowDb(join(dir, 'db.sqlite'));
 writeFileSync(join(dir, 'package.json'), JSON.stringify({private: true, dependencies: {[piece]: '0.7.3'}}));
 const install = spawnSync('bun', ['install','--silent','--backend','copy'], {cwd: dir, encoding: 'utf8'});
 if (install.status !== 0) throw new Error('npm install failed: ' + install.stderr);
 provider = Bun.serve({port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  const body = ['POST','PATCH'].includes(req.method) ? await req.json() : {};
  requests.push({method: req.method, path, body, auth: req.headers.get('authorization')});
  if (req.headers.get('authorization') !== 'Bearer ENGINE_ONLY_GITHUB') return new Response('invalid token', {status: 401});
  const issue = {id: 10, number: 42, title: 'Bug', body: 'Description', state: 'open', url: 'https://api.github.com/repos/octocat/Sandbox/issues/42', html_url: 'https://github.com/octocat/Sandbox/issues/42'};
  if (path === '/repos/octocat/Sandbox/issues' && req.method === 'POST') return Response.json({...issue, ...body as object}, {status: 201});
  if (path === '/repos/octocat/Sandbox/issues/42') return Response.json({...issue, ...body as object});
  if (path === '/search/issues') return Response.json({total_count: 1, incomplete_results: false, items: [issue]});
  if (path === '/repos/octocat/Sandbox/issues/42/comments') return Response.json({id: 99, body: 'Investigating', issue_url: issue.url}, {status: 201});
  return new Response('unknown endpoint', {status: 404});
 }});
 mkdirSync(join(dir, 'connections'));
 writeFileSync(join(dir, 'connections/github.json'), JSON.stringify({version: 1, provider: 'github', status: 'connected', generation: randomUUID(), access_token: 'ENGINE_ONLY_GITHUB', account: {id: 'account1', label: 'Owner'}, workspaces: [], connected_at: new Date().toISOString()}));
 const resolver = new CredentialResolver(); resolver.register(new JarvisGitHubConnectionSource(dir));
 api = new SandboxApi({services: buildSandboxServiceBackends({credentialResolver: resolver, llmManager: {} as any, channelService: {} as any, wsService: {} as any, eventBuffer: new WorkflowEventBuffer(), approvalManager: new ApprovalManager(), auditTrail: new AuditTrail(), emergencyController: new EmergencyController(), authorityEngine: new AuthorityEngine({default_level: 10, governed_categories: [], overrides: [], context_rules: [], learning: {enabled: false, suggest_threshold: 10}, emergency_state: 'normal'})})});
 await api.start({port: 0});
 const bundle = await buildEngineBundle(), fixtureBundle = join(dir, 'engine-fixture.cjs');
 // Redirect only this fixture account's API host in a disposable engine copy.
 // Published package and production adapter stay intact. No live account calls.
 const redirect = `const providerFetch = globalThis.fetch; globalThis.fetch = (input, init) => {
   const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
   if (url.origin === 'https://api.github.com') { url.protocol = 'http:'; url.host = '127.0.0.1:${provider.port}'; return providerFetch(url, init); }
   return providerFetch(input, init);
 };\n`;
 writeFileSync(fixtureBundle, redirect + readFileSync(bundle.bundlePath, 'utf8'));
 const digest = createHash('sha256').update(readFileSync(fixtureBundle)).digest('hex');
 runtime = new EngineRuntime({api, bundlePath: fixtureBundle, expectedDigest: digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code'), egressPolicy: 'private-allowed'});
}, 120000);
afterAll(async () => {
 if (!gate) return;
 await runtime?.shutdown(); await api?.stop(); provider?.stop(true); closeWorkflowDb();
 if (runId) rmSync(join(workflowLogsBase(), runId + '.bin'), {force: true});
 if (dir) rmSync(dir, {recursive: true, force: true});
});
test.skipIf(!gate)('published GitHub metadata and create → get → update → search → comment through the real engine', async () => {
 const {catalog, failures} = await buildPieceCatalog({runtime, pieceRoots: [join(dir, 'node_modules/@activepieces')], projectId: DEFAULT_IDS.project, pieceTimeoutMs: 30000, overallTimeoutMs: 45000});
 expect(failures).toEqual([]); const metadata = catalog.get(piece)!;
 expect(metadata.version).toBe('0.7.3'); expect(metadata.auth?.type).toBe('OAUTH2');
 for (const name of ['github_create_issue','getIssueInformation','update_issue','find_issue','createCommentOnAIssue']) {
  expect(metadata.actions[name]?.requireAuth).toBe(true); expect(metadata.actions[name]?.outputSample).toBeDefined();
 }
 expect(metadata.actions.github_create_issue?.outputSample).toMatchObject({body: {number: 42}});
 const step = (name: string, actionName: string, input: Record<string, unknown>, nextAction?: any) => ({name, type: 'PIECE' as const, settings: {pieceName: piece, pieceVersion: '0.7.3', actionName, input: {auth: '{{connections.jarvis:github}}', repository: {owner: 'octocat', repo: 'Sandbox'}, ...input}}, ...(nextAction ? {nextAction} : {})});
 const comment = step('comment', 'createCommentOnAIssue', {issue_number: '{{search.result[0].number}}', comment: 'Investigating'});
 const search = step('search', 'find_issue', {title: '{{created.body.title}}', state: 'all'}, comment);
 const update = step('update', 'update_issue', {issue_number: '{{get.body.number}}', title: 'Fixed', state: 'closed'}, search);
 const get = step('get', 'getIssueInformation', {issue_number: '{{created.body.number}}'}, update);
 const created = step('created', 'github_create_issue', {title: 'Bug', description: 'Description'}, get);
 const flow = createFlow(), version = createDraftVersion({flowId: flow.id, displayName: 'GitHub qualification', trigger: {name: 'trigger', type: 'EMPTY', nextAction: created}});
 const run = createFlowRun({flowId: flow.id, flowVersionId: version.id}); runId = run.id;
 const worker = new Worker({log: () => {}, handlers: {RUN_FLOW: createRunFlowHandler({executor: new EngineFlowExecutor(runtime, {terminalTimeoutMs: 5000})})}});
 enqueue({jobType: 'RUN_FLOW', flowRunId: run.id, maxAttempts: 1, payload: {runId: run.id}}); await worker.drain();
 const complete = getFlowRun(run.id)!;
 expect({status: complete.status, steps: complete.steps}).toMatchObject({status: 'SUCCEEDED'});
 expect(requests.map(r => r.method)).toEqual(['POST','GET','GET','PATCH','GET','GET','POST']);
 expect(requests[0]!.body).toEqual({title: 'Bug', body: 'Description'});
 expect(requests[3]!.body).toEqual({title: 'Fixed', state: 'closed'});
 expect(requests[6]!.body).toEqual({body: 'Investigating'});
 expect(JSON.stringify(complete.steps)).not.toContain('ENGINE_ONLY_GITHUB');
 expect(JSON.stringify(complete.steps)).toContain('Investigating');
}, 90000);
