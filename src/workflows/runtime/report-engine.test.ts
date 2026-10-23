import {REPORT_ACTION,REPORT_PIECE,REPORT_REQUIRED} from './weekly-report';
import {reportFixtureSetup,reportFixtureNow,reportFixtureRequest,type ReportFixtureOptions} from './report-fixtures';
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

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const versions:Record<string,string>={},runIds:string[]=[];
let now=reportFixtureNow;
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'jarvis-report-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));
  const bundle=await buildEngineBundle();
  for(const name of ['report']) {
    const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis',name);await buildPiece(path);
    const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versions[meta.name]=meta.version;
    const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
  }
  for(const name of ['stripe','hubspot','google'])upsertConnection({externalId:'fixture-'+name,displayName:'Fixture',type:name==='stripe'?'SECRET_TEXT':'OAUTH2',pieceName:'@activepieces/piece-'+(name==='google'?'google-docs':name),pieceVersion:'0.0.1',value:name==='stripe'?{secret_text:'synthetic-'+name}:{access_token:'synthetic-'+name}});
  authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
  approvals=new ApprovalManager();
  services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
    reportNow:()=>now,reportFetch:(async(url:any,init:any)=>{
      const u=new URL(String(url)),provider=u.hostname==='api.stripe.com'?'stripe':u.hostname==='api.hubapi.com'?'hubspot':'google';
      expect(['api.stripe.com','api.hubapi.com','www.googleapis.com','docs.googleapis.com']).toContain(u.hostname);expect(init.headers.Authorization).toBe('Bearer synthetic-'+provider);expect(init.redirect).toBe('error');
      return Response.json(await request(provider,u.pathname+u.search,init.body?JSON.parse(init.body):undefined));
    }) as typeof fetch,llmManager:{chat:async()=>{throw Error('No model tools or delegate may execute');}} as any,
    channelService:{sendWorkflowNotification:async()=>{throw Error('No external notifications');}} as any,wsService:{broadcastNotificationToDashboard:()=>{throw Error('Report must not send notifications');}} as any});
  api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
  const handle=await runtime.acquire({runId:'report-metadata',projectId:DEFAULT_IDS.project});
  try {const entries=[];for(const[pieceName,pieceVersion]of Object.entries(versions))entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName,pieceVersion})));catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_REPORT_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_REPORT_CATALOG_EXPORT,JSON.stringify(entries));}
  finally{await handle.release();}
  worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});

let request=reportFixtureRequest();
const setup={...reportFixtureSetup,dealStageIds:'won'};
const missing=Object.fromEntries(REPORT_REQUIRED.map(k=>[k,'']));
function graph(configured=true):any{return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'schedule',input:{cron_expression:configured?'0 9 * * 1':'',timezone:'Europe/Rome'}},nextAction:{name:'report',type:'PIECE',settings:{pieceName:REPORT_PIECE,actionName:REPORT_ACTION,input:configured?setup:{...missing,timezone:'Europe/Rome'}}}};}
async function run(flowId:string,flowVersionId:string){const run=createFlowRun({flowId,flowVersionId});runIds.push(run.id);enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId,projectId:DEFAULT_IDS.project,triggerPayload:{}},flowId,flowRunId:run.id});await worker.drain();return getFlowRun(run.id)!;}
function reset(options:ReportFixtureOptions={}){now=reportFixtureNow;authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});request=reportFixtureRequest(options);}
function fixture(){const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Report fixture',trigger:graph()});expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');return {flow,version,run:()=>run(flow.id,version.id)};}
test('real engine creates verified report across all pages and receipts survive DB reopen',async()=>{
 const writes:any[]=[];reset({writes});const f=fixture();expect((await f.run()).status).toBe('SUCCEEDED');expect(writes).toHaveLength(2);expect(JSON.stringify(writes)).toContain('123.456789');
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));configureWorkflowReadiness({pieces:catalog});expect((await f.run()).status).toBe('SUCCEEDED');expect(writes).toHaveLength(2);
},60000);
test('source errors yield explicit unavailable report, not bogus totals',async()=>{const writes:any[]=[];reset({writes,failStripe:true});const f=fixture();expect((await f.run()).status).toBe('SUCCEEDED');expect(JSON.stringify(writes)).toContain('Unavailable');expect(JSON.stringify(writes)).toContain('123.456789');},60000);
test('unknown create and incorrect verification fail, with no repeated writes',async()=>{for(const option of [{unknownCreate:true},{badContent:true}]){const writes:any[]=[];reset({...option,writes});const f=fixture();expect((await f.run()).status).toBe('FAILED');const n=writes.length;expect((await f.run()).status).toBe('FAILED');expect(writes).toHaveLength(n);}},60000);
test('authority denial and changed pinned account stop before provider access',async()=>{
 const calls:string[]=[];reset({calls});let f=fixture();authority.addOverride({action:'write_data',allowed:false});expect((await f.run()).status).toBe('FAILED');expect(calls).toHaveLength(0);
 reset({calls});f=fixture();pinFlowBindings(f.flow.id);upsertConnection({externalId:'fixture-google',displayName:'Changed',type:'OAUTH2',pieceName:'@activepieces/piece-google-docs',pieceVersion:'0.0.1',value:{access_token:'changed'}});
 try{expect((await f.run()).status).toBe('FAILED');expect(calls).toHaveLength(0);}finally{upsertConnection({externalId:'fixture-google',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-google-docs',pieceVersion:'0.0.1',value:{access_token:'synthetic-google'}});}
},60000);
test('approval precedes source reads and document creation',async()=>{
 const calls:string[]=[],writes:any[]=[];reset({calls,writes});const f=fixture();authority.setGovernedCategories(['write_data']);const execution=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(execution.id);
 const ctx={runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'report',executionPath:[] as Array<[string,number]>};const pending=await services.weeklyReport!({...setup},ctx) as any;expect(pending.approval).toBeDefined();expect(calls).toHaveLength(0);approvals.approve(pending.approval.approvalId,'fixture');const result=await services.weeklyReport!({...setup},ctx) as any;expect(result.documentId).toBe('doc1');expect(writes).toHaveLength(2);
},60000);
test('disabled draft exposes all setup fields and reporting safeguards',async()=>{
 reset();let turn=0;const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async()=>turn++===0?{content:'',tool_calls:[{id:'inspect',name:'get_piece_details',arguments:{pieceName:REPORT_PIECE}}]}:{content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Generated report draft',trigger:graph(false)}}]}}});
 const raw=await tool.execute({action:'compose',name:'Generated report draft',description:'Every Monday combine previous complete week Stripe payments/refunds and HubSpot deals into a Google Doc. All pages, separate currencies, prior week comparison, zero denominators, unavailable sources. Disabled with setup required.',contract:{trigger:{kind:'schedule',timezone:'Europe/Rome'}}}) as string;expect(raw).toContain('"ok":true');
 const saved=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Generated report draft')!,draft=getLatestDraft(saved.id)!;expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();expect(listRuns({flowId:saved.id})).toHaveLength(0);
 const validation=compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues).toHaveLength(REPORT_REQUIRED.length+1);expect(versionReadiness(saved.id,draft.id).ready).toBe(false);
 let cursor:string|undefined,text='';do{const result=await tool.execute({action:'get',flow:saved.id,version_id:draft.id,view:'validation',...(cursor?{cursor}:{})}) as string;const page=JSON.parse(result.split('\n').slice(2,-1).join('\n'));text+=page.content;cursor=page.nextCursor;}while(cursor);expect(JSON.parse(text).runtimeSafeguards.safeguards.some((s:any)=>s.kind==='weekly-calculations')).toBe(true);
},60000);

// Exact graph produced by the configured model through the production composer.
// Only deferred setup values are filled; no action/edge/expression changes.
test('actual model-generated saved Test 9 graph executes with complete and unavailable fixture sources',async()=>{
 const g=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/report-generated-test9.json'),'utf8'));
 expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).setupIssues).toHaveLength(REPORT_REQUIRED.length+1);
 const flow=createFlow(),draft=createDraftVersion({flowId:flow.id,displayName:'Captured Test 9 graph',trigger:g});
 expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(getFlow(flow.id)?.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);expect(versionReadiness(flow.id,draft.id).ready).toBe(false);
 g.settings.input.cron_expression='0 9 * * 1';for(const[k,v]of Object.entries(setup))if(g.nextAction.settings.input[k]===''||g.nextAction.settings.input[k]===null)g.nextAction.settings.input[k]=v;
 updateDraftVersion(draft.id,{trigger:g});expect(versionReadiness(flow.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(flow.id,draft.id);updateFlowStatus(flow.id,'ENABLED');
 const writes:any[]=[];reset({writes,overlap:true});expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(writes).toHaveLength(2);expect(JSON.stringify(writes)).toContain('123.456789');expect(JSON.stringify(writes)).toContain('JPY');
 expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(writes).toHaveLength(2);
 const another=createFlow(),version=createDraftVersion({flowId:another.id,displayName:'Same model graph; source failure',trigger:g});lockVersion(version.id);setPublishedVersion(another.id,version.id);updateFlowStatus(another.id,'ENABLED');
 reset({writes,failStripe:true});expect((await run(another.id,version.id)).status).toBe('SUCCEEDED');expect(writes).toHaveLength(4);expect(JSON.stringify(writes.at(-1))).toContain('Unavailable');
},60000);
