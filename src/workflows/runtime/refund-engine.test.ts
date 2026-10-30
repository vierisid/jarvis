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
import {resumeResolvedWorkflowEffects} from './effect-approval-scheduler';
import {getWorkflowDb} from '../db';
import {listWorkflowEffects} from '../db/repos/workflow-effect';
import {buildSandboxServiceBackends} from './service-backends';
import {WorkflowEventBuffer} from './event-buffer';
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
import {compileWorkflow} from './workflow-readiness';
import {REFUND_PIECE as IMPORT_PIECE,REFUND_ACTION as IMPORT_ACTION,REFUND_REQUIRED,REFUND_TTL} from './refund';
import {refundFixtureSetup as setup,refundFixtureTicket as ticket,refundFixtureProvider,validateRefundFixtures} from './refund-fixtures';
import {workflowSafeguards} from './workflow-safeguards';
import {acquireRefund} from '../db/repos/refund';
import {REFUND_LOOP_REFUSAL,managedRefundRefusal} from '../refund-accounts';
let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>,now=Date.now(),provider=refundFixtureProvider();
const runIds:string[]=[];
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-refund-engine-'));initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));
 const bundle=await buildEngineBundle();const path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/refund');await buildPiece(path);
 const installed=join(dir,'node_modules',IMPORT_PIECE);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 upsertConnection({externalId:'fixture-stripe',displayName:'Fixture Stripe',type:'SECRET_TEXT',pieceName:'@activepieces/piece-stripe',pieceVersion:'0.8.1',value:{secret_text:'synthetic-stripe'}});
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),
  refundNow:()=>now,refundFetch:((...args:any[])=>provider.fetchImpl(args[0],args[1])) as typeof fetch,llmManager:{chat:async()=>{throw Error('No model execution');}} as any,channelService:{sendWorkflowNotification:async()=>{throw Error('No notifications');}} as any,wsService:{} as any});
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'refund-metadata',projectId:DEFAULT_IDS.project});
 try{catalog=new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:IMPORT_PIECE,pieceVersion:'0.0.1'}))]);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_REFUND_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_REFUND_CATALOG_EXPORT,JSON.stringify(catalog.list()));}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function graph(configured=true):any{return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{}},nextAction:{name:'refund_request',type:'PIECE',settings:{pieceName:IMPORT_PIECE,actionName:IMPORT_ACTION,input:{...(configured?setup:Object.fromEntries(REFUND_REQUIRED.filter(k=>k!=='ticket').map(k=>[k,'']))),ticket:'{{trigger}}'}}}};}
function reset(){now=Date.now();provider=refundFixtureProvider();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});getWorkflowDb().run('DELETE FROM workflow_refund_payment');getWorkflowDb().run('DELETE FROM workflow_refund');}
function fixture(trigger=graph()){const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Refund fixture',trigger});expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');return {flow,version};}
async function begin(f:ReturnType<typeof fixture>,payload:unknown=ticket){const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id});runIds.push(run.id);enqueue({jobType:RUN_FLOW,payload:{runId:run.id,flowVersionId:f.version.id,projectId:DEFAULT_IDS.project,payload},flowId:f.flow.id,flowRunId:run.id});await worker.drain();return getFlowRun(run.id)!;}
function approvalFor(id:string){const effect=listWorkflowEffects(id).find(e=>e.toolName==='workflow_approved_refund');expect(effect?.approvalId).toBeDefined();return approvals.getRequest(effect!.approvalId!)!;}
async function resume(id:string){expect(resumeResolvedWorkflowEffects()).toBeGreaterThan(0);await worker.drain();return getFlowRun(id)!;}
const posts=()=>provider.calls.filter(c=>c.method==='POST');
const records=()=>getWorkflowDb().query('SELECT state FROM workflow_refund').all().map((r:any)=>JSON.parse(r.state));
test('real engine waits for exact approval, survives restart and records one refund',async()=>{
 reset();const f=fixture(),run=await begin(f);expect(run.status).toBe('PAUSED');expect(posts()).toHaveLength(0);const a=approvalFor(run.id),args=JSON.parse(a.tool_arguments);
 expect(args.amount).toBe(1200);expect(args.currency).toBe('eur');expect(args.charge).toBe('ch_fixture');expect(JSON.parse(a.context).expiresAt).toBe(now+REFUND_TTL);expect(JSON.parse(a.context).confirm).toBe('always');
 closeWorkflowDb();initWorkflowDb(join(dir,'db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});
 expect(approvals.approve(a.id,'dashboard')).not.toBeNull();expect((await resume(run.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);expect(records()[0].state).toBe('refunded');expect(approvals.getRequest(a.id)?.status).toBe('executed');
 expect((await begin(f)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);
},120000);
test('rejection and 48-hour deadline terminate requests without refund',async()=>{
 for(const decision of ['denied','expired']){reset();const run=await begin(fixture());expect(run.status).toBe('PAUSED');const a=approvalFor(run.id);
  if(decision==='denied')approvals.deny(a.id,'dashboard');else{expect(approvals.expireDeadlines(now+REFUND_TTL-1)).toBe(0);now+=REFUND_TTL;expect(approvals.expireDeadlines(now)).toBe(1);expect(approvals.approve(a.id,'dashboard')).toBeNull();}
  expect((await resume(run.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(0);expect(records()[0].state).toBe(decision==='denied'?'rejected':'expired');
 }
},120000);
test('lost provider response reconciles without second refund; pending is explicit',async()=>{
 for(const status of ['succeeded','pending']){reset();provider.options.loseReply=true;provider.options.status=status;const f=fixture(),run=await begin(f);approvals.approve(approvalFor(run.id).id,'dashboard');expect((await resume(run.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);expect(records()[0].state).toBe(status==='succeeded'?'refunded':'pending_provider');await begin(f);expect(posts()).toHaveLength(1);}
},120000);
test('changed payment or immutable approval cannot dispatch',async()=>{
 reset();const run=await begin(fixture());const a=approvalFor(run.id);provider.payment.amount_refunded=50;approvals.approve(a.id,'dashboard');expect((await resume(run.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(0);expect(records()[0].state).toBe('needs_review');
 reset();const altered=await begin(fixture());const b=approvalFor(altered.id);getWorkflowDb().run('UPDATE approval_requests SET tool_arguments=? WHERE id=?',[JSON.stringify({...JSON.parse(b.tool_arguments),amount:1}),b.id]);approvals.approve(b.id,'dashboard');expect((await resume(altered.id)).status).toBe('FAILED');expect(posts()).toHaveLength(0);
},120000);
test('different ticket IDs and overlapping deliveries cannot create duplicate refunds or approvals',async()=>{
 reset();const f=fixture(),first=await begin(f);expect(first.status).toBe('PAUSED');expect((await begin(f)).status).toBe('SUCCEEDED');expect((await begin(f,{...ticket,id:'another-ticket'})).status).toBe('SUCCEEDED');expect(records().find(r=>r.proposal.ticketId==='another-ticket')?.state).toBe('needs_review');
 approvals.approve(approvalFor(first.id).id,'dashboard');expect((await resume(first.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);
},120000);
test('disabled draft supports deferred setup, safeguards and local fixture suite',async()=>{
 reset();const f=createFlow(),v=createDraftVersion({flowId:f.id,displayName:'Refund setup',trigger:graph(false)});expect(compileWorkflow(v.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);expect(versionReadiness(f.id,v.id).ready).toBe(false);expect(getFlow(f.id)?.status).toBe('DISABLED');expect(workflowSafeguards(v.trigger).safeguards).toHaveLength(3);
 expect((await validateRefundFixtures(graph())).passed).toBe(true);expect(listRuns({flowId:f.id})).toHaveLength(0);expect(posts()).toHaveLength(0);
 await expect(validateRefundFixtures({...graph(),nextAction:{...graph().nextAction,nextAction:{type:'CODE'}}})).rejects.toThrow();
});
test('lower Authority level requests human approval; explicit payment denial and changed account still block',async()=>{
 reset();authority.updateConfig({...authority.getConfig(),default_level:5});const f=fixture();pinFlowBindings(f.flow.id);const run=await begin(f);expect(run.status).toBe('PAUSED');const a=approvalFor(run.id);approvals.approve(a.id,'dashboard');authority.addOverride({action:'make_payment',allowed:false});expect((await resume(run.id)).status).toBe('FAILED');expect(posts()).toHaveLength(0);
 reset();const g=fixture();pinFlowBindings(g.flow.id);const next=await begin(g);approvals.approve(approvalFor(next.id).id,'dashboard');
 upsertConnection({externalId:'fixture-stripe',displayName:'Changed',type:'SECRET_TEXT',pieceName:'@activepieces/piece-stripe',pieceVersion:'0.8.1',value:{secret_text:'changed'}});
 try{expect((await resume(next.id)).status).toBe('FAILED');expect(posts()).toHaveLength(0);}finally{upsertConnection({externalId:'fixture-stripe',displayName:'Fixture Stripe',type:'SECRET_TEXT',pieceName:'@activepieces/piece-stripe',pieceVersion:'0.8.1',value:{secret_text:'synthetic-stripe'}});}
},120000);
test('durable coordinator serializes concurrent requests',async()=>{
 reset();const f=fixture();const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id,status:'RUNNING'});runIds.push(run.id);
 const ctx={runId:run.id,projectId:DEFAULT_IDS.project,stepName:'refund_request',executionPath:[] as Array<[string,number]>};const input={...setup,ticket};
 const both=await Promise.all([services.approvalRefund!(input,ctx),services.approvalRefund!(input,ctx)]) as any[];
 expect(both.filter(r=>r.approval)).toHaveLength(1);expect(both.filter(r=>r.waitpointId)).toHaveLength(1);expect(posts()).toHaveLength(0);
 const a=both.find(r=>r.approval).approval.approvalId;approvals.approve(a,'dashboard');const receipt=await services.approvalRefund!(input,ctx) as any;expect(receipt.status).toBe('refunded');expect(posts()).toHaveLength(1);
});
test('a restarted owner fences the old lease and late clicks expire without a scheduler tick',()=>{
 reset();const old=acquireRefund('lease-test','same-config','old','run',()=>now);expect('store'in old).toBe(true);
 expect(acquireRefund('lease-test','same-config','overlap','run',()=>now)).toHaveProperty('busyUntil');now+=60_001;
 const next=acquireRefund('lease-test','same-config','new','run',()=>now);expect('store'in next).toBe(true);
 if('store'in old)expect(()=>old.store.check()).toThrow('ownership');if('store'in next)next.release();
 expect(()=>acquireRefund('lease-test','changed-config','new','run',()=>now)).toThrow('changed');
 const a=approvals.createRequest({agentId:'fixture',agentName:'Fixture',toolName:'workflow_approved_refund',toolArguments:{amount:1},actionCategory:'make_payment',urgency:'urgent',reason:'Fixture',context:JSON.stringify({expiresAt:Date.now()-1}),executionMode:'workflow'});
 expect(approvals.approve(a.id,'dashboard')).toBeNull();expect(approvals.getRequest(a.id)?.status).toBe('expired');
});
test('actual generated Test 11 workflow runs with fixture setup only',async()=>{
 const path=join(import.meta.dir,'fixtures/refund-generated-test11.json');if(!existsSync(path)){if(process.env.JARVIS_REFUND_CATALOG_EXPORT)return;throw Error('Capture actual generated workflow');}
 reset();const g=JSON.parse(readFileSync(path,'utf8'));expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).ready).toBe(true);const original=structuredClone(g);
 for(const[k,v]of Object.entries(setup))if(g.nextAction.settings.input[k]===''||g.nextAction.settings.input[k]==null)g.nextAction.settings.input[k]=v;
 const f=fixture(g),run=await begin(f);expect(run.status).toBe('PAUSED');expect(posts()).toHaveLength(0);approvals.approve(approvalFor(run.id).id,'dashboard');expect((await resume(run.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);expect((await validateRefundFixtures(original)).passed).toBe(true);
},120000);
test('a request that ended before dispatch does not consume its ticket or charge',async()=>{
 reset();let f=fixture();provider.payment.paid=false;expect((await begin(f)).status).toBe('FAILED');provider.payment.paid=true;
 const retried=await begin(f);expect(retried.status).toBe('PAUSED');expect(JSON.parse(approvalFor(retried.id).tool_arguments).amount).toBe(1200);
 reset();f=fixture();expect((await begin(f,{...ticket,amount:5000})).status).toBe('FAILED');expect((await begin(f)).status).toBe('PAUSED');
 reset();f=fixture();const rejected=await begin(f);approvals.deny(approvalFor(rejected.id).id,'dashboard');expect((await resume(rejected.id)).status).toBe('SUCCEEDED');
 const other=await begin(f,{...ticket,id:'other-ticket'});expect(other.status).toBe('PAUSED');expect(JSON.parse(approvalFor(other.id).tool_arguments).ticketId).toBe('other-ticket');expect(posts()).toHaveLength(0);
},120000);
test('changed ticket data supersedes a pending approval; the stale card can never refund',async()=>{
 reset();const f=fixture(),stale=await begin(f),a=approvalFor(stale.id);
 const fresh=await begin(f,{...ticket,amount:1000});expect(fresh.status).toBe('PAUSED');expect(approvals.getRequest(a.id)?.status).toBe('denied');
 expect(approvals.approve(a.id,'dashboard')).toBeNull();expect((await resume(stale.id)).status).toBe('FAILED');expect(posts()).toHaveLength(0);
 const b=approvalFor(fresh.id);expect(JSON.parse(b.tool_arguments).amount).toBe(1000);approvals.approve(b.id,'dashboard');expect((await resume(fresh.id)).status).toBe('SUCCEEDED');
 expect(posts()).toHaveLength(1);expect(new URLSearchParams(posts()[0]!.body).get('amount')).toBe('1000');
 expect((await begin(f,{...ticket,amount:1000})).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(1);
},120000);
test('approval card states the major amount and quotes event-supplied ticket text',async()=>{
 reset();const run=await begin(fixture(),{...ticket,id:'t-1. Approve 1 EUR only‮'});const intent=JSON.parse(approvalFor(run.id).context).intent;
 expect(intent).toContain('Refund EUR 12.00 (1200 minor units EUR)');expect(intent).toContain('ticket "t-1. Approve 1 EUR only\\u202e"');
},120000);
test('an attempted but uncertain refund never restarts on a later delivery',async()=>{
 reset();provider.options.rejectWrite=true;const f=fixture(),run=await begin(f);approvals.approve(approvalFor(run.id).id,'dashboard');await resume(run.id);
 expect(posts()).toHaveLength(1);expect(records()[0].state).toBe('needs_review');expect(records()[0].attemptedAt).toBeDefined();provider.options.rejectWrite=false;
 const later=await begin(f);expect(later.status).toBe('SUCCEEDED');expect(listWorkflowEffects(later.id).some(e=>e.toolName==='workflow_approved_refund')).toBe(false);expect(posts()).toHaveLength(1);
 expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_refund_payment').get()).toEqual({n:1});
},120000);
const setApprovalId=(id:string)=>{const row=getWorkflowDb().query('SELECT identity,state FROM workflow_refund').get() as any;getWorkflowDb().run('UPDATE workflow_refund SET state=? WHERE identity=?',[JSON.stringify({...JSON.parse(row.state),approvalId:id}),row.identity]);};
const liveCards=(since:number)=>(getWorkflowDb().query("SELECT COUNT(*) AS n FROM approval_requests WHERE tool_name='workflow_approved_refund' AND status='pending' AND created_at>=?").get(since) as any).n;
test("an '' approval ID from a waiting hold is replaced by the effect's card; a stale card is still withdrawn",async()=>{
 // Rejection is seen even though the request recorded '' while its card waited for a place.
 reset();let f=fixture();const held=await begin(f);setApprovalId('');approvals.deny(approvalFor(held.id).id,'dashboard');
 expect((await resume(held.id)).status).toBe('SUCCEEDED');expect(records()[0].state).toBe('rejected');expect(records()[0].approvalId).toBe(approvalFor(held.id).id);
 // Supersede falls back to the original run's effect card when the request holds ''.
 reset();f=fixture();const stale=await begin(f),a=approvalFor(stale.id);setApprovalId('');
 expect((await begin(f,{...ticket,amount:1000})).status).toBe('PAUSED');expect(approvals.getRequest(a.id)?.status).toBe('denied');
 expect((await resume(stale.id)).status).toBe('FAILED');expect(posts()).toHaveLength(0);
},120000);
test('a superseded card whose withdrawal fails is retried on the next invocation',async()=>{
 reset();const f=fixture(),stale=await begin(f),a=approvalFor(stale.id);const deny=ApprovalManager.prototype.deny,warn=console.warn;
 ApprovalManager.prototype.deny=function(){throw Error('Synthetic approval store failure');};console.warn=()=>{};
 let fresh;try{fresh=await begin(f,{...ticket,amount:1000});}finally{ApprovalManager.prototype.deny=deny;console.warn=warn;}
 expect(fresh.status).toBe('PAUSED');expect(approvals.getRequest(a.id)?.status).toBe('pending');expect(records()[0].withdraw).toEqual([a.id]);
 // A redelivery runs the retry while the new card is still pending: it withdraws only the stale card, never the live one.
 const b=approvalFor(fresh.id);expect((await begin(f,{...ticket,amount:1000})).status).toBe('SUCCEEDED');expect(getFlowRun(fresh.id)?.status).toBe('PAUSED');
 expect(approvals.getRequest(a.id)?.status).toBe('denied');expect(approvals.getRequest(b.id)?.status).toBe('pending');expect(records()[0].withdraw).toBeUndefined();expect(posts()).toHaveLength(0);
 approvals.approve(b.id,'dashboard');expect((await resume(fresh.id)).status).toBe('SUCCEEDED');
 expect(approvals.getRequest(a.id)?.status).toBe('denied');expect(records()[0].withdraw).toBeUndefined();expect(posts()).toHaveLength(1);
 // The same pass resumed the stale run, whose card was withdrawn by the redelivery.
 expect(getFlowRun(stale.id)?.status).toBe('FAILED');expect(posts()).toHaveLength(1);
},120000);
test('a second supersede keeps the first one\'s failed withdrawal: the oldest card still ends denied',async()=>{
 reset();const f=fixture(),first=await begin(f),a=approvalFor(first.id);const deny=ApprovalManager.prototype.deny,warn=console.warn;
 ApprovalManager.prototype.deny=function(){throw Error('Synthetic approval store failure');};console.warn=()=>{};
 let second;try{second=await begin(f,{...ticket,amount:1000});}finally{ApprovalManager.prototype.deny=deny;console.warn=warn;}
 expect(second.status).toBe('PAUSED');expect(records()[0].withdraw).toEqual([a.id]);const b=approvalFor(second.id);
 // C supersedes B before B ran again, so B never retried its withdrawal of A.
 const third=await begin(f,{...ticket,amount:900});expect(third.status).toBe('PAUSED');const c=approvalFor(third.id);
 expect(approvals.getRequest(a.id)?.status).toBe('denied');expect(approvals.getRequest(b.id)?.status).toBe('denied');expect(approvals.getRequest(c.id)?.status).toBe('pending');
 expect(records()[0].withdraw).toBeUndefined();expect(posts()).toHaveLength(0);
 // Both withdrawn runs end without a refund; C stays waiting on its own card.
 expect((await resume(first.id)).status).toBe('FAILED');expect(getFlowRun(second.id)?.status).toBe('FAILED');expect(getFlowRun(third.id)?.status).toBe('PAUSED');expect(posts()).toHaveLength(0);
 approvals.deny(c.id,'dashboard');expect((await resume(third.id)).status).toBe('SUCCEEDED');expect(posts()).toHaveLength(0);
},120000);
test('after a human rejection the same ticket proposes again on its next event, with one live card and no refund',async()=>{
 reset();const since=Date.now(),f=fixture(),first=await begin(f),a=approvalFor(first.id);approvals.deny(a.id,'dashboard');
 expect((await resume(first.id)).status).toBe('SUCCEEDED');expect(records()[0].state).toBe('rejected');expect(liveCards(since)).toBe(0);
 // Rejecting does not clear the ticket's refund flag: the redelivered event raises a new card for the same ticket.
 const again=await begin(f);expect(again.status).toBe('PAUSED');const b=approvalFor(again.id);expect(b.id).not.toBe(a.id);
 expect(JSON.parse(b.tool_arguments).ticketId).toBe('ticket-1');expect(JSON.parse(b.context).intent).toContain('Rejecting does not clear');expect(liveCards(since)).toBe(1);
 expect((await begin(f)).status).toBe('SUCCEEDED');expect(liveCards(since)).toBe(1);expect(posts()).toHaveLength(0);
},120000);
/** A saved version that skipped readiness, with a running run on it: what a hand-edited or older draft could hold. */
function unchecked(trigger:any){
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Refund unchecked',trigger});lockVersion(version.id);
 const run=createFlowRun({flowId:flow.id,flowVersionId:version.id,status:'RUNNING'});runIds.push(run.id);
 return (executionPath:Array<[string,number]>=[])=>({runId:run.id,projectId:DEFAULT_IDS.project,stepName:'refund_request',executionPath});
}
const refundRows=()=>(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_refund').get() as any).n;
test('a Jarvis-managed Stripe connection is refused in readiness and before anything is resolved at run time',async()=>{
 reset();const g=graph();g.nextAction.settings.input.stripeConnection='jarvis:stripe';
 expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).issues.map(i=>i.message)).toContain(managedRefundRefusal('stripeConnection'));
 const ctx=unchecked(g);
 await expect(services.approvalRefund!({...setup,stripeConnection:'jarvis:stripe',ticket},ctx())).rejects.toThrow(managedRefundRefusal('stripeConnection'));
 expect(provider.calls).toHaveLength(0);expect(refundRows()).toBe(0);
},120000);
test('setup must equal the saved step: an event-mapped ticket source cannot choose the request key',async()=>{
 reset();const g=graph();g.nextAction.settings.input.ticketSource='{{trigger.src}}';
 expect(compileWorkflow(g,{pieces:catalog,phase:'composition'}).issues.some(i=>i.path==='settings.input.ticketSource')).toBe(true);
 const ctx=unchecked(g);
 // The engine resolved the template from the event; the saved literal differs, so nothing is read or keyed.
 await expect(services.approvalRefund!({...setup,ticketSource:'attacker-chosen',ticket:{...ticket,src:'attacker-chosen'}},ctx())).rejects.toThrow('Refund setup must match the saved workflow');
 expect(provider.calls).toHaveLength(0);expect(refundRows()).toBe(0);
 // A CODE node carrying the same settings is not a refund step.
 reset();const code=graph();code.nextAction.type='CODE';
 await expect(services.approvalRefund!({...setup,ticket},unchecked(code)())).rejects.toThrow('saved ticket refund step');
 expect(provider.calls).toHaveLength(0);
},120000);
test('a refund step inside a loop is refused in readiness and at run time, so one ticket never raises two cards',async()=>{
 reset();const since=Date.now(),inner=graph().nextAction;
 const looped={...graph(),nextAction:{name:'each',type:'LOOP_ON_ITEMS',settings:{items:'{{trigger.items}}'},firstLoopAction:inner}};
 expect(compileWorkflow(looped,{pieces:catalog,phase:'composition'}).issues.map(i=>i.message)).toContain(REFUND_LOOP_REFUSAL);
 const ctx=unchecked(looped);
 for(const i of [0,1])await expect(services.approvalRefund!({...setup,ticket},ctx([['each',i]]))).rejects.toThrow(REFUND_LOOP_REFUSAL);
 expect(provider.calls).toHaveLength(0);expect(refundRows()).toBe(0);
 expect(liveCards(since)).toBe(0);
},120000);
