import {afterAll,beforeAll,expect,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initWorkflowDb,closeWorkflowDb,DEFAULT_IDS} from '../db';
import {setEncryptionKey} from '../db/encryption';
import {createFlow,getFlow,setPublishedVersion,updateFlowStatus,listFlows} from '../db/repos/flow';
import {createDraftVersion,getLatestDraft,lockVersion,updateDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun,listRuns,updateRun} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {listWaitpointsByFlowRun} from '../db/repos/waitpoint';
import {upsertConnection} from '../db/repos/app-connection';
import {listRunConnectionBindings,nodeConnectionReferences,pinFlowBindings} from '../db/repos/binding-pins';
import {configureWorkflowReadiness,versionReadiness} from '../db/repos/flow-readiness';
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
import {TimerWaitpointScheduler} from '../timer-scheduler';
import {buildSandboxServiceBackends} from './service-backends';
import {WorkflowEventBuffer} from './event-buffer';
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
import {compileWorkflow} from './workflow-readiness';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {IMPORT_PIECE,IMPORT_ACTION,IMPORT_REQUIRED} from './contact-import';
import {importFixtureSetup as setup,importFixtureProvider} from './import-fixtures';
import {workflowSafeguards} from './workflow-safeguards';
import {cancelFlowRun} from '../db/repos/run-cancellation';
import {listWorkflowEffects} from '../db/repos/workflow-effect';
import {getRunRecovery} from './recovery';
import {otherSteps} from './run-failure';
import {walkFlowNodes} from '../db/flow-graph';
import type {ImportRequest} from './contact-import';
let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>,now=Date.now(),provider=importFixtureProvider(),resolver:CredentialResolver,tokenDown=false;
/** Most tests below step one operation per call, to reach each slice boundary; the throughput test uses the production budget. */
let budget={ms:20_000,operations:1},audit:AuditTrail;
const runIds:string[]=[];
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-import-engine-'));initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));
 const bundle=await buildEngineBundle();const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/import');await buildPiece(path);
 const installed=join(dir,'node_modules',IMPORT_PIECE);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 upsertConnection({externalId:'fixture-hubspot',displayName:'Fixture HubSpot',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.12.1',value:{access_token:'synthetic-hubspot'}});
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:resolver=new CredentialResolver({tokenTransport:async()=>{if(tokenDown)throw Error('token endpoint unreachable');return {status:200,body:{access_token:'synthetic-hubspot',expires_in:3600}};}}),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:audit=new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
  importNow:()=>now,importBudget:()=>budget,importRequest:(...args)=>provider.request(...args),llmManager:{chat:async()=>{throw Error('No model execution');}} as any,channelService:{sendWorkflowNotification:async()=>{throw Error('No notifications');}} as any,wsService:{} as any});
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'import-metadata',projectId:DEFAULT_IDS.project});
 try{catalog=new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:IMPORT_PIECE,pieceVersion:'0.0.1'}))]);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_IMPORT_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_IMPORT_CATALOG_EXPORT,JSON.stringify(catalog.list()));}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function graph(configured=true):any{return {name:'trigger',type:'EMPTY',settings:{},nextAction:{name:'import_contacts',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input:configured?setup:Object.fromEntries([...IMPORT_REQUIRED,'sourceConnection'].map(k=>[k,k==='propertyMapping'?null:'']))}}};}
function reset(){now=Date.now();provider=importFixtureProvider();budget={ms:20_000,operations:1};authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});}
function fixture(trigger=graph()){const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Import fixture',trigger});expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');return {flow,version};}
async function begin(f:ReturnType<typeof fixture>){const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id});runIds.push(run.id);enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId:f.version.id,projectId:DEFAULT_IDS.project,triggerPayload:{}},flowId:f.flow.id,flowRunId:run.id});await worker.drain();return getFlowRun(run.id)!;}
async function finish(id:string){for(let i=0;i<80;i++){const run=getFlowRun(id)!;if(run.status!=='PAUSED')return run;const waits=listWaitpointsByFlowRun(id,false).filter(w=>w.type==='TIMER');expect(waits).toHaveLength(1);now=Math.max(now+1,Date.parse(waits[0]!.resumeDateTime!));expect(new TimerWaitpointScheduler().tick(now)).toBe(1);await worker.drain();}throw Error('Import did not finish');}
test('real engine resumes timer slices, persists checkpoints and safely replays the whole import',async()=>{
 reset();provider.options.loseWrite=true;provider.options.throttle=true;const f=fixture();const first=await begin(f);expect(first.status).toBe('PAUSED');
 closeWorkflowDb();initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});
 expect((await finish(first.id)).status).toBe('SUCCEEDED');expect(provider.creates).toBe(2);expect(provider.calls.filter(c=>c.method==='POST')).toHaveLength(2);
 const count=provider.calls.length;expect((await begin(f)).status).toBe('SUCCEEDED');expect(provider.calls).toHaveLength(count);
},120_000);
test('one approval covers the import and revocation/Authority checks still guard later slices',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);const execution=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(execution.id);
 const ctx={runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
 const pending=await services.contactImport!({...setup},ctx) as any;expect(pending.approval).toBeDefined();expect(provider.calls).toHaveLength(0);approvals.approve(pending.approval.approvalId,'fixture');
 for(let i=0;i<3;i++){const next=await services.contactImport!({...setup},ctx) as any;expect(next.approval).toBeUndefined();expect(next.waitpointId).toBeDefined();now=Math.max(now+1,next.resumeAt);}
 const n=provider.calls.length;authority.addOverride({action:'write_data',allowed:false});await expect(services.contactImport!({...setup},ctx)).rejects.toThrow();expect(provider.calls).toHaveLength(n);
},60000);

test('an interrupted write resumes in a new run without duplicating contacts',async()=>{
 reset();provider.options.crashWrite=true;const f=fixture();const first=await begin(f);expect((await finish(first.id)).status).toBe('FAILED');expect(provider.creates).toBe(1);
 closeWorkflowDb();initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});now+=46_000;
 const next=await begin(f);expect((await finish(next.id)).status).toBe('SUCCEEDED');expect(provider.creates).toBe(2);expect(provider.calls.filter(c=>c.method==='POST')).toHaveLength(2);
},120000);

test('approval stays open during timer slices and closes only after confirmed completion',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run.id);
 const ctx={runId:run.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
 const first=await services.contactImport!({...setup},ctx) as any;const id=first.approval.approvalId;approvals.approve(id,'fixture');let completed=false;
 for(let i=0;i<40;i++){const r=await services.contactImport!({...setup},ctx) as any;expect(r.approval).toBeUndefined();if(r.complete){completed=true;break;}expect(approvals.getRequest(id)?.status).toBe('approved');now=Math.max(now+1,r.resumeAt);}
 expect(completed).toBe(true);expect(approvals.getRequest(id)?.status).toBe('executed');expect(provider.creates).toBe(2);
 // Many slices, few audit rows: the approval decision, the first slice and the completion.
 expect(audit.query({agentId:`workflow:${run.id}`}).length).toBeLessThanOrEqual(3);
});

test('edited inputs and changed account bindings cannot dispatch provider requests',async()=>{
 reset();const f=fixture();pinFlowBindings(f.flow.id);const execution=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(execution.id);
 const ctx={runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
 await expect(services.contactImport!({...setup,sourceUrl:'https://other.example/api'},ctx)).rejects.toThrow('saved workflow');expect(provider.calls).toHaveLength(0);
 upsertConnection({externalId:'fixture-hubspot',displayName:'Changed',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.12.1',value:{access_token:'changed-synthetic'}});
 try{await expect(services.contactImport!({...setup},ctx)).rejects.toThrow();expect(provider.calls).toHaveLength(0);}
 finally{upsertConnection({externalId:'fixture-hubspot',displayName:'Fixture HubSpot',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.12.1',value:{access_token:'synthetic-hubspot'}});}
});
test('disabled composition saves complete graph with deferred setup and inspectable guarantees',async()=>{
 reset();let turn=0;const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async()=>turn++===0?{content:'',tool_calls:[{id:'inspect',name:'get_piece_details',arguments:{pieceName:IMPORT_PIECE}}]}:{content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Generated import draft',trigger:graph(false)}}]}}});
 const raw=await tool.execute({action:'compose',name:'Generated import draft',description:'Disabled draft: import contacts from a test API to HubSpot, next_cursor, persistent page checkpoints, Retry-After and three retries, resume without duplicates. Unknown setup remains deferred.'}) as string;expect(raw).toContain('"ok":true');
 const flow=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Generated import draft')!,draft=getLatestDraft(flow.id)!;expect(flow.status).toBe('DISABLED');expect(flow.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);
 const validation=compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues!.length).toBeGreaterThanOrEqual(IMPORT_REQUIRED.length);expect(versionReadiness(flow.id,draft.id).ready).toBe(false);expect(workflowSafeguards(draft.trigger).safeguards.map(s=>s.kind)).toContain('import-retries');
 expect(compileWorkflow(graph(false),{pieces:catalog,phase:'activation'}).ready).toBe(false);
 const oauth=graph(false);oauth.nextAction.settings.input.sourceAuth='oauth2';expect(compileWorkflow(oauth,{pieces:catalog,phase:'composition'}).ready).toBe(true);
 const almostReady=graph();almostReady.nextAction.settings.input={...setup,sourceAuth:'oauth2',sourceConnection:''};expect(compileWorkflow(almostReady,{pieces:catalog,phase:'composition'}).ready).toBe(true);
},60000);
test('actual generated Test 10 draft executes after filling setup only',async()=>{
 const path=join(import.meta.dir,'fixtures/import-generated-test10.json');if(!existsSync(path))throw Error('Capture the actual generated workflow before acceptance');
 reset();const g=JSON.parse(readFileSync(path,'utf8'));expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).ready).toBe(true);
 const flow=createFlow(),draft=createDraftVersion({flowId:flow.id,displayName:'Captured Test 10',trigger:g});expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(versionReadiness(flow.id,draft.id).ready).toBe(false);
 for(const[k,v]of Object.entries(setup))if(g.nextAction.settings.input[k]===''||g.nextAction.settings.input[k]==null)g.nextAction.settings.input[k]=v;
 updateDraftVersion(draft.id,{trigger:g});expect(versionReadiness(flow.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(flow.id,draft.id);updateFlowStatus(flow.id,'ENABLED');
 provider.options.throttle=true;provider.options.loseWrite=true;const first=await begin({flow,version:draft});expect((await finish(first.id)).status).toBe('SUCCEEDED');expect(provider.creates).toBe(2);
},120_000);

test('canceling between slices never receipts already-run import work as not started',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run.id);
 const ctx={runId:run.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
 const first=await services.contactImport!({...setup},ctx) as any;const id=first.approval.approvalId;approvals.approve(id,'fixture');
 for(let i=0;i<4;i++){const r=await services.contactImport!({...setup},ctx) as any;expect(r.complete).toBe(false);now=Math.max(now+1,r.resumeAt);}
 expect(provider.creates).toBe(1);cancelFlowRun(run.id);
 const effect=listWorkflowEffects(run.id).find(e=>e.route==='contact-import')!;
 expect((effect.outcome as {effect?:string}|undefined)?.effect).toBe('may_have_occurred');expect(effect.status).toBe('blocked');
 expect(approvals.getRequest(id)?.execution_outcome).toBe('failed');
},60000);

test('a Retry-After beyond 24 hours is a typed resumable block, not_started only when nothing ran',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);const base=provider;let far=true;
 provider={...base,request:async(p,url,method,body)=>far&&new URL(url).pathname==='/account-info/v3/details'?{status:429,retryAfter:'172800',body:null}:base.request(p,url,method,body)} as typeof provider;
 const begin1=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(begin1.id);
 const ctx={runId:begin1.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
 const first=await services.contactImport!({...setup},ctx) as any;approvals.approve(first.approval.approvalId,'fixture');
 await expect(services.contactImport!({...setup},ctx)).rejects.toThrow('more than 24 hours');
 const blocked=listWorkflowEffects(begin1.id).find(e=>e.route==='contact-import')!;
 expect(blocked.outcome).toMatchObject({status:'blocked',code:'IMPORT_RETRY_AFTER_TOO_LONG',effect:'not_started'});expect(approvals.getRequest(first.approval.approvalId)?.execution_outcome).toBe('blocked');
 far=false;now+=172_800_000;const run2=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run2.id);const ctx2={...ctx,runId:run2.id};
 const second=await services.contactImport!({...setup},ctx2) as any;approvals.approve(second.approval.approvalId,'fixture');
 for(let i=0;i<4;i++){const r=await services.contactImport!({...setup},ctx2) as any;now=Math.max(now+1,r.resumeAt);}
 expect(base.creates).toBe(1);provider={...base,request:async()=>({status:429,retryAfter:'172800',body:null})} as typeof provider;
 let stop:unknown;for(let i=0;i<3&&!stop;i++){try{const r=await services.contactImport!({...setup},ctx2) as any;now=Math.max(now+1,r.resumeAt);}catch(e){stop=e;}}
 expect(String(stop)).toContain('more than 24 hours');
 expect(listWorkflowEffects(run2.id).find(e=>e.route==='contact-import')!.outcome).toMatchObject({code:'IMPORT_RETRY_AFTER_TOO_LONG',effect:'may_have_occurred'});
 expect(approvals.getRequest(second.approval.approvalId)?.execution_outcome).toBe('failed');
 provider=base;now+=172_800_000;const run3=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run3.id);const ctx3={...ctx,runId:run3.id};
 const third=await services.contactImport!({...setup},ctx3) as any;approvals.approve(third.approval.approvalId,'fixture');
 for(let i=0;i<40;i++){const r=await services.contactImport!({...setup},ctx3) as any;if(r.complete)break;now=Math.max(now+1,r.resumeAt);}
 expect(base.creates).toBe(2);expect(approvals.getRequest(third.approval.approvalId)?.status).toBe('executed');
},60000);
test('a slice that dies mid-dispatch still counts as run, so a later typed stop is not receipted as not started',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);const base=provider;
 const ctxFor=(runId:string)=>({runId,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>});
 // Run 1 reaches the first create and is canceled between slices, so run 2 starts with that create.
 const run1=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run1.id);
 const a=await services.contactImport!({...setup},ctxFor(run1.id)) as any;approvals.approve(a.approval.approvalId,'fixture');
 for(let i=0;i<3;i++){const r=await services.contactImport!({...setup},ctxFor(run1.id)) as any;now=Math.max(now+1,r.resumeAt);}
 expect(base.creates).toBe(0);expect(base.calls.at(-1)?.method).toBe('GET');cancelFlowRun(run1.id);
 // Run 2's first slice commits the create, then the worker dies: the call never returns.
 let reached!:()=>void;const committed=new Promise<void>(r=>{reached=r;});
 provider={...base,request:async(p,url,method,body)=>{if(method==='POST'){await base.request(p,url,method,body);reached();return new Promise(()=>{});}return base.request(p,url,method,body);}} as typeof provider;
 const run2=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run2.id);
 const b=await services.contactImport!({...setup},ctxFor(run2.id)) as any;approvals.approve(b.approval.approvalId,'fixture');
 void services.contactImport!({...setup},ctxFor(run2.id));await committed;expect(base.creates).toBe(1);
 expect(listWorkflowEffects(run2.id).find(e=>e.route==='contact-import')!.status).toBe('dispatching');
 // The lease expires; the next slice reconciles by GET and is told to wait two days.
 now+=46_000;provider={...base,request:async()=>({status:429,retryAfter:'172800',body:null})} as typeof provider;
 await expect(services.contactImport!({...setup},ctxFor(run2.id))).rejects.toThrow('more than 24 hours');
 const effect=listWorkflowEffects(run2.id).find(e=>e.route==='contact-import')!;
 expect(effect.outcome).toMatchObject({code:'IMPORT_RETRY_AFTER_TOO_LONG',effect:'may_have_occurred'});
 expect(approvals.getRequest(b.approval.approvalId)?.execution_outcome).toBe('failed');
 provider=base;
},60000);
test('an overlapping run on the same import is refused as not started while the owner run is live',async()=>{
 reset();const f=fixture();authority.setGovernedCategories(['write_data']);
 const ctxFor=(runId:string)=>({runId,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>});
 const runA=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'}),runB=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(runA.id,runB.id);
 const a=await services.contactImport!({...setup},ctxFor(runA.id)) as any;approvals.approve(a.approval.approvalId,'fixture');
 const r=await services.contactImport!({...setup},ctxFor(runA.id)) as any;now=Math.max(now+1,r.resumeAt);
 const b=await services.contactImport!({...setup},ctxFor(runB.id)) as any;approvals.approve(b.approval.approvalId,'fixture');const n=provider.calls.length;
 await expect(services.contactImport!({...setup},ctxFor(runB.id))).rejects.toThrow('in use by another run');expect(provider.calls).toHaveLength(n);
 expect(listWorkflowEffects(runB.id).find(e=>e.route==='contact-import')!.outcome).toMatchObject({code:'IMPORT_RUN_ACTIVE',effect:'not_started'});
 expect(approvals.getRequest(b.approval.approvalId)?.execution_outcome).toBe('blocked');
 for(let i=0;i<40;i++){const next=await services.contactImport!({...setup},ctxFor(runA.id)) as any;if(next.complete)break;now=Math.max(now+1,next.resumeAt);}
 expect(provider.creates).toBe(2);expect(approvals.getRequest(a.approval.approvalId)?.status).toBe('executed');
},60000);

const hubspotRow=(value:Record<string,unknown>)=>upsertConnection({externalId:'fixture-hubspot',displayName:'Fixture HubSpot',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.12.1',value});
/** A locked version whose saved import step is `node`, never published (readiness would refuse it), and a running execution of it. */
function direct(node:any){
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Direct import',trigger:{...graph(),nextAction:node}});lockVersion(version.id);
 const execution=createFlowRun({flowId:flow.id,flowVersionId:version.id,status:'RUNNING'});runIds.push(execution.id);
 return {runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};
}
test('readiness refuses a Jarvis-managed id for each import account and the short piece name',()=>{
 for(const field of ['hubspotConnection','sourceConnection']) for(const phase of ['composition','activation'] as const){
  const g=graph();g.nextAction.settings.input={...setup,sourceAuth:'oauth2',sourceConnection:'fixture-source',[field]:'jarvis:google'};
  const issues=compileWorkflow(g,{pieces:catalog,phase,connection:()=>null} as any).issues;
  expect(issues.some((i:any)=>i.code==='CONNECTION_BINDING'&&i.path===`settings.input.${field}`&&String(i.message).includes('Jarvis-managed'))).toBe(true);
 }
 // An anonymous source names no source account, whatever the field holds.
 const anonymous=graph();anonymous.nextAction.settings.input={...setup,sourceConnection:'jarvis:google'};
 expect(compileWorkflow(anonymous,{pieces:catalog,phase:'composition'}).issues.some((i:any)=>i.code==='CONNECTION_BINDING')).toBe(false);
 expect(compileWorkflow(graph(),{pieces:catalog,phase:'composition'}).issues.some((i:any)=>i.code==='CONNECTION_BINDING')).toBe(false);
 const short=graph();short.nextAction.settings.pieceName='jarvis-import';
 expect(compileWorkflow(short,{pieces:catalog,phase:'composition'}).issues.some((i:any)=>i.code==='PIECE'&&i.path==='settings.pieceName'&&String(i.message).includes(`Use the full piece name ${IMPORT_PIECE}`))).toBe(true);
});
test('the import step binds its source account only for an OAuth2 source',()=>{
 const node=(input:any)=>({name:'import_contacts',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input}}) as any;
 expect(nodeConnectionReferences(node({...setup,sourceConnection:'fixture-source'}))).toEqual([['fixture-hubspot','settings.input.hubspotConnection']]);
 expect(nodeConnectionReferences(node({...setup,sourceAuth:'oauth2',sourceConnection:'fixture-source'}))).toEqual([['fixture-hubspot','settings.input.hubspotConnection'],['fixture-source','settings.input.sourceConnection']]);
});
test('the import backend refuses a Jarvis-managed account at run time, with no exemption, before resolving anything',async()=>{
 reset();
 resolver.register({id:'google',pieceNames:['@activepieces/piece-hubspot','@activepieces/piece-http-oauth2'],canResolve:(ext:string)=>ext==='jarvis:google',resolve:async()=>{throw Error('a managed account must not be resolved');}} as any);
 try {
  for(const [field,label] of [['hubspotConnection','HubSpot'],['sourceConnection','Source API']] as const){
   const input={...setup,sourceAuth:'oauth2',sourceConnection:'fixture-source',[field]:'jarvis:google'};
   const ctx=direct({name:'import_contacts',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input}});
   await expect(services.contactImport!(input,ctx)).rejects.toThrow(`Select a saved ${label} account; a Jarvis-managed connection cannot be used by the contact import`);
  }
  expect(provider.calls).toHaveLength(0);
 } finally {resolver.unregister('google');}
},60000);
test('the import backend refuses a saved step that is not a PIECE action node',async()=>{
 reset();
 for(const node of [{name:'import_contacts',type:'CODE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input:setup}},
  {name:'import_contacts',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,triggerName:'x',input:setup}}]){
  await expect(services.contactImport!({...setup},direct(node))).rejects.toThrow('Import configuration must match a saved contact import step');
 }
 expect(provider.calls).toHaveLength(0);
},60000);
test('an expired HubSpot token that cannot be refreshed fails with a reconnect message, before any provider call',async()=>{
 hubspotRow({access_token:'synthetic-hubspot',claimed_at:Math.floor(Date.now()/1000)-7200,expires_in:3600});
 try {
  reset();const f=fixture(),ctx={runId:createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'}).id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};runIds.push(ctx.runId);
  await expect(services.contactImport!({...setup},ctx)).rejects.toThrow('Reconnect the selected HubSpot account (fixture-hubspot)');
  expect(listRunConnectionBindings(ctx.runId).find(b=>b.externalId==='fixture-hubspot')?.credentialFailure?.code).toBe('CONNECTION_EXPIRED');
  expect(provider.calls).toHaveLength(0);
 } finally {hubspotRow({access_token:'synthetic-hubspot'});}
},60000);
test('a HubSpot token whose refresh cannot reach the provider fails as temporary, not as reconnect',async()=>{
 hubspotRow({access_token:'synthetic-hubspot',refresh_token:'refresh',client_id:'client',client_secret:'secret',token_url:'https://oauth2.example.test/token',claimed_at:Math.floor(Date.now()/1000)-7200,expires_in:3600});
 tokenDown=true;
 try {
  reset();const f=fixture(),ctx={runId:createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'}).id,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>};runIds.push(ctx.runId);
  const error=await services.contactImport!({...setup},ctx).then(()=>null,e=>e as Error);
  expect(String(error?.message)).toContain('which is usually temporary. Start a new run later to resume from the checkpoint.');expect(String(error?.message)).not.toContain('Reconnect');
  expect(listRunConnectionBindings(ctx.runId).find(b=>b.externalId==='fixture-hubspot')?.credentialFailure?.code).toBe('CONNECTION_REFRESH_UNREACHABLE');
  expect(provider.calls).toHaveLength(0);
 } finally {tokenDown=false;hubspotRow({access_token:'synthetic-hubspot'});}
},60000);

const ctxOf=(runId:string)=>({runId,projectId:DEFAULT_IDS.project,stepName:'import_contacts',executionPath:[] as Array<[string,number]>});
const newRun=(f:ReturnType<typeof fixture>)=>{const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run.id);return run.id;};
test('a reconnect keeps the checkpoint: the portal is verified again and done contacts are not written again; another portal is refused',async()=>{
 reset();const f=fixture();const a=newRun(f);
 for(let i=0;i<40&&provider.creates<1;i++){const r=await services.contactImport!({...setup},ctxOf(a)) as any;now=Math.max(now+1,r.resumeAt);}
 expect(provider.creates).toBe(1);const accountChecks=()=>provider.calls.filter(c=>c.url.includes('account-info')).length;expect(accountChecks()).toBe(1);
 updateRun(a,{status:'FAILED'});
 // The token expires; a new run is told to reconnect, and the person reconnects (a new credential generation).
 // Each credential change is accepted by enabling the workflow again, which re-pins its bindings.
 hubspotRow({access_token:'synthetic-hubspot',claimed_at:Math.floor(Date.now()/1000)-7200,expires_in:3600});pinFlowBindings(f.flow.id);
 const expired=newRun(f);
 try{await expect(services.contactImport!({...setup},ctxOf(expired))).rejects.toThrow('Reconnect the selected HubSpot account');}
 finally{hubspotRow({access_token:'reconnected-hubspot'});pinFlowBindings(f.flow.id);updateRun(expired,{status:'FAILED'});}
 const b=newRun(f);budget={ms:20_000,operations:Infinity};const done=await services.contactImport!({...setup},ctxOf(b)) as any;
 expect(done.complete).toBe(true);expect(accountChecks()).toBe(2);expect(provider.creates).toBe(2);expect(provider.calls.filter(c=>c.method==='POST')).toHaveLength(2);
 // The same import reconnected to a different HubSpot portal stops before reading or writing anything else.
 reset();const g=fixture(graph());const c=newRun(g);
 for(let i=0;i<40&&provider.creates<1;i++){const r=await services.contactImport!({...setup},ctxOf(c)) as any;now=Math.max(now+1,r.resumeAt);}
 updateRun(c,{status:'FAILED'});hubspotRow({access_token:'another-portal'});pinFlowBindings(g.flow.id);
 const base=provider;provider={...base,request:async(p,url,method,body)=>new URL(url).pathname==='/account-info/v3/details'?{status:200,body:{portalId:43}}:base.request(p,url,method,body)} as typeof provider;
 try{const n=base.calls.length;await expect(services.contactImport!({...setup},ctxOf(newRun(g)))).rejects.toThrow('portal verification failed');expect(base.calls).toHaveLength(n);}
 finally{provider=base;hubspotRow({access_token:'synthetic-hubspot'});}
},60000);
test('a run that ended between slices reads as unknown in recovery and as dispatched to the failure card',async()=>{
 reset();provider.options.throttle=true;const f=fixture();const run=newRun(f);
 for(let i=0;i<2;i++){const r=await services.contactImport!({...setup},ctxOf(run)) as any;expect(r.complete).toBe(false);}
 const effect=listWorkflowEffects(run).find(e=>e.route==='contact-import')!;expect(effect.status).toBe('pending');expect(effect.partial).toBeDefined();
 updateRun(run,{status:'FAILED'});
 expect(getRunRecovery(run)!.effects.find(e=>e.effectId===effect.id)!.status).toBe('unknown');
 expect(otherSteps(getFlowRun(run)!,[effect],walkFlowNodes(f.version.trigger))).toBe('yes');
},60000);
test('the real timer scheduler finishes a multi-contact page in one call, with audit rows that do not grow per operation',async()=>{
 reset();budget={ms:20_000,operations:Infinity};
 const contacts=new Map<string,any>(),calls:string[]=[];let creates=0;
 const request:ImportRequest=async(p,url,method,body:any)=>{
  calls.push(method+' '+p);const u=new URL(url);
  if(u.pathname==='/account-info/v3/details')return {status:200,body:{portalId:42}};
  if(p==='source')return {status:200,body:{items:Array.from({length:25},(_,i)=>({id:String(i),email:`c${i}@example.com`,name:'N'+i})),next_cursor:null}};
  const email=method==='POST'?body.properties.email:decodeURIComponent(u.pathname.split('/').at(-1)!);
  if(method==='GET')return contacts.has(email)?{status:200,body:contacts.get(email)}:{status:404,body:{}};
  const contact={id:String(++creates),properties:{...body.properties,email}};contacts.set(email,contact);return {status:200,body:contact};
 };
 provider={...provider,request} as typeof provider;
 const f=fixture(),run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id});runIds.push(run.id);
 const scheduler=new TimerWaitpointScheduler(25);scheduler.start();worker.start();
 try{
  enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId:f.version.id,projectId:DEFAULT_IDS.project,triggerPayload:{}},flowId:f.flow.id,flowRunId:run.id});
  for(let i=0;i<400&&!['SUCCEEDED','FAILED','INTERNAL_ERROR','STOPPED'].includes(getFlowRun(run.id)!.status);i++)await Bun.sleep(50);
 }finally{scheduler.stop();await worker.stop();}
 expect(getFlowRun(run.id)!.status).toBe('SUCCEEDED');expect(creates).toBe(25);expect(calls.filter(c=>c.startsWith('POST'))).toHaveLength(25);
 expect(listWaitpointsByFlowRun(run.id).filter(w=>w.type==='TIMER').length).toBeLessThanOrEqual(1);
 // 52 provider operations; one audit row when the import first runs and one when it completes, at most.
 expect(audit.query({agentId:`workflow:${run.id}`}).length).toBeLessThanOrEqual(2);
},60000);

test('a stop later in the same call is not receipted as not started: earlier requests of the call ran',async()=>{
 reset();budget={ms:20_000,operations:Infinity};const f=fixture(),run=newRun(f),base=provider;
 provider={...base,request:async(p,url,method,body)=>p==='source'&&new URL(url).searchParams.get('cursor')==='page2'?{status:429,retryAfter:'172800',body:null}:base.request(p,url,method,body)} as typeof provider;
 try{await expect(services.contactImport!({...setup},ctxOf(run))).rejects.toThrow('more than 24 hours');}finally{provider=base;}
 expect(base.creates).toBe(1);
 expect(listWorkflowEffects(run).find(e=>e.route==='contact-import')!.outcome).toMatchObject({code:'IMPORT_RETRY_AFTER_TOO_LONG',effect:'may_have_occurred'});
},60000);
