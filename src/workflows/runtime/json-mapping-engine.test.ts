/** Production worker/engine/authorization pipeline against a local Sheets fixture, never Google. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import {createRequire} from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, lockVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, listRuns, updateRun } from '../db/repos/flow-run';
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
import { enqueue } from '../db/repos/job-queue';
import { Worker } from '../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../runner/handler';
import { TriggerManager } from '../runner/triggers/manager';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { WorkflowEventBus } from './event-bus';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';

const PIECE = '@activepieces/piece-google-sheets';
let dir: string, api: SandboxApi, runtime: EngineRuntime, manager: TriggerManager, worker: Worker;
let provider: ReturnType<typeof Bun.serve>;
let loseReply = false, rejectWrite = false;
let catalog: PieceCatalog;
let services: ReturnType<typeof buildSandboxServiceBackends>;
const receiptRequests: Array<{req:any;ctx:any}> = [];
let providerOutcomes: Record<string,string> = {};
const writes: Array<{tab:string;rows:any[]}> = [];
const rows: unknown[] = [], runIds: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-product-engine-'));
  initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 35));
  const bundle = await buildEngineBundle();
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    if(body.value_input_option!=='RAW'||!Array.isArray(body.values)||!body.values.every(Array.isArray))return new Response('Invalid rows',{status:400});
    const outcome=providerOutcomes[body.worksheet_title];
    if(rejectWrite||outcome==='failure')return new Response('Fixture rejected append',{status:400});
    rows.push(...body.values);writes.push({tab:body.worksheet_title,rows:body.values});
    return (loseReply||outcome==='uncertain') ? new Response('Fixture lost reply after append', { status: 500 })
      : Response.json({ updatedRows: body.values.length, updatedRange: 'Submissions!A2:C2' });
  } });
  const pieceDir = join(dir, 'fixture-sheets'); mkdirSync(join(pieceDir, 'src'), { recursive: true });
  writeFileSync(join(pieceDir, 'package.json'), JSON.stringify({ name: PIECE, version: '0.18.2' }));
  writeFileSync(join(pieceDir, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://localhost/unused', tokenUrl: 'http://localhost/unused' });
    const append = createAction({ name: 'sheets_append_values', displayName: 'Append fixture', description: 'Mirrors inspected Sheets inputs', auth,
      props: { spreadsheet_id: Property.ShortText({ displayName: 'ID', required: true }),
        worksheet_title: Property.ShortText({ displayName: 'Tab', required: true }), range: Property.ShortText({ displayName: 'Range', required: true }),
        values: Property.Json({ displayName: 'Rows', required: true }), value_input_option: Property.ShortText({ displayName: 'Input mode', required: true }) },
      async run(context) {
        const response = await fetch('http://127.0.0.1:${provider.port}/append', { method: 'POST', body: JSON.stringify(context.propsValue) });
        if (!response.ok) throw new Error('Fixture reply lost after append');
        return response.json();
      }
    });
    export const sheets = createPiece({ displayName: 'Fixture Sheets', description: 'Tests only', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [append], triggers: [] });
  `);
  await buildPiece(pieceDir);
  const installed = join(dir, 'node_modules', PIECE); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), installed, 'dir');
  upsertConnection({ externalId: 'fixture-sheets', displayName: 'Fixture', type: 'OAUTH2', pieceName: PIECE,
    pieceVersion: '0.18.2', value: { access_token: 'synthetic-only' } });
  const jsonInstalled=join(dir,'node_modules/@activepieces/piece-json');
  symlinkSync(dirname(dirname(createRequire(import.meta.url).resolve('@activepieces/piece-json'))),jsonInstalled,'dir');
  const subflow=await buildPiece(join(import.meta.dir,'../activepieces/packages/pieces/jarvis/subflow'));
  const subInstalled=join(dir,'node_modules',subflow.packageName);mkdirSync(dirname(subInstalled),{recursive:true});symlinkSync(dirname(subflow.packageJsonPath),subInstalled,'dir');
  services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  api = new SandboxApi({ services:{...services,pieceAuthorize:async(req,ctx)=>{
    if(req.piece===PIECE)receiptRequests.push(structuredClone({req,ctx}));
    return services.pieceAuthorize!(req,ctx);
  }} }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, pool:true, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  const handle = await runtime.acquire({ runId: 'form-fixture-metadata', projectId: DEFAULT_IDS.project });
  try {
    catalog=new PieceCatalog(await Promise.all([[PIECE,'0.18.2'],['@activepieces/piece-json','0.1.14'],[subflow.packageName,subflow.pieceVersion]].map(async([pieceName,pieceVersion])=>metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:pieceName!,pieceVersion:pieceVersion!})))));
    configureWorkflowReadiness({pieces:catalog});
  }
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


import {productSetup,repairedProductGraph,repairedProductCases} from './product-fixture-data';
import {repairedProductRetestGraph,productRetestSetup,productRetestCases} from './product-retest-data';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {getLatestDraft} from '../db/repos/flow-version';
import {getFlow} from '../db/repos/flow';
import {UNTRUSTED_OPEN} from '../../roles/untrusted';
const unwrap=(raw:any)=>{const lines=String(raw).split('\n');return JSON.parse(lines[1]?.startsWith(UNTRUSTED_OPEN)?lines.slice(2,-1).join('\n'):String(raw));};
for (const scenario of [
  {name:'original product',graph:repairedProductGraph,setup:productSetup,cases:repairedProductCases},
  {name:'retested batch product',graph:repairedProductRetestGraph,setup:productRetestSetup,cases:productRetestCases},
]) test(scenario.name+' saved graph passes public tool and real worker with mocked Sheets',async()=>{
  const source=scenario.graph(),setup=scenario.setup(),cases=scenario.cases();
  const flow=createFlow();const draft=createDraftVersion({flowId:flow.id,displayName:'Captured product graph',trigger:source});
  const tool=createManageWorkflowTool({pieceRegistry:catalog});
  const args={action:'validate_fixtures',flow:flow.id,fixture_input:{setup,cases}};
  let page=unwrap(await tool.execute(args)),content='';
  for(;;){content+=page.content;if(!page.nextCursor)break;page=unwrap(await tool.execute({...args,cursor:page.nextCursor}));}
  const report=JSON.parse(content);expect(report.cases).toHaveLength(cases.length);expect(report.flowId).toBe(flow.id);expect(report.versionId).toBe(draft.id);expect(report.externalActions).toBe(0);
  expect(getLatestDraft(flow.id)?.trigger).toEqual(source);expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(getFlow(flow.id)?.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);
  const graph=scenario.graph();Object.assign(graph.nextAction.settings.input,setup.step_1);Object.assign(graph.nextAction.nextAction.nextAction.children[0].settings.input,{...setup.step_3,auth:'{{connections.fixture-sheets}}'});
  const version=createDraftVersion({flowId:flow.id,displayName:'Isolated configured fixture',trigger:graph});
  lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');await manager.refresh(flow.id);
  for(const c of cases){
    rejectWrite=c.sheetsOutcome==='failure';loseReply=c.sheetsOutcome==='uncertain';const before=rows.length;
    const response=await manager.webhookManager().handleRequest(flow.id,new Request('http://localhost/products',{method:'POST',body:JSON.stringify(c.payload)}));
    const accepted=await response.json();expect(accepted.outcome).toBe('started');runIds.push(accepted.runId);
    await worker.drain();const run=getFlowRun(accepted.runId)!;
    expect(run.status,c.name+': '+JSON.stringify(run)).toBe(['FAILED','UNCERTAIN'].includes(c.expectedStatus)?'FAILED':'SUCCEEDED');
    expect(rows.slice(before),c.name).toEqual(c.expectedRows);
    if(c.expectedStates){const result=getWorkflowDb().query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(accepted.runId) as {value:string};expect(JSON.parse(result.value).states,c.name).toEqual(c.expectedStates);}
    if(c.assertions?.length){
      const stored=getWorkflowDb().query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(accepted.runId) as {value:string};
      const result=JSON.parse(stored.value),validation=result.validation??result;
      for(const assertion of c.assertions){
        expect(assertion.step).toBe('step_2');
        const value=assertion.path.reduce((v:any,key:string|number)=>v[key],validation);
        expect(value,c.name+': '+assertion.path.join('.')).toEqual(assertion.equals);
      }
    }
    if(c.expectedRequests===0)expect(listWorkflowEffects(accepted.runId).filter(e=>e.stepName==='step_3')).toHaveLength(0);
  }
},120_000);

import {repairedOrderGraph,orderSetup,orderCases} from './order-fixture-data';
import {compileWorkflow} from './workflow-readiness';
import {KeyedRateLimiter} from '../runner/triggers/rate-limiter';
import {WEBHOOK_PER_FLOW_PER_MINUTE,WEBHOOK_GLOBAL_PER_MINUTE} from '../runner/triggers/webhook';

test('order graph: real worker preserves both tabs and durable admission/receipts across restart',async()=>{
  rejectWrite=loseReply=false;providerOutcomes={};
  const graph=repairedOrderGraph(),setup=orderSetup(),cases=orderCases();
  const flow=createFlow(),draft=createDraftVersion({flowId:flow.id,displayName:'Captured order draft',trigger:graph});
  const readiness=compileWorkflow(graph,{pieces:catalog,phase:'activation'});
  expect(readiness.issues.some(i=>i.node==='order_mapping'&&i.path==='settings.input.json')).toBe(true);
  expect(readiness.ready).toBe(false);
  const tool=createManageWorkflowTool({pieceRegistry:catalog});
  const args={action:'validate_fixtures',flow:flow.id,fixture_input:{setup,cases}};
  let page=unwrap(await tool.execute(args)),content='';
  for(;;){content+=page.content;if(!page.nextCursor)break;page=unwrap(await tool.execute({...args,cursor:page.nextCursor}));}
  const report=JSON.parse(content);expect(report.passed).toBe(true);expect(report.cases).toHaveLength(26);
  expect(getLatestDraft(flow.id)?.trigger).toEqual(graph);expect(listRuns({flowId:flow.id})).toHaveLength(0);
  expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(getFlow(flow.id)?.published_version_id).toBeNull();
  const configure=(node:any)=>{
    if(!node)return;
    if((setup as any)[node.name])Object.assign(node.settings.input,(setup as any)[node.name]);
    if(node.settings?.pieceName===PIECE)node.settings.input.auth='{{connections.fixture-sheets}}';
    for(const child of node.children??[])configure(child);configure(node.nextAction);
  };configure(graph);
  const version=createDraftVersion({flowId:flow.id,displayName:'Isolated configured orders',trigger:graph});
  lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');await manager.refresh(flow.id);
  const submit=(payload:any)=>manager.webhookManager().handleRequest(flow.id,new Request('http://localhost/orders',{method:'POST',body:JSON.stringify(payload)}));
  const admitted:Array<{payload:any;runId:string}> = [];
  let ingressNow=0;
  manager.webhookManager().setRateLimiters(new KeyedRateLimiter(60_000,WEBHOOK_PER_FLOW_PER_MINUTE,()=>ingressNow),new KeyedRateLimiter(60_000,WEBHOOK_GLOBAL_PER_MINUTE,()=>ingressNow));
  for(const [index,c] of cases.entries()){
    ingressNow+=60_001; // Each independent fixture gets a fresh simulated rate-limit window.
    providerOutcomes=Object.fromEntries(Object.entries(c.sheetsOutcomes??{}).map(([step,outcome])=>[step==='step_2'?'Orders':'Lines',String(outcome)]));
    const before=rows.length,writeStart=writes.length;
    // Every independent scenario needs its own stable order ID; same-case
    // deliveries all contend for that one ID.
    const payload={...c.payload,...(c.expectedAdmissionRejections?{}:{orderId:'fixture-'+index})};
    const responses=await Promise.all(Array.from({length:c.deliveries??1},async()=>{const r=await submit(payload);return {status:r.status,body:await r.json()};}));
    if(c.expectedAdmissionRejections){expect(responses[0]!.status).toBe(422);expect(rows.length).toBe(before);continue;}
    const starts=responses.filter(r=>r.body.outcome==='started');expect(starts,c.name).toHaveLength(1);
    expect(responses.filter(r=>r.body.outcome==='duplicate'),c.name+': '+JSON.stringify(responses)).toHaveLength((c.deliveries??1)-1);
    const runId=starts[0]!.body.runId;runIds.push(runId);admitted.push({payload,runId});await worker.drain();
    const run=getFlowRun(runId)!;expect(run.status,c.name).toBe(['FAILED','UNCERTAIN'].includes(c.expectedStatus)?'FAILED':'SUCCEEDED');
    const expected=(list:any[])=>list.map(row=>[payload.orderId,...row.slice(1)]);
    expect(rows.slice(before),c.name).toEqual(expected(c.expectedRows));
    for(const [step,tab] of [['step_2','Orders'],['step_3','Lines']]){
      const actual=writes.slice(writeStart).filter(w=>w.tab===tab).flatMap(w=>w.rows);
      expect(actual,c.name+' '+tab).toEqual(expected(c.expectedRowsByStep[step!]));
    }
    const after=rows.length;expect((await (await submit(payload)).json()).outcome).toBe('duplicate');await worker.drain();expect(rows.length).toBe(after);
  }
  const beforeRestart=JSON.stringify(writes);
  await manager.stop();closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));configureWorkflowReadiness({pieces:catalog});
  manager=new TriggerManager({eventBus:new WorkflowEventBus(),log:()=>{}});await manager.start();
  for(const item of admitted)expect((await (await submit(item.payload)).json()).outcome).toBe('duplicate');
  await worker.drain();expect(JSON.stringify(writes)).toBe(beforeRestart);
  // Reauthorize the exact recorded calls: completed appends reuse the stored
  // result; unresolved calls cannot dispatch again, even after DB reopen.
  const calls=receiptRequests.filter(c=>admitted.some(x=>x.runId===c.ctx.runId));
  expect(calls.length).toBeGreaterThan(0);
  for(const {req,ctx} of calls){
    const effect=listWorkflowEffects(ctx.runId).find(e=>e.stepName===ctx.stepName)!;
    const previous=getFlowRun(ctx.runId)!.status;
    await expect(services.pieceAuthorize!(req,ctx)).rejects.toThrow('Workflow effect blocked: run is');
    // Test the persisted effect boundary in isolation as an active step.
    // This is a synthetic same-step reauthorization, not an automatic resume
    // of a terminal workflow; the queue refuses that separately below.
    updateRun(ctx.runId,{status:'RUNNING'});
    try {
      if(effect.status==='succeeded')expect(await services.pieceAuthorize!(req,ctx)).toMatchObject({dispatch:'completed'});
      else await expect(services.pieceAuthorize!(req,ctx)).rejects.toThrow(/uncertain|replay is blocked/);
    } finally {updateRun(ctx.runId,{status:previous});}
  }
  // Neither a manually queued new run nor requeuing a terminal run bypasses admission.
  const item=admitted.at(-1)!;
  const manual=createFlowRun({flowId:flow.id,flowVersionId:version.id});runIds.push(manual.id);
  for(const runId of [manual.id,item.runId])enqueue({jobType:RUN_FLOW,payload:{runId,payload:item.payload},flowRunId:runId,flowId:flow.id,flowVersionId:version.id});
  await worker.drain();expect(getFlowRun(manual.id)?.status).toBe('FAILED');expect(JSON.stringify(writes)).toBe(beforeRestart);
},120_000);
