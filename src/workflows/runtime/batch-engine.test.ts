import {TimerWaitpointScheduler} from '../timer-scheduler';
import {listWaitpointsByFlowRun} from '../db/repos/waitpoint';
/** The saved builder graph runs through the real worker/engine with synthetic providers only. */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initWorkflowDb,closeWorkflowDb,DEFAULT_IDS} from '../db';
import {setEncryptionKey} from '../db/encryption';
import {createFlow,getFlow,listFlows,setPublishedVersion,updateFlowStatus} from '../db/repos/flow';
import {createDraftVersion,getLatestDraft,lockVersion,updateDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun,listRuns} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {upsertConnection} from '../db/repos/app-connection';
import {configureWorkflowReadiness,versionReadiness} from '../db/repos/flow-readiness';
import {pinFlowBindings} from '../db/repos/binding-pins';
import {AuthorityEngine} from '../../authority/engine';
import {AuditTrail} from '../../authority/audit';
import {EmergencyController} from '../../authority/emergency';
import {ApprovalManager} from '../../authority/approval';
import {CredentialResolver} from '../credentials/adapter';
import {SandboxApi} from '../sandbox-api/server';
import {workflowLogsBase} from '../sandbox-api/config';
import {EngineRuntime} from '../runner/engine-runtime/engine-runtime';
import {EngineFlowExecutor} from '../runner/engine-runtime/engine-flow-executor';
import {buildEngineBundle} from '../runner/engine-runtime/build';
import {buildPiece} from '../runner/engine-runtime/build-pieces';
import {Worker} from '../queue/worker';
import {createRunFlowHandler,RUN_FLOW} from '../runner/handler';
import {buildSandboxServiceBackends} from './service-backends';
import {WorkflowEventBuffer} from './event-buffer';
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
import {compileWorkflow} from './workflow-readiness';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {batchFixturePayload,batchFixtureProvider,batchFixtureSetup,validateBatchFixtures} from './batch-fixtures';
import {BATCH_PIECE,BATCH_ACTION,BATCH_REQUIRED,batchSetup} from './lead-batch';
import {batchTestGraph} from './batch-test-data';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const versions:Record<string,string>={},notifications:string[]=[],runIds:string[]=[];
let now=Date.now(),expireAfterKey:string|null=null;
let provider=batchFixtureProvider();
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'jarvis-batch-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));
  const bundle=await buildEngineBundle();
  for(const name of ['batch','notify']) {
    const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis',name);await buildPiece(path);
    const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versions[meta.name]=meta.version;
    const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
  }
  for(const name of ['hubspot'])upsertConnection({externalId:'fixture-'+name,displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-'+name,pieceVersion:'0.0.1',value:{access_token:'synthetic-'+name}});
  authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
  approvals=new ApprovalManager();
  services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
    batchNow:()=>now,batchFetch:(async(url:any,init:any)=>{
      expect(init.headers.Authorization).toBe('Bearer synthetic-hubspot');const result=await provider.fetchImpl(url,init);if(expireAfterKey&&String(url).endsWith('/'+expireAfterKey)){expireAfterKey=null;now+=46_000;}return result;
    }) as typeof fetch,llmManager:{chat:async()=>{throw Error('No model tools or delegate may execute');}} as any,
    channelService:{sendWorkflowNotification:async()=>{throw Error('No external notifications');}} as any,wsService:{broadcastNotificationToDashboard:(text:string)=>{notifications.push(text);return 1;}} as any});
  api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
  const handle=await runtime.acquire({runId:'batch-metadata',projectId:DEFAULT_IDS.project});
  try {const entries=[];for(const[pieceName,pieceVersion]of Object.entries(versions))entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName,pieceVersion})));catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_BATCH_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_BATCH_CATALOG_EXPORT,JSON.stringify(entries));}
  finally{await handle.release();}
  worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
const setup=batchFixtureSetup;
function configuredGraph(original=batchTestGraph()):any {
 const g=structuredClone(original),node=g.nextAction;
 for(const key of BATCH_REQUIRED) if(node.settings.input[key]===''||node.settings.input[key]===null||node.settings.input[key]===undefined)node.settings.input[key]=setup[key];
 return g;
}
async function run(flowId:string,flowVersionId:string,payload:any=batchFixturePayload(batchSetup(setup))){
 const r=createFlowRun({flowId,flowVersionId});runIds.push(r.id);
 enqueue({jobType:RUN_FLOW,payload:{runId:r.id,flowVersionId,projectId:DEFAULT_IDS.project,payload},flowId,flowRunId:r.id});await worker.drain();return getFlowRun(r.id)!;
}
async function fixture(original=batchTestGraph()){
 now=Date.now();expireAfterKey=null;provider=batchFixtureProvider();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Lead batch fixture',trigger:configuredGraph(original)});
 expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');
 return {flow,version,run:(payload?:any)=>run(flow.id,version.id,payload)};
}

async function finish(id:string){
 for(let i=0;i<400;i++){
  const r=getFlowRun(id)!;if(r.status!=='PAUSED')return r;
  const waits=listWaitpointsByFlowRun(id,false).filter(w=>w.type==='TIMER');expect(waits).toHaveLength(1);
  now=Math.max(now+1,Date.parse(waits[0]!.resumeDateTime!));expect(new TimerWaitpointScheduler().tick(now)).toBeGreaterThanOrEqual(1);await worker.drain();
 }
 throw Error('Batch did not finish');
}
test('save disabled full graph with missing setup and execute public fixtures',async()=>{
 let turn=0;const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async()=>turn++===0?{content:'',tool_calls:[{id:'inspect',name:'get_piece_details',arguments:{pieceName:BATCH_PIECE}}]}:{content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Lead batch draft',trigger:batchTestGraph()}}]}}});
 const result=String(await tool.execute({action:'compose',name:'Lead batch draft',description:'Disabled unpublished webhook lead-list update-only HubSpot batch, per-record validation and continuation, durable deduplication, one final dashboard summary with references and partial failure status. Missing configuration stays Setup required.'}));
 expect(result).toContain('"ok":true');const flow=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Lead batch draft')!,v=getLatestDraft(flow.id)!;
 expect(flow.status).toBe('DISABLED');expect(flow.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);
 expect(compileWorkflow(v.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);expect(versionReadiness(flow.id,v.id).ready).toBe(false);
 expect(compileWorkflow(v.trigger,{pieces:catalog,phase:'composition'}).setupIssues).toHaveLength(7);
 const report=String(await tool.execute({action:'validate_fixtures',flow:flow.id}));expect(report).toContain('"passed":true');expect(report).toContain('"externalActions":0');
},60_000);
test('real engine sends one complete summary and marks mixed batch failed',async()=>{
 const f=await fixture(),payload:any=batchFixturePayload(batchSetup(setup));payload.leads[1]={};provider.modes['3']='fail';provider.modes['4']='unknown';const n=notifications.length;
 const first=await f.run(payload);expect(first.status).toBe('PAUSED');expect(notifications.length).toBe(n);
 expect((await finish(first.id)).status).toBe('FAILED');expect(provider.calls).toEqual(['1','3','4','5']);
 expect(notifications.length).toBe(n+1);expect(notifications.at(-1)).toContain('Updated: 2; rejected: 1; failed: 1; uncertain: 1');
 expect(notifications.at(-1)).toContain('fixture-submission/records/4');expect(notifications.at(-1)).toContain('https://app.hubspot.com/contacts/12345/contact/5');
 expect((await finish((await f.run(payload)).id)).status).toBe('FAILED');expect(provider.calls).toHaveLength(4);expect(notifications.length).toBe(n+1);
},60_000);
test('empty batch is a reported no-op; all failures are reported and fail the run',async()=>{
 for(const count of [0,5]){const f=await fixture(),n=notifications.length;for(let i=1;i<=5;i++)provider.modes[String(i)]='fail';
 expect((await finish((await f.run(batchFixturePayload(batchSetup(setup),count))).id)).status).toBe(count?'FAILED':'SUCCEEDED');
 expect(provider.calls).toHaveLength(count);expect(notifications.length).toBe(n+1);expect(notifications.at(-1)).toContain(count?'failed: 5':'empty, no updates');}
},60_000);
test('completed record receipts survive database reopen and paused timer resumes',async()=>{
 const f=await fixture(),n=notifications.length,first=await f.run();expect(first.status).toBe('PAUSED');expect(provider.calls).toEqual(['1','2','3']);
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));configureWorkflowReadiness({pieces:catalog});
 expect((await finish(first.id)).status).toBe('SUCCEEDED');expect(provider.calls).toEqual(['1','2','3','4','5']);expect(notifications.length).toBe(n+1);
 expect((await f.run()).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(5);expect(notifications.length).toBe(n+1);
},60_000);
test('concurrent deliveries share receipts and one summary',async()=>{
 const f=await fixture(),n=notifications.length;const runs=await Promise.all([f.run(),f.run()]);
 for(const r of runs)expect((await finish(r.id)).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(5);expect(new Set(provider.calls).size).toBe(5);expect(notifications.length).toBe(n+1);
},60_000);
test('Authority denial and changed configuration cannot dispatch writes',async()=>{
 const f=await fixture();authority.addOverride({action:'write_data',allowed:false});expect((await f.run()).status).toBe('FAILED');expect(provider.calls).toHaveLength(0);
 authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});expect((await finish((await f.run()).id)).status).toBe('SUCCEEDED');const n=provider.calls.length;
 const changed:any=batchFixturePayload(batchSetup(setup));changed.leads[0].name='Changed';expect((await f.run(changed)).status).toBe('FAILED');expect(provider.calls.length).toBe(n);
 const graph=configuredGraph();graph.nextAction.settings.input.hubspotPortalId='9876';const v=createDraftVersion({flowId:f.flow.id,displayName:'Changed config',trigger:graph});lockVersion(v.id);setPublishedVersion(f.flow.id,v.id);
 expect((await run(f.flow.id,v.id)).status).toBe('FAILED');expect(provider.calls.length).toBe(n);
},60_000);
test('changed pinned account stops before any provider call',async()=>{
 const f=await fixture();pinFlowBindings(f.flow.id);upsertConnection({externalId:'fixture-hubspot',displayName:'Changed',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.0.1',value:{access_token:'changed'}});
 try{expect((await f.run()).status).toBe('FAILED');expect(provider.calls).toHaveLength(0);}finally{upsertConnection({externalId:'fixture-hubspot',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.0.1',value:{access_token:'synthetic-hubspot'}});}
},60_000);
test('validator refuses missing/swallowed finalizer and wrong summary references',()=>{
 for(const mutate of [(g:any)=>{delete g.nextAction.nextAction.nextAction;},(g:any)=>{g.nextAction.nextAction.nextAction.settings.errorHandlingOptions={continueOnFailure:{value:true}};},(g:any)=>{g.nextAction.nextAction.settings.input.message='success';}]){const g=batchTestGraph();mutate(g);expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).ready).toBe(false);}
});

test('lost worker after a committed update resumes without repeating that dispatch',async()=>{
 const f=await fixture(),n=notifications.length;expireAfterKey='2';const first=await f.run();expect(first.status).toBe('FAILED');expect(provider.writes).toEqual(['1','2']);expect(notifications.length).toBe(n);
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));configureWorkflowReadiness({pieces:catalog});now+=46_000;
 expect((await finish((await f.run()).id)).status).toBe('FAILED');expect(provider.writes).toEqual(['1','2','3','4','5']);expect(notifications.length).toBe(n+1);expect(notifications.at(-1)).toContain('Updated: 4; rejected: 0; failed: 0; uncertain: 1');
},60_000);
test('one bound approval covers slices; revocation prevents subsequent writes',async()=>{
 const f=await fixture();authority.setGovernedCategories(['write_data']);const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run.id);
 const ctx={runId:run.id,projectId:DEFAULT_IDS.project,stepName:'batch',executionPath:[] as Array<[string,number]>},input={...setup,submission:batchFixturePayload(batchSetup(setup))};
 const pending=await services.leadBatch!(input,ctx) as any;expect(pending.approval).toBeDefined();expect(provider.calls).toHaveLength(0);
 approvals.approve(pending.approval.approvalId,'fixture');const slice=await services.leadBatch!(input,ctx) as any;expect(slice.complete).toBe(false);expect(provider.calls).toHaveLength(3);
 authority.addOverride({action:'write_data',allowed:false});await expect(services.leadBatch!(input,ctx)).rejects.toThrow();expect(provider.calls).toHaveLength(3);
});

// Real model output from the compose tool, not a hand-authored substitute.
test('actual generated saved draft executes mixed, empty, failed, interrupted and replay cases',async()=>{
 const generated=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/batch-generated-test15.json'),'utf8'));
 const saved=createFlow(),draft=createDraftVersion({flowId:saved.id,displayName:'Captured Test 15 draft',trigger:generated});
 expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();expect(listRuns({flowId:saved.id})).toHaveLength(0);
 const validation=compileWorkflow(generated,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues).toHaveLength(7);
 expect((await validateBatchFixtures(generated)).cases.every(c=>c.passed)).toBe(true);
 for(const scenario of ['mixed','empty','failed','interrupted','success']){
  const f=await fixture(generated),payload:any=batchFixturePayload(batchSetup(setup),scenario==='empty'?0:5),n=notifications.length;
  if(scenario==='mixed'){payload.leads[1]={};provider.modes['3']='fail';provider.modes['4']='unknown';}
  if(scenario==='failed')for(let i=1;i<=5;i++)provider.modes[String(i)]='fail';
  if(scenario==='interrupted')expireAfterKey='2';
  const first=await f.run(payload);let final=await finish(first.id);
  if(scenario==='interrupted'){expect(final.status).toBe('FAILED');expect(notifications.length).toBe(n);now+=46_000;final=await finish((await f.run(payload)).id);}
  expect(final.status).toBe(['success','empty'].includes(scenario)?'SUCCEEDED':'FAILED');expect(notifications.length).toBe(n+1);
  const calls=provider.calls.length;expect((await f.run(payload)).status).toBe(final.status);expect(provider.calls.length).toBe(calls);expect(notifications.length).toBe(n+1);
 }
},120_000);
