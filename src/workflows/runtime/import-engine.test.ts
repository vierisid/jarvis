import {afterAll,beforeAll,expect,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initWorkflowDb,closeWorkflowDb,DEFAULT_IDS} from '../db';
import {setEncryptionKey} from '../db/encryption';
import {createFlow,getFlow,setPublishedVersion,updateFlowStatus,listFlows} from '../db/repos/flow';
import {createDraftVersion,getLatestDraft,lockVersion,updateDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun,listRuns} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {listWaitpointsByFlowRun} from '../db/repos/waitpoint';
import {upsertConnection} from '../db/repos/app-connection';
import {pinFlowBindings} from '../db/repos/binding-pins';
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
let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>,now=Date.now(),provider=importFixtureProvider();
const runIds:string[]=[];
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-import-engine-'));initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));
 const bundle=await buildEngineBundle();const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/import');await buildPiece(path);
 const installed=join(dir,'node_modules',IMPORT_PIECE);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 upsertConnection({externalId:'fixture-hubspot',displayName:'Fixture HubSpot',type:'OAUTH2',pieceName:'@activepieces/piece-hubspot',pieceVersion:'0.12.1',value:{access_token:'synthetic-hubspot'}});
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
  importNow:()=>now,importRequest:(...args)=>provider.request(...args),llmManager:{chat:async()=>{throw Error('No model execution');}} as any,channelService:{sendWorkflowNotification:async()=>{throw Error('No notifications');}} as any,wsService:{} as any});
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'import-metadata',projectId:DEFAULT_IDS.project});
 try{catalog=new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:IMPORT_PIECE,pieceVersion:'0.0.1'}))]);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_IMPORT_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_IMPORT_CATALOG_EXPORT,JSON.stringify(catalog.list()));}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function graph(configured=true):any{return {name:'trigger',type:'EMPTY',settings:{},nextAction:{name:'import_contacts',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input:configured?setup:Object.fromEntries([...IMPORT_REQUIRED,'sourceConnection'].map(k=>[k,k==='propertyMapping'?null:'']))}}};}
function reset(){now=Date.now();provider=importFixtureProvider();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});}
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
