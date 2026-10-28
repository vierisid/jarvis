/** Generated support routing through production worker/engine and a loopback ClickUp mock. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, lockVersion } from '../db/repos/flow-version';
import { getFlowRun, listRuns } from '../db/repos/flow-run';
import { upsertConnection } from '../db/repos/app-connection';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { Worker } from '../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../runner/handler';
import { TriggerManager } from '../runner/triggers/manager';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { WorkflowEventBus } from './event-bus';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';

const PIECE = '@activepieces/piece-clickup';
import {savedSupportRoutingGraph,savedSupportRoutingCases,savedSupportRoutingSetup,rejectedSupportRoutingCases,objectSupportRoutingGraph,objectSupportRoutingSetup,objectSupportRoutingCases} from './support-routing-test-data';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {getFlow} from '../db/repos/flow';
import {getLatestDraft} from '../db/repos/flow-version';
import {compileWorkflow} from './workflow-readiness';
import {UNTRUSTED_OPEN} from '../../roles/untrusted';
import {enqueue} from '../db/repos/job-queue';
import {createFlowRun} from '../db/repos/flow-run';
let catalog: PieceCatalog;
let dir: string, api: SandboxApi, runtime: EngineRuntime, manager: TriggerManager, worker: Worker;
let provider: ReturnType<typeof Bun.serve>;
let loseReply = false;
const rows: unknown[] = [], runIds: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-support-engine-'));
  initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 35));
  const bundle = await buildEngineBundle();
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    rows.push(body);
    return loseReply ? new Response('Fixture lost reply after task creation', { status: 500 })
      : Response.json({ id: 'fixture-task-' + rows.length });
  } });
  const pieceDir = join(dir, 'fixture-clickup'); mkdirSync(join(pieceDir, 'src'), { recursive: true });
  writeFileSync(join(pieceDir, 'package.json'), JSON.stringify({ name: PIECE, version: '0.9.1' }));
  writeFileSync(join(pieceDir, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://localhost/unused', tokenUrl: 'http://localhost/unused' });
    const createTask = createAction({ name: 'create_task', displayName: 'Create task fixture', description: 'Mirrors inspected ClickUp inputs', auth,
      props: { workspace_id: Property.ShortText({ displayName: 'Workspace', required: true }),
        space_id: Property.ShortText({ displayName: 'Space', required: true }), list_id: Property.ShortText({ displayName: 'List', required: true }),
        name: Property.ShortText({ displayName: 'Title', required: true }), description: Property.LongText({ displayName: 'Description', required: false }),
        priority_id: Property.StaticDropdown({displayName:'Priority',required:false,options:{options:[{label:'Urgent',value:1},{label:'High',value:2},{label:'Normal',value:3},{label:'Low',value:4}]}}),custom_fields:Property.Json({displayName:'Fields',required:false}) },
      async run(context) {
        const response = await fetch('http://127.0.0.1:${provider.port}/task', { method: 'POST', body: JSON.stringify(context.propsValue) });
        if (!response.ok) throw new Error('Fixture reply lost after task creation');
        return response.json();
      }
    });
    export const clickup = createPiece({ displayName: 'Fixture ClickUp', description: 'Tests only', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [createTask], triggers: [] });
  `);
  await buildPiece(pieceDir);
  const installed = join(dir, 'node_modules', PIECE); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), installed, 'dir');
  upsertConnection({ externalId: 'fixture-clickup', displayName: 'Fixture', type: 'OAUTH2', pieceName: PIECE,
    pieceVersion: '0.9.1', value: { access_token: 'synthetic-only' } });
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  api = new SandboxApi({ services }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  const handle = await runtime.acquire({ runId: 'form-fixture-metadata', projectId: DEFAULT_IDS.project });
  try { catalog = new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({ pieceName: PIECE, pieceVersion: '0.9.1' }))]); configureWorkflowReadiness({ pieces: catalog }); }
  finally { await handle.release(); }
  manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await manager.start();
  worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }) } });
}, 120_000);
afterAll(async () => {
  await manager?.stop(); await runtime?.shutdown(); await api?.stop(); provider?.stop(true);
  closeWorkflowDb(); setEncryptionKey(null);
  for (const id of runIds) rmSync(join(workflowLogsBase(), id + '.bin'), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});


const unwrap=(raw:any)=>{const lines=String(raw).split('\n');return JSON.parse(lines[1]?.startsWith(UNTRUSTED_OPEN)?lines.slice(2,-1).join('\n'):String(raw));};
for(const fixture of [
 {label:'omitted-auth',graph:savedSupportRoutingGraph,setup:savedSupportRoutingSetup,cases:savedSupportRoutingCases},
 {label:'object-interpolation',graph:objectSupportRoutingGraph,setup:objectSupportRoutingSetup,cases:objectSupportRoutingCases},
])test('exact retest graph passes public fixtures and real-engine recovery: '+fixture.label,async()=>{
 const startingRows=rows.length, cases=fixture.cases(), setup=fixture.setup(), source=fixture.graph();
 const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{async chat({system}){
   expect(system).toContain('request_id_field');expect(system).toContain('strict boolean');
   return {text:JSON.stringify({displayName:'Support routing '+fixture.label,trigger:source})};
 }}});
 const result=unwrap(await tool.execute({action:'compose',name:'Support routing '+fixture.label,description:'Save disabled webhook request routing with ClickUp urgent before billing, invalid urgency review, general fallback. Deduplicate by request ID without email; defer missing setup.'}));
 expect(result.ok).toBe(true);
 const saved=getFlow(result.flow.id)!;expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();
 const draft=getLatestDraft(saved.id)!;
 expect(draft.trigger).toEqual(source);
 expect(compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);
 expect(compileWorkflow(draft.trigger,{pieces:catalog,phase:'activation'}).ready).toBe(false);
 const fixtureParams={action:'validate_fixtures',flow:saved.id,fixture_input:{setup,cases:[...cases,...rejectedSupportRoutingCases()]}};
 let page=unwrap(await tool.execute(fixtureParams)),content='';const firstCursor=page.nextCursor;
 expect(page.view).toBe('fixture_results');expect(firstCursor).toBeString();
 for(;;){
   expect(JSON.stringify(page).length).toBeLessThanOrEqual(4000);content+=page.content;
   if(!page.nextCursor)break;
   page=unwrap(await tool.execute({...fixtureParams,cursor:page.nextCursor}));
 }
 const report=JSON.parse(content);
 await expect(tool.execute({...fixtureParams,cursor:firstCursor,fixture_input:{...fixtureParams.fixture_input,cases:fixtureParams.fixture_input.cases.slice(0,1)}})).rejects.toThrow('changed');
 await expect(tool.execute({...fixtureParams,cursor:'invalid'})).rejects.toThrow('cursor');
 expect(report.flowId).toBe(saved.id);expect(report.versionId).toBe(draft.id);expect(report.cases).toHaveLength(cases.length+5);expect(report.externalActions).toBe(0);
 expect(getLatestDraft(saved.id)?.trigger).toEqual(draft.trigger);
 expect(listRuns({flowId:saved.id})).toHaveLength(0);expect(rows).toHaveLength(startingRows);
 // Configure only this isolated fixture copy, then exercise the exact saved graph.
 const graph=structuredClone(draft.trigger) as any;
 graph.settings.input.request_id_field='id';
 for(const n of graph.nextAction.children)Object.assign(n.settings.input,{...setup[n.name],auth:'{{connections.fixture-clickup}}'});
 const configured=createDraftVersion({flowId:saved.id,displayName:'Configured synthetic graph',trigger:graph});
 lockVersion(configured.id);setPublishedVersion(saved.id,configured.id);updateFlowStatus(saved.id,'ENABLED');await manager.refresh(saved.id);
 for(const [i,c] of cases.entries()){
   loseReply=!!c.loseReply;const before=rows.length;
   const payload={...c.payload,id:'request-'+i};
   const submit=()=>manager.webhookManager().handleRequest(saved.id,new Request('http://localhost/support',{method:'POST',body:JSON.stringify(payload)}));
   const responses=await Promise.all(Array.from({length:c.deliveries??1},async()=> (await submit()).json()));
   const started=responses.filter(x=>x.outcome==='started');expect(started).toHaveLength(1);runIds.push(started[0].runId);
   await worker.drain();expect(getFlowRun(started[0].runId)?.status).toBe(c.loseReply?'FAILED':'SUCCEEDED');
   expect(rows.length-before).toBe(1);expect((rows[before] as any).list_id).toBe(c.expectedSteps[0]);
   if(c.expectedPriority)expect(String((rows[before] as any).priority_id)).toBe(String(c.expectedPriority));
   if(fixture.label==='object-interpolation'){
     const description=(rows[before] as any).description as string;
     const prefix=c.expectedSteps[0]==='step_1'?'Urgency is missing or is not a boolean. Original request: ':'Original request: ';
     expect(description.startsWith(prefix)).toBe(true);
     const restored=JSON.parse(description.slice(prefix.length));
     expect(restored).toMatchObject(JSON.parse(JSON.stringify(payload)));
   }
   expect(listWorkflowEffects(started[0].runId)[0]?.status).toBe(c.loseReply?'dispatching':'succeeded');
   await manager.stop();manager=new TriggerManager({eventBus:new WorkflowEventBus(),log:()=>{}});await manager.start();
   expect((await (await submit()).json()).outcome).toBe('duplicate');
   const manual=createFlowRun({flowId:saved.id,flowVersionId:configured.id});runIds.push(manual.id);
   enqueue({jobType:RUN_FLOW,payload:{runId:manual.id,payload},flowRunId:manual.id,flowId:saved.id,flowVersionId:configured.id});
   await worker.drain();expect(getFlowRun(manual.id)?.status).toBe('FAILED');expect(rows.length-before).toBe(1);
 }
 for(const c of rejectedSupportRoutingCases()){
   const before=rows.length,runCount=listRuns({flowId:saved.id}).length;
   const response=await manager.webhookManager().handleRequest(saved.id,new Request('http://localhost/support',{method:'POST',body:JSON.stringify(c.payload)}));
   expect(response.status).toBe(422);
   expect(listRuns({flowId:saved.id})).toHaveLength(runCount);expect(rows).toHaveLength(before);
 }
 await manager.stop();closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));configureWorkflowReadiness({pieces:catalog});
 manager=new TriggerManager({eventBus:new WorkflowEventBus(),log:()=>{}});await manager.start();
 const restarted=await manager.webhookManager().handleRequest(saved.id,new Request('http://localhost/support',{method:'POST',body:JSON.stringify({...cases[12]!.payload,id:'request-12'})}));
 expect((await restarted.json()).outcome).toBe('duplicate');
 await worker.drain();expect(rows).toHaveLength(startingRows+cases.length);
},120_000);
