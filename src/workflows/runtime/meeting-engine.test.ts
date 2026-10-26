import { ApprovalManager } from '../../authority/approval';
import { pinFlowBindings } from '../db/repos/binding-pins';
/** Saved builder graph through the real worker/engine. Only synthetic provider transport. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, getFlow, listFlows, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, getLatestDraft, lockVersion, updateDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, listRuns } from '../db/repos/flow-run';
import { enqueue } from '../db/repos/job-queue';
import { upsertConnection } from '../db/repos/app-connection';
import { configureWorkflowReadiness, versionReadiness } from '../db/repos/flow-readiness';
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
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';
import { compileWorkflow } from './workflow-readiness';
import { createManageWorkflowTool } from '../../actions/tools/manage-workflow';


import { fixtureNow, fixtureSetup, fixtureEvent, fixtureRequest } from './meeting-fixtures';
const native=(name:string)=>'@jarvispieces/piece-jarvis-'+name;
let authority:AuthorityEngine;
let approvals:ApprovalManager,services:ReturnType<typeof buildSandboxServiceBackends>;
let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog;
const versions:Record<string,string>={},notifications:string[]=[],runIds:string[]=[],calls:string[]=[];
let events:any[]=[fixtureEvent()],changed:any,fail:string|undefined,oversized:string|undefined,loseNotification=false;
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-meeting-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,76));
 const bundle=await buildEngineBundle();
 for(const name of ['context','notify']) {
  const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis',name);await buildPiece(path);
  const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versions[meta.name]=meta.version;
  const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 }
 for(const [suffix,piece] of [['calendar','google-calendar'],['gmail','gmail'],['hubspot','hubspot']])upsertConnection({externalId:'fixture-'+suffix,displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-'+piece,pieceVersion:'0.0.1',value:{access_token:'synthetic-'+suffix}});
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
 approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
 meetingNow:()=>fixtureNow,meetingFetch:(async(url:any,init:any)=>{
  const u=new URL(String(url));const provider=u.hostname==='www.googleapis.com'?'calendar':u.hostname==='gmail.googleapis.com'?'gmail':'hubspot';
  expect(['www.googleapis.com','gmail.googleapis.com','api.hubapi.com']).toContain(u.hostname);
  expect(init.headers.Authorization).toBe('Bearer synthetic-'+provider);expect(init.redirect).toBe('error');
  expect(init.method).toBe(provider==='hubspot'?'POST':'GET');if(provider==='hubspot')expect(u.pathname).toBe('/crm/v3/objects/contacts/search');
  calls.push(init.method+' '+u.pathname);
  return Response.json(await fixtureRequest(events,{changed,fail,oversized})(provider,u.pathname+u.search,init.body?JSON.parse(init.body):undefined));
 }) as typeof fetch,llmManager:{chat:async()=>{throw Error('No LLM may execute');}} as any,channelService:{sendWorkflowNotification:async()=>{throw Error('No external notification');}} as any,
 wsService:{broadcastNotificationToDashboard:(text:string)=>{notifications.push(text);if(loseNotification)throw Error('Unknown delivery');return 1;}} as any});
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'meeting-metadata',projectId:DEFAULT_IDS.project});try{const entries=[];for(const[pieceName,pieceVersion]of Object.entries(versions))entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName,pieceVersion})));catalog=new PieceCatalog(entries);if(process.env.JARVIS_MEETING_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_MEETING_CATALOG_EXPORT,JSON.stringify(entries));configureWorkflowReadiness({pieces:catalog});}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function graph(configured=true):any {
 const input=configured?{...fixtureSetup,internalDomains:'example.com'}:{calendarConnection:'',gmailConnection:'',hubspotConnection:'',calendarId:'',ownerEmail:'',internalDomains:'',hubspotPortalId:'',recentDays:30,timezone:'Europe/Rome'};
 return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'schedule',input:{cron_expression:'*/10 * * * *',timezone:'Europe/Rome'}},nextAction:{name:'prepare',type:'PIECE',settings:{pieceName:native('context'),pieceVersion:versions[native('context')],actionName:'meeting_briefs',input},nextAction:{name:'each_meeting',type:'LOOP_ON_ITEMS',settings:{items:'{{prepare.meetings}}'},firstLoopAction:{name:'notify',type:'PIECE',settings:{pieceName:native('notify'),pieceVersion:versions[native('notify')],actionName:'notify',input:{message:'{{each_meeting.item.brief}}',meetingGuard:'{{each_meeting.item.guard}}',idempotencyKey:'{{each_meeting.item.notificationKey}}',channels:['dashboard'],priority:'normal'}}}}}};
}
async function fixture() {
 events=[fixtureEvent()];changed=undefined;fail=undefined;oversized=undefined;loseNotification=false;authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Meeting fixture',trigger:graph()});
 expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');
 return {flow,version,run:()=>run(flow.id,version.id)};
}
async function run(flowId:string,flowVersionId:string){
 const run=createFlowRun({flowId,flowVersionId});runIds.push(run.id);enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId,projectId:DEFAULT_IDS.project,triggerPayload:{}},flowId,flowRunId:run.id});await worker.drain();const result=getFlowRun(run.id)!;return result;
}
test('real engine paginated brief, no external writes, repeat and concurrent poll suppression',async()=>{
 const f=await fixture(),n=notifications.length;expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+1);expect(notifications.at(-1)).toContain('#all/abc');
 const runs=await Promise.all([f.run(),f.run()]);expect(runs.every(r=>r.status==='SUCCEEDED')).toBe(true);expect(notifications.length).toBe(n+1);
},60_000);
test('rescheduled start gets one new alert, returning to original start does not',async()=>{
 const f=await fixture(),n=notifications.length;await f.run();events=[fixtureEvent({start:{dateTime:'2026-10-23T09:20:00Z'}})];expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+2);events=[fixtureEvent()];await f.run();expect(notifications.length).toBe(n+2);
},60_000);
test('late reschedule suppresses stale brief without consuming identity',async()=>{
 const f=await fixture(),n=notifications.length;changed=fixtureEvent({status:'cancelled'});expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n);changed=undefined;expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+1);
},60_000);
test('oversized brief is delivered truncated under its own key, once; later polls deduplicate',async()=>{
 const f=await fixture(),n=notifications.length;oversized='big@external.test';
 events=[fixtureEvent(),fixtureEvent({id:'occurrence-2',summary:'Long history',start:{dateTime:'2026-10-23T09:20:00Z'},attendees:[{email:'owner@example.com',self:true},{email:'big@external.test'}]})];
 const first=await f.run();expect(first.status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+2);
 const sent=notifications.slice(n);expect(sent.filter(t=>t.includes('Customer planning'))).toHaveLength(1);
 const long=sent.filter(t=>t.includes('Long history'));expect(long).toHaveLength(1);
 expect(long[0]).toMatch(/\d+ older message excerpts from \d+ conversations omitted to fit the 24,000 character brief limit; open the meeting or Gmail for the full history\./);
 expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+2);
 oversized=undefined;expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+2);
},60_000);
test('source failure fails run and sends no brief',async()=>{
 const f=await fixture(),n=notifications.length;fail='gmail';expect((await f.run()).status).toBe('FAILED');expect(notifications.length).toBe(n);
},60_000);
test('notification uncertainty and database restart never redispatch',async()=>{
 const f=await fixture(),n=notifications.length;loseNotification=true;await f.run();loseNotification=false;
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,76));configureWorkflowReadiness({pieces:catalog});await f.run();expect(notifications.length).toBe(n+1);
},60_000);
test('actual compose/save/readback graph defers setup then executes through engine fixtures',async()=>{
 events=[fixtureEvent()];changed=undefined;fail=undefined;loseNotification=false;const before=[calls.length,notifications.length];let turn=0;
 const tool=createManageWorkflowTool({pieceRegistry:catalog,llm:{chat:async()=>{throw Error('Use discovery');},chatTools:async request=>{
  if(turn++===0)return {content:'',tool_calls:Object.keys(versions).map((piece,i)=>({id:'inspect-'+i,name:'get_piece_details',arguments:{pieceName:piece}}))};
  expect(JSON.stringify(request)).toContain('meeting_briefs');return {content:'',tool_calls:[{id:'save',name:'submit_flow',arguments:{displayName:'Generated meeting preparation',trigger:graph(false)}}]};
 }}});
 const raw=await tool.execute({action:'compose',name:'Generated meeting preparation',description:'Build disabled draft: every ten minutes in Europe/Rome find meetings starting within thirty minutes with external attendees, build brief from HubSpot and recent Gmail with source links. Notify once per event/current start, handle reschedules, never contact attendees. Defer unknown setup.',contract:{trigger:{kind:'schedule',cron:'*/10 * * * *',timezone:'Europe/Rome'},forbidden:{effects:['send_email']}}}) as string;
 expect(raw).toContain('"ok":true');const saved=listFlows().find(f=>getLatestDraft(f.id)?.displayName==='Generated meeting preparation')!,draft=getLatestDraft(saved.id)!;
 expect(saved.status).toBe('DISABLED');expect(saved.published_version_id).toBeNull();expect(listRuns({flowId:saved.id})).toHaveLength(0);expect([calls.length,notifications.length]).toEqual(before);
 const validation=compileWorkflow(draft.trigger,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues!.length).toBeGreaterThan(0);expect(versionReadiness(saved.id,draft.id).ready).toBe(false);
 let cursor:string|undefined,text='';do{const result=await tool.execute({action:'get',flow:saved.id,version_id:draft.id,view:'validation',...(cursor?{cursor}:{})}) as string;const page=JSON.parse(result.split('\n').slice(2,-1).join('\n'));text+=page.content;cursor=page.nextCursor;}while(cursor);
 expect(JSON.parse(text).runtimeSafeguards.safeguards.some((s:any)=>s.kind==='meeting-freshness')).toBe(true);
 const filled=structuredClone(draft.trigger);filled.nextAction!.settings!.input={...fixtureSetup,internalDomains:'example.com'};updateDraftVersion(draft.id,{trigger:filled});expect(versionReadiness(saved.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(saved.id,draft.id);updateFlowStatus(saved.id,'ENABLED');
 expect((await run(saved.id,draft.id)).status).toBe('SUCCEEDED');expect(notifications.length).toBe(before[1]!+1);
},60_000);

test('read authority denial prevents provider requests and notifications',async()=>{
 const f=await fixture(),before=[calls.length,notifications.length];authority.addOverride({action:'read_data',allowed:false});
 expect((await f.run()).status).toBe('FAILED');expect([calls.length,notifications.length]).toEqual(before);
 authority.updateConfig({...authority.getConfig(),overrides:[]});
},60_000);

// Captured from the configured model via the production composer in isolated storage.
// No graph rewrites: only the seven deferred user settings receive fixture values.
test('live-model generated saved workflow executes, deduplicates and handles reschedules',async()=>{
 await fixture();const g=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/meeting-generated-test7.json'),'utf8'));
 const validation=compileWorkflow(g,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues!.length).toBeGreaterThan(0);
 const flow=createFlow(),draft=createDraftVersion({flowId:flow.id,displayName:'Captured model draft',trigger:g});
 expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(listRuns({flowId:flow.id})).toHaveLength(0);
 for(const [key,value]of Object.entries(fixtureSetup))if(g.nextAction.settings.input[key]==='')g.nextAction.settings.input[key]=key==='internalDomains'?'example.com':value;
 updateDraftVersion(draft.id,{trigger:g});expect(versionReadiness(flow.id,draft.id).ready).toBe(true);lockVersion(draft.id);setPublishedVersion(flow.id,draft.id);updateFlowStatus(flow.id,'ENABLED');
 const before=notifications.length;expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(notifications.length).toBe(before+1);
 expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(notifications.length).toBe(before+1);
 events=[fixtureEvent({start:{dateTime:'2026-10-23T09:25:00Z'}})];expect((await run(flow.id,draft.id)).status).toBe('SUCCEEDED');expect(notifications.length).toBe(before+2);
},60_000);

test('account replacement is blocked by workflow pins before any provider request',async()=>{
 const f=await fixture();pinFlowBindings(f.flow.id);const before=[calls.length,notifications.length];
 upsertConnection({externalId:'fixture-calendar',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-google-calendar',pieceVersion:'0.0.1',value:{access_token:'changed-synthetic'}});
 try {expect((await f.run()).status).toBe('FAILED');expect([calls.length,notifications.length]).toEqual(before);}
 finally {upsertConnection({externalId:'fixture-calendar',displayName:'Fixture',type:'OAUTH2',pieceName:'@activepieces/piece-google-calendar',pieceVersion:'0.0.1',value:{access_token:'synthetic-calendar'}});}
},60_000);
test('approval wait rechecks Calendar before delivery and leaves stale key unconsumed',async()=>{
 const f=await fixture(),n=notifications.length;
 const execution=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(execution.id);
 const ctx={runId:execution.id,projectId:DEFAULT_IDS.project,stepName:'prepare',executionPath:[] as Array<[string,number]>};
 const prepared=await services.meetingBriefs!({...fixtureSetup},ctx) as any;const item=prepared.meetings[0];
 authority.setGovernedCategories(['send_message']);
 const notifyCtx={...ctx,stepName:'notify',executionPath:[['each_meeting',0]] as Array<[string,number]>};
 const req={message:item.brief,meetingGuard:item.guard,channels:['dashboard'],priority:'normal' as const};
 const pending=await services.notify!(req,notifyCtx);expect(pending.approval).toBeDefined();expect(notifications.length).toBe(n);
 changed=fixtureEvent({status:'cancelled'});approvals.approve(pending.approval!.approvalId,'fixture');
 const result=await services.notify!(req,notifyCtx) as any;expect(result.skipped).toContain('changed');expect(notifications.length).toBe(n);
 changed=undefined;authority.setGovernedCategories([]);expect((await f.run()).status).toBe('SUCCEEDED');expect(notifications.length).toBe(n+1);
},60_000);
