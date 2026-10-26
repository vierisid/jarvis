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
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {REFUND_PIECE as IMPORT_PIECE,REFUND_ACTION as IMPORT_ACTION,REFUND_REQUIRED,REFUND_TTL} from './refund';
import {refundFixtureSetup as setup,refundFixtureTicket as ticket,refundFixtureProvider,validateRefundFixtures} from './refund-fixtures';
import {workflowSafeguards} from './workflow-safeguards';
import {acquireRefund} from '../db/repos/refund';
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
test('disabled draft supports deferred setup, safeguards and local fixture tool',async()=>{
 reset();const f=createFlow(),v=createDraftVersion({flowId:f.id,displayName:'Refund setup',trigger:graph(false)});expect(compileWorkflow(v.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);expect(versionReadiness(f.id,v.id).ready).toBe(false);expect(getFlow(f.id)?.status).toBe('DISABLED');expect(workflowSafeguards(v.trigger).safeguards).toHaveLength(3);
 const tool=createManageWorkflowTool({pieceRegistry:catalog});const out=await tool.execute({action:'validate_fixtures',flow:f.id});expect(String(out)).toContain('"passed":true');expect(listRuns({flowId:f.id})).toHaveLength(0);expect(posts()).toHaveLength(0);
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
test('an attempted but uncertain refund never restarts on a later delivery',async()=>{
 reset();provider.options.rejectWrite=true;const f=fixture(),run=await begin(f);approvals.approve(approvalFor(run.id).id,'dashboard');await resume(run.id);
 expect(posts()).toHaveLength(1);expect(records()[0].state).toBe('needs_review');expect(records()[0].attemptedAt).toBeDefined();provider.options.rejectWrite=false;
 const later=await begin(f);expect(later.status).toBe('SUCCEEDED');expect(listWorkflowEffects(later.id).some(e=>e.toolName==='workflow_approved_refund')).toBe(false);expect(posts()).toHaveLength(1);
 expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_refund_payment').get()).toEqual({n:1});
},120000);
