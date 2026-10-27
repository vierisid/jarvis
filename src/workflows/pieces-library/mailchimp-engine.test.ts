/** Published 0.5.10 metadata and all managed actions qualified in the real engine against local provider fixtures. */
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
import {JarvisMailchimpConnectionSource} from '../credentials/mailchimp-source';
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
const gate = process.env.JARVIS_TEST_MAILCHIMP_ENGINE === '1';
const piece = '@activepieces/piece-mailchimp';
let dir: string, api: SandboxApi, runtime: EngineRuntime, provider: ReturnType<typeof Bun.serve>;
let runId: string | undefined;
const requests: Array<{method: string; path: string; body: unknown; auth: string | null}> = [];
beforeAll(async () => {
 if (!gate) return;
 dir = mkdtempSync(join(tmpdir(), 'jarvis-mailchimp-engine-'));
 initWorkflowDb(join(dir, 'db.sqlite'));
 writeFileSync(join(dir, 'package.json'), JSON.stringify({private: true, dependencies: {[piece]: '0.5.10'}}));
 const install = spawnSync('bun', ['install','--silent','--backend','copy'], {cwd: dir, encoding: 'utf8'});
 if (install.status !== 0) throw new Error('npm install failed: ' + install.stderr);
 provider = Bun.serve({port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  const body = req.method === 'POST' ? await req.json() : {};
  requests.push({method: req.method, path, body, auth: req.headers.get('authorization')});
  if (req.headers.get('authorization') !== 'Bearer ENGINE_ONLY_MAILCHIMP') return new Response('invalid token', {status: 401});
  if (path === '/3.0/lists/audience1/members/b58996c504c5638798eb6b511e6f49af') return Response.json({id: 'b58996c504c5638798eb6b511e6f49af', email_address: 'user@example.com', list_id: 'audience1', status: 'subscribed'});
  if (path === '/3.0/lists/audience1/members/b58996c504c5638798eb6b511e6f49af/tags') return new Response(null, {status: 204});
  if (path === '/3.0/search-campaigns') return Response.json({total_items: 1, results: [{campaign: {id: 'campaign1', status: 'sent', settings: {title: 'Newsletter', subject_line: 'Hello'}}}]});
  if (path === '/3.0/reports/campaign1') return Response.json({id: 'campaign1', campaign_title: 'Newsletter', emails_sent: 100, opens: {unique_opens: 30, open_rate: 0.3}, clicks: {unique_clicks: 5, click_rate: 0.05}, bounces: {hard_bounces: 0, soft_bounces: 0}});
  return new Response('unknown endpoint', {status: 404});
 }});
 mkdirSync(join(dir, 'connections'));
 writeFileSync(join(dir, 'connections/mailchimp.json'), JSON.stringify({version: 1, provider: 'mailchimp', status: 'connected', generation: randomUUID(), access_token: 'ENGINE_ONLY_MAILCHIMP', settings: {server_prefix: 'us1'}, account: {id: 'account1', label: 'Owner'}, workspaces: [], connected_at: new Date().toISOString()}));
 const resolver = new CredentialResolver(); resolver.register(new JarvisMailchimpConnectionSource(dir));
 api = new SandboxApi({services: buildSandboxServiceBackends({credentialResolver: resolver, llmManager: {} as any, channelService: {} as any, wsService: {} as any, eventBuffer: new WorkflowEventBuffer(), approvalManager: new ApprovalManager(), auditTrail: new AuditTrail(), emergencyController: new EmergencyController(), authorityEngine: new AuthorityEngine({default_level: 10, governed_categories: [], overrides: [], context_rules: [], learning: {enabled: false, suggest_threshold: 10}, emergency_state: 'normal'})})});
 await api.start({port: 0});
 const bundle = await buildEngineBundle(), fixtureBundle = join(dir, 'engine-fixture.cjs');
 // Redirect only this fixture account's API host in a disposable engine copy.
 // Published package and production adapter stay intact. No live account calls.
 const redirect = `const providerFetch = globalThis.fetch; globalThis.fetch = (input, init) => {
   const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
   if (url.origin === 'https://us1.api.mailchimp.com') { url.protocol = 'http:'; url.host = '127.0.0.1:${provider.port}'; return providerFetch(url, init); }
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
test.skipIf(!gate)('published Mailchimp metadata and subscriber → tag → search → report → untag through the real engine', async () => {
 const {catalog, failures} = await buildPieceCatalog({runtime, pieceRoots: [join(dir, 'node_modules/@activepieces')], projectId: DEFAULT_IDS.project, pieceTimeoutMs: 30000, overallTimeoutMs: 45000});
 expect(failures).toEqual([]); const metadata = catalog.get(piece)!;
 expect(metadata.auth?.type).toBe('OAUTH2');
 for (const name of ['find_subscriber','add_subscriber_to_tag','remove_subscriber_from_tag','find_campaign','get_campaign_report']) {
  expect(metadata.actions[name]?.requireAuth).toBe(true); expect(metadata.actions[name]?.outputSample).toBeDefined();
 }
 expect(metadata.actions.find_subscriber?.outputSample).toMatchObject({primary_subscriber: {email_address: 'user@example.com'}});
 const step = (name: string, actionName: string, input: Record<string, unknown>, nextAction?: any) => ({name, type: 'PIECE' as const, settings: {pieceName: piece, pieceVersion: '0.5.10', actionName, input: {auth: '{{connections.jarvis:mailchimp}}', ...input}}, ...(nextAction ? {nextAction} : {})});
 const remove = step('remove', 'remove_subscriber_from_tag', {list_id: '{{subscriber.primary_subscriber.list_id}}', email: '{{subscriber.primary_subscriber.email_address}}', tag_name: 'Customer'});
 const report = step('report', 'get_campaign_report', {campaign_id: '{{search.results[0].campaign.id}}'}, remove);
 const search = step('search', 'find_campaign', {query: 'Newsletter'}, report);
 const add = step('add', 'add_subscriber_to_tag', {list_id: '{{subscriber.primary_subscriber.list_id}}', email: '{{subscriber.primary_subscriber.email_address}}', tag_name: 'Customer'}, search);
 const subscriber = step('subscriber', 'find_subscriber', {list_id: 'audience1', email: 'USER@example.com'}, add);
 const flow = createFlow(), version = createDraftVersion({flowId: flow.id, displayName: 'Mailchimp qualification', trigger: {name: 'trigger', type: 'EMPTY', nextAction: subscriber}});
 const run = createFlowRun({flowId: flow.id, flowVersionId: version.id}); runId = run.id;
 const worker = new Worker({log: () => {}, handlers: {RUN_FLOW: createRunFlowHandler({executor: new EngineFlowExecutor(runtime, {terminalTimeoutMs: 5000})})}});
 enqueue({jobType: 'RUN_FLOW', flowRunId: run.id, maxAttempts: 1, payload: {runId: run.id}}); await worker.drain();
 const complete = getFlowRun(run.id)!;
 expect({status: complete.status, steps: complete.steps}).toMatchObject({status: 'SUCCEEDED'});
 expect(requests.map(r => r.method)).toEqual(['GET','POST','GET','GET','POST']);
 expect(requests[1]!.body).toEqual({tags: [{name: 'Customer', status: 'active'}], is_syncing: true});
 expect(requests[4]!.body).toEqual({tags: [{name: 'Customer', status: 'inactive'}], is_syncing: true});
 expect(JSON.stringify(complete.steps)).not.toContain('ENGINE_ONLY_MAILCHIMP');
 expect(JSON.stringify(complete.steps)).toContain('unique_opens');
}, 90000);
