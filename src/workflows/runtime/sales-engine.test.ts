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
import {listRunConnectionBindings,pinFlowBindings} from '../db/repos/binding-pins';
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
import {salesFixtureNow,salesFixtureSetup,salesFixtureDeal,salesFixtureRequest,type SalesFixtureOptions} from './sales-fixtures';
import {SALES_PIECE,SALES_ACTION} from './sales-followups';
import {MANAGED_HUBSPOT_REFUSAL} from '../meeting-accounts';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const versions:Record<string,string>={},drafts:any[]=[],notifications:string[]=[],calls:string[]=[],runIds:string[]=[];
let deals=[salesFixtureDeal()],options:SalesFixtureOptions={},now=salesFixtureNow;
let resolver:CredentialResolver;const resolvedIds:string[]=[];
class RecordingResolver extends CredentialResolver { override async resolve(input:Parameters<CredentialResolver['resolve']>[0]){resolvedIds.push(input.externalId);return super.resolve(input);} }
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'jarvis-sales-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));
  const bundle=await buildEngineBundle();
  for(const name of ['sales','notify']) {
    const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis',name);await buildPiece(path);
    const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versions[meta.name]=meta.version;
    const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
  }
  for(const name of ['gmail','hubspot'])upsertConnection({externalId:'fixture-'+name,displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-'+name,pieceVersion:'0.0.1',value:{access_token:'synthetic-'+name}});
  authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
  approvals=new ApprovalManager();
  services=buildSandboxServiceBackends({credentialResolver:resolver=new RecordingResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
    salesNow:()=>now,salesFetch:(async(url:any,init:any)=>{
      const u=new URL(String(url)),provider=u.hostname==='gmail.googleapis.com'?'gmail':'hubspot';
      expect(['gmail.googleapis.com','api.hubapi.com']).toContain(u.hostname);expect(init.headers.Authorization).toBe('Bearer synthetic-'+provider);expect(init.redirect).toBe('error');
      expect(init.method).toBe(['/gmail/v1/users/me/drafts','/crm/v3/objects/deals/search'].includes(u.pathname)?'POST':'GET');
      return Response.json(await salesFixtureRequest(deals,{...options,drafts,calls})(provider,u.pathname+u.search,init.body?JSON.parse(init.body):undefined));
    }) as typeof fetch,llmManager:{chat:async()=>{throw Error('No model tools or delegate may execute');}} as any,
    channelService:{sendWorkflowNotification:async()=>{throw Error('No external notifications');}} as any,wsService:{broadcastNotificationToDashboard:(text:string)=>{notifications.push(text);return 1;}} as any});
  api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
  const handle=await runtime.acquire({runId:'sales-metadata',projectId:DEFAULT_IDS.project});
  try {const entries=[];for(const[pieceName,pieceVersion]of Object.entries(versions))entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName,pieceVersion})));catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_SALES_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_SALES_CATALOG_EXPORT,JSON.stringify(entries));}
  finally{await handle.release();}
  worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
const setup={...salesFixtureSetup,openStageIds:'open'};
const missing={crmProvider:'',hubspotConnection:'',gmailConnection:'',ownerEmail:'',senderName:'',openStageIds:'',inactivityProperty:'',replyLookbackDays:null,inactivityDays:7,timezone:'Europe/Rome'};
function graph(configured=true,override:Record<string,unknown>={}):any {
  return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'schedule',input:{cron_expression:configured?'0 9 * * 1-5':'',timezone:'Europe/Rome'}},nextAction:{name:'prepare',type:'PIECE',settings:{pieceName:SALES_PIECE,actionName:SALES_ACTION,input:configured?{...setup,...override}:missing},nextAction:{name:'notify',type:'PIECE',settings:{pieceName:'@jarvispieces/piece-jarvis-notify',actionName:'notify',input:{message:'{{prepare.summary}}',idempotencyKey:'{{prepare.notificationKey}}',channels:['dashboard']}}}}};
}
async function run(flowId:string,flowVersionId:string){
  const run=createFlowRun({flowId,flowVersionId});runIds.push(run.id);enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId,projectId:DEFAULT_IDS.project,triggerPayload:{}},flowId,flowRunId:run.id});await worker.drain();return getFlowRun(run.id)!;
}
async function fixture(override:Record<string,unknown>={}){
  deals=[salesFixtureDeal()];options={};now=salesFixtureNow;authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
  const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Sales fixture',trigger:graph(true,override)});
  expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');
  return {flow,version,run:()=>run(flow.id,version.id)};
}
test('engine drafts eligible deals, isolates a failure, skips reply and emits one summary',async()=>{
  const f=await fixture();deals=[salesFixtureDeal(),salesFixtureDeal(2),salesFixtureDeal(3)];options={failContact:'1',replied:['person2@example.net'],pageTwoReply:true};const before=[drafts.length,notifications.length];
  expect((await f.run()).status).toBe('SUCCEEDED');expect(drafts.length).toBe(before[0]!+1);expect(notifications.length).toBe(before[1]!+1);expect(notifications.at(-1)).toContain('1 need review');expect(notifications.at(-1)).toContain('1 skipped for replies');
},60_000);
test('engine retries, concurrent runs and database reopen do not repeat daily drafts',async()=>{
  const f=await fixture(),n=drafts.length;expect((await f.run()).status).toBe('SUCCEEDED');
  expect((await Promise.all([f.run(),f.run()])).every(r=>r.status==='SUCCEEDED')).toBe(true);expect(drafts.length).toBe(n+1);
  closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,78));configureWorkflowReadiness({pieces:catalog});
  expect((await f.run()).status).toBe('SUCCEEDED');expect(drafts.length).toBe(n+1);
},60_000);
test('engine uncertain draft is reported and subsequent attempts remain fenced',async()=>{
  const f=await fixture(),n=drafts.length;options={unknownDraft:true};expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.at(-1)).toContain('1 uncertain');
  options={};expect((await f.run()).status).toBe('SUCCEEDED');expect(drafts.length).toBe(n+1);expect(notifications.at(-1)).toContain('Earlier claim is unresolved');
},60_000);
test('new Rome date permits one new draft; weekend performs no source access',async()=>{
  const f=await fixture(),n=drafts.length;await f.run();now=Date.parse('2026-10-24T09:00:00Z');const before=calls.length;await f.run();expect(calls.length).toBe(before);
  now=Date.parse('2026-10-26T09:00:00Z');expect((await f.run()).status).toBe('SUCCEEDED');expect(drafts.length).toBe(n+2);
},60_000);
test('composition saves complete disabled graph with unknown schedule and account setup',async()=>{
  await fixture();let turn=0;const before=[calls.length,drafts.length,notifications.length];
  const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async()=>turn++===0?{content:'',tool_calls:[{id:'inspect',name:'get_piece_details',arguments:{pieceName:SALES_PIECE}}]}:{content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Generated sales draft',trigger:graph(false)}}]}}});
  const raw=await tool.execute({action:'compose',name:'Generated sales draft',description:'Each weekday, find open deals inactive seven days. Check Gmail replies, skip replies and already processed today. Create personalized drafts, one dashboard summary, never send drafts, continue per-deal failures. Disabled draft with missing setup.',contract:{trigger:{kind:'schedule',timezone:'Europe/Rome'},forbidden:{effects:['send_email']}}}) as string;
  expect(raw).toContain('"ok":true');const saved=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Generated sales draft')!,draft=getLatestDraft(saved.id)!;
  expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();expect(listRuns({flowId:saved.id})).toHaveLength(0);expect([calls.length,drafts.length,notifications.length]).toEqual(before);
  const validation=compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues?.some(i=>i.path.endsWith('cron_expression'))).toBe(true);expect(versionReadiness(saved.id,draft.id).ready).toBe(false);
  let cursor:string|undefined,text='';do{const result=await tool.execute({action:'get',flow:saved.id,version_id:draft.id,view:'validation',...(cursor?{cursor}:{})}) as string;const page=JSON.parse(result.split('\n').slice(2,-1).join('\n'));text+=page.content;cursor=page.nextCursor;}while(cursor);
  expect(JSON.parse(text).runtimeSafeguards.safeguards.some((s:any)=>s.kind==='sales-daily-identity')).toBe(true);
  const filled=structuredClone(draft.trigger);filled.settings!.input!.cron_expression='0 9 * * 1-5';filled.nextAction!.settings!.input={...setup};updateDraftVersion(draft.id,{trigger:filled});
  expect(versionReadiness(saved.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(saved.id,draft.id);updateFlowStatus(saved.id,'ENABLED');expect((await run(saved.id,draft.id)).status).toBe('SUCCEEDED');
},60_000);
test('read or write authority denial prevents all provider calls',async()=>{
  for(const category of ['read_data','write_data'] as const){const f=await fixture(),before=calls.length;authority.addOverride({action:category,allowed:false});expect((await f.run()).status).toBe('FAILED');expect(calls.length).toBe(before);}
},60_000);
test('account replacement stops pinned workflow before reads or writes',async()=>{
  const f=await fixture();pinFlowBindings(f.flow.id);const before=calls.length;
  upsertConnection({externalId:'fixture-gmail',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-gmail',pieceVersion:'0.0.1',value:{access_token:'changed'}});
  try{expect((await f.run()).status).toBe('FAILED');expect(calls.length).toBe(before);}
  finally{upsertConnection({externalId:'fixture-gmail',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-gmail',pieceVersion:'0.0.1',value:{access_token:'synthetic-gmail'}});}
},60_000);
test('approval is requested before business reads; approved execution uses fresh data',async()=>{
  const f=await fixture(),before=[calls.length,drafts.length];authority.setGovernedCategories(['write_data']);
  const execution=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(execution.id);
  const ctx={runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'prepare',executionPath:[] as Array<[string,number]>};
  const pending=await services.salesFollowups!({...setup},ctx) as any;expect(pending.approval).toBeDefined();expect([calls.length,drafts.length]).toEqual(before);
  approvals.approve(pending.approval.approvalId,'fixture');options={replied:['person1@example.net']};
  const result=await services.salesFollowups!({...setup},ctx) as any;expect(result.counts.replied).toBe(1);expect(drafts.length).toBe(before[1]!);
},60_000);

// Captured through the production composer using the configured model, in isolated storage.
// Fill only the nine deferred settings. Do not rewrite actions, expressions or graph edges.
test('actual model-generated saved graph executes with fixtures, partial failures and daily deduplication',async()=>{
  await fixture();const g=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/sales-generated-test8.json'),'utf8'));
  const validation=compileWorkflow(g,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues).toHaveLength(9);
  const flow=createFlow(),draft=createDraftVersion({flowId:flow.id,displayName:'Captured Test 8 model draft',trigger:g});
  expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(listRuns({flowId:flow.id})).toHaveLength(0);expect(versionReadiness(flow.id,draft.id).ready).toBe(false);
  g.settings.input.cron_expression='0 9 * * 1-5';
  for(const[key,value]of Object.entries(setup))if(g.nextAction.settings.input[key]===''||g.nextAction.settings.input[key]===null)g.nextAction.settings.input[key]=value;
  updateDraftVersion(draft.id,{trigger:g});expect(versionReadiness(flow.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(flow.id,draft.id);updateFlowStatus(flow.id,'ENABLED');
  deals=[salesFixtureDeal(),salesFixtureDeal(2),salesFixtureDeal(3)];options={failContact:'1',replied:['person2@example.net'],pageTwoReply:true};
  const before=[drafts.length,notifications.length];expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');
  expect(drafts.length).toBe(before[0]!+1);expect(notifications.length).toBe(before[1]!+1);expect(notifications.at(-1)).toContain('1 drafts saved');expect(notifications.at(-1)).toContain('1 need review');
  expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(drafts.length).toBe(before[0]!+1);expect(notifications.at(-1)).toContain('0 drafts saved; 1 skipped for replies; 1 already processed');
},60_000);

const gmailRow=(value:Record<string,unknown>)=>upsertConnection({externalId:'fixture-gmail',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-gmail',pieceVersion:'0.0.1',value});
test('an expired Gmail token that cannot be refreshed fails the run with a reconnect message, before any read or draft',async()=>{
  gmailRow({access_token:'synthetic-gmail',claimed_at:Math.floor(Date.now()/1000)-7200,expires_in:3600});
  try {
    const f=await fixture(),before=[calls.length,drafts.length,notifications.length];
    const result=await f.run();expect(result.status).toBe('FAILED');expect(String((result as any).failedStep?.errorMessage)).toContain('Reconnect the selected Gmail account');
    expect(listRunConnectionBindings(result.id).find(b=>b.externalId==='fixture-gmail')?.credentialFailure?.code).toBe('CONNECTION_EXPIRED');
    expect([calls.length,drafts.length,notifications.length]).toEqual(before);
  } finally {gmailRow({access_token:'synthetic-gmail'});}
},60_000);
/** A managed source standing in for jarvis:google (and one that is not Google), registered on both the run's resolver and readiness. */
async function withManagedSource<T>(id:string,body:()=>Promise<T>):Promise<T>{
  resolver.register({id,pieceNames:['@activepieces/piece-gmail','@activepieces/piece-google-calendar'],canResolve:(ext:string)=>ext==='jarvis:'+id,
    resolve:async()=>({type:'OAUTH2',value:{access_token:'synthetic-gmail'}}),identity:()=>'grant-'+id} as any);
  configureWorkflowReadiness({pieces:catalog,credentials:resolver});
  try {return await body();} finally {resolver.unregister(id);configureWorkflowReadiness({pieces:catalog});}
}
/** A draft that never went through readiness, run as it is. */
function unchecked(trigger:any){
  deals=[salesFixtureDeal()];options={};now=salesFixtureNow;
  const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Sales fixture',trigger});
  return {run:()=>run(flow.id,version.id)};
}
test('jarvis:google is accepted as the Gmail account by readiness and by the run, and drafts with it',async()=>{
  await withManagedSource('google',async()=>{
    const f=await fixture({gmailConnection:'jarvis:google'}),n=drafts.length;
    expect((await f.run()).status).toBe('SUCCEEDED');expect(drafts.length).toBe(n+1);
  });
},60_000);
test('readiness refuses jarvis:google as the HubSpot account, and on a CODE node carrying the sales settings',async()=>{
  await withManagedSource('google',async()=>{
    for(const phase of ['composition','activation'] as const){
      const issues=compileWorkflow(graph(true,{hubspotConnection:'jarvis:google'}),{pieces:catalog,phase,connection:()=>null} as any).issues;
      expect(issues.some((i:any)=>i.code==='CONNECTION_BINDING'&&String(i.path).endsWith('hubspotConnection')&&i.message===MANAGED_HUBSPOT_REFUSAL)).toBe(true);
    }
    const flow=createFlow(),g=graph(true,{gmailConnection:'jarvis:google'});g.nextAction.type='CODE';
    const version=createDraftVersion({flowId:flow.id,displayName:'Sales spoof',trigger:g});
    expect(versionReadiness(flow.id,version.id).issues.some((i:any)=>i.code==='CONNECTION_BINDING'&&String(i.path).endsWith('gmailConnection'))).toBe(true);
  });
},60_000);
test('the run itself refuses a managed account outside the sales exemption, before any read, resolve or binding row',async()=>{
  await withManagedSource('other',async()=>{
    await withManagedSource('google',async()=>{
      const cases:Array<[string,any,string]>=[
        ['HubSpot as jarvis:google',graph(true,{hubspotConnection:'jarvis:google'}),MANAGED_HUBSPOT_REFUSAL],
        ['Gmail as a non-Google managed id',graph(true,{gmailConnection:'jarvis:other'}),'Managed connection jarvis:other can only be a step'],
      ];
      for(const [label,trigger,message] of cases){
        const refusedId=Object.values(trigger.nextAction.settings.input).find(v=>String(v).startsWith('jarvis:')) as string;
        const f=unchecked(trigger),before=[calls.length,drafts.length,notifications.length];resolvedIds.length=0;
        const result=await f.run();expect([label,result.status]).toEqual([label,'FAILED']);
        expect(String((result as any).failedStep?.errorMessage)).toContain(message);
        expect([calls.length,drafts.length,notifications.length]).toEqual(before);
        // Refused before any credential is resolved or the run's binding recorded.
        expect(resolvedIds).toEqual([]);
        expect(listRunConnectionBindings(result.id).map(b=>b.externalId)).toEqual([]);
      }
    });
  });
},60_000);
