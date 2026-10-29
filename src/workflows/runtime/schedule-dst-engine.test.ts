import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import {afterAll,afterEach,beforeAll,expect,setSystemTime,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import graph from './fixtures/daily-dst-generated.json';
import {initWorkflowDb,closeWorkflowDb,getWorkflowDb,DEFAULT_IDS} from '../db';
import {createFlow,setPublishedVersion,updateFlowStatus} from '../db/repos/flow';
import {createDraftVersion,lockVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun,listRuns} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {listWorkflowEffects} from '../db/repos/workflow-effect';
import {configureWorkflowReadiness} from '../db/repos/flow-readiness';
import {AuthorityEngine} from '../../authority/engine';
import {ApprovalManager} from '../../authority/approval';
import {DeferredExecutor} from '../../authority/deferred-executor';
import {DecisionQueue} from '../../brief/decisions';
import {AuditTrail} from '../../authority/audit';
import {EmergencyController} from '../../authority/emergency';
import {SandboxApi} from '../sandbox-api/server';
import {workflowLogsBase} from '../sandbox-api/config';
import {EngineRuntime} from '../runner/engine-runtime/engine-runtime';
import {EngineFlowExecutor} from '../runner/engine-runtime/engine-flow-executor';
import {buildEngineBundle} from '../runner/engine-runtime/build';
import {buildPiece} from '../runner/engine-runtime/build-pieces';
import {Worker} from '../queue/worker';
import {createRunFlowHandler,RUN_FLOW} from '../runner/handler';
import {TriggerManager} from '../runner/triggers/manager';
import {CronScheduler} from '../../lib/cron-scheduler';
import {WorkflowEventBus} from './event-bus';
import {buildSandboxServiceBackends} from './service-backends';
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,manager:TriggerManager,cron:CronScheduler,queue:DecisionQueue;
let outcome:'success'|'uncertain'|'failure'='success',attempts=0,versionNumber:string;
const runIds:string[]=[],flowIds:string[]=[];
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-dst-engine-'));initWorkflowDb(join(dir,'fixture.db'));
 const bundle=await buildEngineBundle(),path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/notify');await buildPiece(path);
 const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));versionNumber=meta.version;
 const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 const authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});
 const approvals=new ApprovalManager(),audit=new AuditTrail();
 const services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),eventBuffer:new WorkflowEventBuffer(),authorityEngine:authority,approvalManager:approvals,auditTrail:audit,emergencyController:new EmergencyController(),
  llmManager:{chat:async()=>{throw Error('No model access');}} as any,channelService:{sendWorkflowNotification:async()=>{throw Error('No external channels');}} as any,
  wsService:{broadcastNotificationToDashboard:()=>{attempts++;if(outcome==='uncertain')throw Error('Synthetic loss after accepted send');return outcome==='failure'?0:1;}} as any});
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'dst-metadata',projectId:DEFAULT_IDS.project});
 try{catalog=new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:meta.name,pieceVersion:meta.version}))]);}finally{await handle.release();}
 configureWorkflowReadiness({pieces:catalog});
 queue=new DecisionQueue(getWorkflowDb(),{approvalManager:approvals,deferredExecutor:new DeferredExecutor(approvals,audit)});
 wireWorker();
},120_000);
function wireWorker(){worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});}
afterEach(async()=>{setSystemTime();await manager?.stop();cron?.cancelAll();for(const id of flowIds)updateFlowStatus(id,'DISABLED');outcome='success';});
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function fixture(){const g=structuredClone(graph) as any;g.nextAction.settings.pieceVersion=versionNumber;const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Actual DST graph',trigger:g});lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');flowIds.push(flow.id);return{flow,version};}
async function start(iso:string){setSystemTime(new Date(iso));cron=new CronScheduler();manager=new TriggerManager({eventBus:new WorkflowEventBus(),cronScheduler:cron,log:()=>{}});await manager.start();}
function tick(id:string,iso:string){setSystemTime(new Date(iso));cron.runDue('flow:'+id);}
function reopen(){closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));configureWorkflowReadiness({pieces:catalog});wireWorker();const approvals=new ApprovalManager();queue=new DecisionQueue(getWorkflowDb(),{approvalManager:approvals,deferredExecutor:new DeferredExecutor(approvals,new AuditTrail())});}
async function drain(){setSystemTime();await worker.drain();}
async function replay(f:ReturnType<typeof fixture>,original:string){
 const row=getWorkflowDb().query("SELECT payload FROM workflow_job WHERE flow_run_id=? AND job_type='RUN_FLOW' LIMIT 1").get(original) as {payload:string};
 const run=createFlowRun({flowId:f.flow.id,flowVersionId:f.version.id});runIds.push(run.id);
 enqueue({jobType:RUN_FLOW,flowId:f.flow.id,flowRunId:run.id,payload:{...JSON.parse(row.payload),runId:run.id}});await drain();return getFlowRun(run.id)!;
}
test('real manager skips spring gap without creating any worker job',async()=>{
 const f=fixture(),before=attempts;await start('2026-03-29T00:58:00Z');
 for(let t=Date.parse('2026-03-29T00:59:00Z');t<=Date.parse('2026-03-29T01:32:00Z');t+=60000)tick(f.flow.id,new Date(t).toISOString());
 await drain();expect(listRuns({flowId:f.flow.id})).toHaveLength(0);expect(attempts).toBe(before);
},60000);
test('real engine first autumn send survives scheduler and SQLite/worker restart',async()=>{
 const f=fixture(),before=attempts;await start('2026-10-25T00:29:00Z');tick(f.flow.id,'2026-10-25T00:30:00Z');await drain();
 const first=listRuns({flowId:f.flow.id})[0]!;runIds.push(first.id);expect(first.status).toBe('SUCCEEDED');expect(attempts-before).toBe(1);
 await manager.stop();reopen();await start('2026-10-25T01:29:00Z');tick(f.flow.id,'2026-10-25T01:30:00Z');await drain();
 expect(listRuns({flowId:f.flow.id})).toHaveLength(1);expect(attempts-before).toBe(1);
 expect((await replay(f,first.id)).status).toBe('SUCCEEDED');expect(attempts-before).toBe(1);
},60000);
test('real queued payload keeps its scheduled date when worker starts after midnight',async()=>{
 const f=fixture();await start('2026-10-24T00:29:00Z');tick(f.flow.id,'2026-10-24T00:30:00Z');
 const first=listRuns({flowId:f.flow.id})[0]!;runIds.push(first.id);await manager.stop();setSystemTime();reopen();await worker.drain();
 expect(getFlowRun(first.id)?.status).toBe('SUCCEEDED');expect(listWorkflowEffects(first.id)[0]?.arguments.idempotencyKey).toBe('daily-operations:Europe/Rome:2026-10-24');
},60000);
test('uncertain dashboard send is a Needs you recovery item and cannot resend after worker restart',async()=>{
 const f=fixture(),before=attempts;outcome='uncertain';await start('2026-10-24T00:29:00Z');tick(f.flow.id,'2026-10-24T00:30:00Z');await drain();
 const first=listRuns({flowId:f.flow.id})[0]!;runIds.push(first.id);expect(first.status).toBe('FAILED');
 const effect=listWorkflowEffects(first.id)[0]!;expect(effect).toMatchObject({status:'unknown',outcome:{code:'NOTIFICATION_UNCONFIRMED'}});
 expect(queue.get('effect:'+effect.id)).toMatchObject({state:'unknown',supportedActions:['inspect']});
 await manager.stop();reopen();outcome='success';expect((await replay(f,first.id)).status).toBe('FAILED');expect(attempts-before).toBe(1);
 const approvals=new ApprovalManager();queue=new DecisionQueue(getWorkflowDb(),{approvalManager:approvals,deferredExecutor:new DeferredExecutor(approvals,new AuditTrail())});
 expect(queue.get('effect:'+effect.id).state).toBe('unknown');
},60000);
test('actual metadata supports saved disabled graph and public durable fixture suite',async()=>{
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Disabled daily draft',trigger:graph as any});
 const tool=createManageWorkflowTool({pieceRegistry:catalog});
 const raw=String(await tool.execute({action:'validate_fixtures',flow:flow.id,fixture_input:{suite:'dst_daily'}}));
 expect(raw).toContain('"passed":true');expect(raw).toContain(version.id);expect(raw).toContain('scheduledOccurrences');
 expect(listRuns({flowId:flow.id})).toHaveLength(0);
},60000);
