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
import {getWorkflowDb} from '../db';
import {createWaitpoint} from '../db/repos/waitpoint';
import {cancelFlowRun} from '../db/repos/run-cancellation';
import {resumeSubflowCalls} from '../db/repos/subflow';
import {parentTestGraph,childTestGraph} from './subflow-test-data';
import {configuredSubflowGraphs,validateSubflowFixtures} from './subflow-fixtures';
import {SUBFLOW_PIECE} from './subflow-contract';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const runIds:string[]=[];
let now=Date.now(),mode='success';
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-subflow-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));
 const bundle=await buildEngineBundle(),path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/subflow');await buildPiece(path);
 const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8')),installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),subflowNow:()=>now,llmManager:{chat:async()=>{throw Error('No model calls');}} as any,channelService:{} as any,wsService:{} as any});
 const returned=services.subflowResult!;
 services.subflowResult=async(input,ctx)=>{
  if(mode==='failure')throw Error('Synthetic child failure');
  if(mode==='timeout'){const w=createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName:ctx.stepName!,type:'TIMER',resumeDateTime:new Date(now+120_000).toISOString()});return {waitpointId:w.id};}
  return returned(mode==='invalid'?{result:{unexpected:true}}:input,ctx);
 };
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'subflow-metadata',projectId:DEFAULT_IDS.project});try{const entries=[metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:meta.name,pieceVersion:meta.version}))];catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_SUBFLOW_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_SUBFLOW_CATALOG_EXPORT,JSON.stringify(entries));}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime),now:()=>now})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
const payload={request_id:'fixture-request',id:' customer-1 ',name:' Fixture Customer ',email:' CUSTOMER@EXAMPLE.INVALID '};
async function run(flowId:string,flowVersionId:string,input:any=payload){const r=createFlowRun({flowId,flowVersionId});runIds.push(r.id);enqueue({jobType:RUN_FLOW,payload:{runId:r.id,payload:input},flowId,flowRunId:r.id});await worker.drain();for(const child of listRuns({limit:500}).filter(x=>x.parentRunId))if(!runIds.includes(child.id))runIds.push(child.id);return getFlowRun(r.id)!;}
async function fixture(originalParent=parentTestGraph('placeholder-only-in-fixture'),originalChild=childTestGraph()){
 mode='success';now=Date.now();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const g=configuredSubflowGraphs(originalParent,originalChild),child=createFlow(),cv=createDraftVersion({flowId:child.id,displayName:'Fixture child',trigger:g.child});lockVersion(cv.id);setPublishedVersion(child.id,cv.id);updateFlowStatus(child.id,'ENABLED');
 g.parent.nextAction.settings.input.flow=child.id;const parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Fixture parent',trigger:g.parent});expect(versionReadiness(parent.id,pv.id).issues).toEqual([]);lockVersion(pv.id);setPublishedVersion(parent.id,pv.id);updateFlowStatus(parent.id,'ENABLED');
 return {parent,pv,child,cv,run:(input?:any)=>run(parent.id,pv.id,input),children:()=>listRuns({flowId:child.id})};
}
async function finish(id:string){resumeSubflowCalls(now);await worker.drain();return getFlowRun(id)!;}
function consume(run:any,node='consume'){return run.steps?.[node]?.output?.output;}
test('saves both disabled drafts with setup required and tests both via public tool',async()=>{
 const child=createFlow(),cv=createDraftVersion({flowId:child.id,displayName:'Saved child',trigger:childTestGraph()}),parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Saved parent',trigger:parentTestGraph(child.id)});
 for(const [flow,version]of [[child,cv],[parent,pv]] as const){expect(flow.status).toBe('DISABLED');expect(flow.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);expect(compileWorkflow(version.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);expect(versionReadiness(flow.id,version.id).ready).toBe(false);}
 const tool=createManageWorkflowTool({pieceRegistry:catalog}),result=String(await tool.execute({action:'validate_fixtures',flow:parent.id}));expect(result).toContain('"passed":true');expect(result).toContain('"childFlowId":"'+child.id+'"');expect(result).toContain('"externalActions":0');
});
for(const scenario of ['success','invalid','failure','timeout'])test('real parent/child worker: '+scenario,async()=>{
 const f=await fixture();mode=scenario;const first=await f.run();expect(first.status).toBe('PAUSED');expect(f.children()).toHaveLength(1);
 if(scenario==='timeout'){expect(f.children()[0]!.status).toBe('PAUSED');now+=60_000;new TimerWaitpointScheduler().tick(now);await worker.drain();}
 const final=await finish(first.id);expect(final.status).toBe(scenario==='success'?'SUCCEEDED':'FAILED');
 if(scenario==='success')expect(consume(final)).toEqual({valid:true,customer:{id:'customer-1',name:'Fixture Customer',email:'customer@example.invalid'},issues:[]});
 else expect(final.failedStep?.errorMessage).toContain(scenario==='invalid'?'invalid_output':scenario==='failure'?'failed':'timeout');
 const replay=await f.run();expect(replay.status).toBe(final.status);expect(f.children()).toHaveLength(1);
},60_000);
test('database reopen after child completion resumes parent and reuses child on new parent run',async()=>{
 const f=await fixture(),first=await f.run();expect(first.status).toBe('PAUSED');expect(f.children()[0]!.status).toBe('SUCCEEDED');
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});
 expect((await finish(first.id)).status).toBe('SUCCEEDED');expect((await f.run()).status).toBe('SUCCEEDED');expect(f.children()).toHaveLength(1);
});
test('concurrent duplicate parents share one child and both receive its result',async()=>{
 const f=await fixture(),results=await Promise.all([f.run(),f.run()]);for(const result of results)expect((await finish(result.id)).status).toBe('SUCCEEDED');expect(f.children()).toHaveLength(1);
});
test('changed payload under the same invocation key is rejected, new key starts new child',async()=>{
 const f=await fixture();expect((await finish((await f.run()).id)).status).toBe('SUCCEEDED');expect((await f.run({...payload,name:'Changed'})).status).toBe('FAILED');expect(f.children()).toHaveLength(1);
 expect((await finish((await f.run({...payload,request_id:'new-request'})).id)).status).toBe('SUCCEEDED');expect(f.children()).toHaveLength(2);
});
test('Authority denial prevents child dispatch',async()=>{const f=await fixture();authority.addOverride({action:'spawn_agent',allowed:false});expect((await f.run()).status).toBe('FAILED');expect(f.children()).toHaveLength(0);});
test('canceling parent also cancels its waiting child',async()=>{const f=await fixture();mode='timeout';const first=await f.run();expect(cancelFlowRun(first.id).accepted).toBe(true);expect(f.children()[0]!.status).toBe('STOPPED');expect(resumeSubflowCalls(now)).toBe(0);});
test('receipt and child creation are atomic on insert failure',async()=>{
 const f=await fixture();getWorkflowDb().run("CREATE TEMP TRIGGER reject_subflow BEFORE INSERT ON workflow_subflow_call BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
 try{expect((await f.run()).status).toBe('FAILED');expect(f.children()).toHaveLength(0);}finally{getWorkflowDb().run('DROP TRIGGER reject_subflow');}
 expect((await finish((await f.run()).id)).status).toBe('SUCCEEDED');expect(f.children()).toHaveLength(1);
});
test('completed receipt survives removal of child history',async()=>{const f=await fixture();await finish((await f.run()).id);const child=f.children()[0]!;getWorkflowDb().run('DELETE FROM flow_run WHERE id=?',[child.id]);expect((await f.run()).status).toBe('SUCCEEDED');expect(f.children()).toHaveLength(0);});

test('actual model-generated saved pair exercises all five cases through the worker',async()=>{
 const saved=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/subflow-generated-test16.json'),'utf8'));
 expect((await validateSubflowFixtures(saved.parent,saved.child)).cases.every(c=>c.passed)).toBe(true);
 for(const scenario of ['success','invalid','failure','timeout','restart']){
  const f=await fixture(saved.parent,saved.child);mode=scenario==='restart'?'success':scenario;const first=await f.run();expect(first.status).toBe('PAUSED');
  if(scenario==='restart'){expect(f.children()[0]!.status).toBe('SUCCEEDED');closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});}
  if(scenario==='timeout'){now+=60_000;new TimerWaitpointScheduler().tick(now);await worker.drain();}
  const final=await finish(first.id);expect(final.status).toBe(['success','restart'].includes(scenario)?'SUCCEEDED':'FAILED');
  if(final.status==='SUCCEEDED')expect(consume(final,saved.parent.nextAction.nextAction.name)).toEqual({valid:true,customer:{id:'customer-1',name:'Fixture Customer',email:'customer@example.invalid'},issues:[]});
  expect((await f.run()).status).toBe(final.status);expect(f.children()).toHaveLength(1);
 }
},120_000);
test('invalid customer returns validation issues as structured data',async()=>{
 const f=await fixture(),final=await finish((await f.run({...payload,email:'not-an-email'})).id);expect(final.status).toBe('SUCCEEDED');expect(consume(final)).toMatchObject({valid:false,issues:['email is invalid']});
});
test('successful child with no explicit return is invalid output',async()=>{
 const child=childTestGraph();delete child.nextAction.nextAction;const c=createFlow(),cv=createDraftVersion({flowId:c.id,displayName:'No return',trigger:{name:'trigger',type:'EMPTY'}});lockVersion(cv.id);setPublishedVersion(c.id,cv.id);updateFlowStatus(c.id,'ENABLED');
 const parent=parentTestGraph(c.id);parent.nextAction.settings.input.invocationKey='{{trigger.request_id}}';const p=createFlow(),pv=createDraftVersion({flowId:p.id,displayName:'Missing result',trigger:parent});lockVersion(pv.id);setPublishedVersion(p.id,pv.id);updateFlowStatus(p.id,'ENABLED');
 mode='success';authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});const final=await finish((await run(p.id,pv.id)).id);expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('invalid_output');
});
test('completion before deadline survives downtime beyond the deadline',async()=>{const f=await fixture(),first=await f.run();now+=120_000;expect((await finish(first.id)).status).toBe('SUCCEEDED');});
test('child completed at the deadline is a timeout',async()=>{const f=await fixture(),first=await f.run();const c=f.children()[0]!;getWorkflowDb().run('UPDATE flow_run SET finish_time=? WHERE id=?',[now+60_000,c.id]);now+=60_000;const final=await finish(first.id);expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('timeout');});
test('child completion cannot be forged by another step',async()=>{const f=await fixture(),r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);await expect(services.subflowResult!({result:{}},{runId:r.id,projectId:DEFAULT_IDS.project,stepName:f.pv.trigger.nextAction!.name,executionPath:[]})).rejects.toThrow('pinned version');});
test('Authority approval pins the child version before dispatch',async()=>{
 const f=await fixture();authority.setGovernedCategories(['spawn_agent']);const r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);
 const node:any=f.pv.trigger.nextAction,ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>},input={...node.settings.input,invocationKey:'fixture-request',payload};
 const pending=await services.subflowCall!(input,ctx) as any;expect(pending.approval).toBeDefined();expect(f.children()).toHaveLength(0);
 approvals.approve(pending.approval.approvalId,'fixture');const result=await services.subflowCall!(input,ctx) as any;expect(result.waitpointId).toBeDefined();expect(f.children()).toHaveLength(1);
});
