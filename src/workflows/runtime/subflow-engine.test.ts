import { canonicalJson } from './effect-context';
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
import {EmergencyController,setActiveEmergencyController} from '../../authority/emergency';
import {listWorkflowEffects,saveWorkflowEffect} from '../db/repos/workflow-effect';
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
import {resumeCompletedChildRuns} from './child-run-scheduler';
import {resumeSubflowCalls} from '../db/repos/subflow';
import {parentTestGraph,childTestGraph} from './subflow-test-data';
import {configuredSubflowGraphs,validateSubflowFixtures} from './subflow-fixtures';
import {HUMAN_INPUT_PIECE} from './human-input-contract';
import {listHumanInputs,resolveHumanInput,resumeHumanInputs} from './human-input';
import {SUBFLOW_PIECE} from './subflow-contract';
import {projectFailure} from '../../failures/projection';
import {JarvisWorkflowRunnerAdapter} from '../adapters/workflow-runner';

let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,catalog:PieceCatalog,authority:AuthorityEngine,approvals:ApprovalManager;
let services:ReturnType<typeof buildSandboxServiceBackends>;
const runIds:string[]=[];
let now=Date.now(),mode='success';
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-subflow-engine-'));initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));
 const bundle=await buildEngineBundle(),path=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/subflow');await buildPiece(path);
 const inputPath=join(import.meta.dir,'../activepieces/packages/pieces/jarvis/input');await buildPiece(inputPath);
 const inputMeta=JSON.parse(readFileSync(join(inputPath,'package.json'),'utf8')),inputInstalled=join(dir,'node_modules',inputMeta.name);mkdirSync(dirname(inputInstalled),{recursive:true});symlinkSync(join(inputPath,'dist'),inputInstalled,'dir');
 const delayPath=join(import.meta.dir,'../activepieces/packages/pieces/core/delay');await buildPiece(delayPath);
 const delayMeta=JSON.parse(readFileSync(join(delayPath,'package.json'),'utf8')),delayInstalled=join(dir,'node_modules',delayMeta.name);mkdirSync(dirname(delayInstalled),{recursive:true});symlinkSync(join(delayPath,'dist'),delayInstalled,'dir');
 const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8')),installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 authority=new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'});approvals=new ApprovalManager();
 services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),authorityEngine:authority,approvalManager:approvals,emergencyController:new EmergencyController(),auditTrail:new AuditTrail(),eventBuffer:new WorkflowEventBuffer(),subflowNow:()=>now,llmManager:{chat:async()=>{throw Error('No model calls');}} as any,channelService:{} as any,wsService:{} as any});
 const returned=services.subflowResult!;
 services.subflowResult=async(input,ctx)=>{
  if(mode==='failure')throw Error('Synthetic child failure');
  return returned(mode==='invalid'?{result:{unexpected:true}}:input,ctx);
 };
 api=new SandboxApi({services});await api.start({port:0});runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'subflow-metadata',projectId:DEFAULT_IDS.project});try{const entries=[metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:inputMeta.name,pieceVersion:inputMeta.version})),metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:meta.name,pieceVersion:meta.version})),metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:delayMeta.name,pieceVersion:delayMeta.version}))];catalog=new PieceCatalog(entries);configureWorkflowReadiness({pieces:catalog});if(process.env.JARVIS_SUBFLOW_CATALOG_EXPORT)writeFileSync(process.env.JARVIS_SUBFLOW_CATALOG_EXPORT,JSON.stringify(entries));}finally{await handle.release();}
 worker=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime),now:()=>now})}});
},120_000);
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();setEncryptionKey(null);for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
const payload={request_id:'fixture-request',id:' customer-1 ',name:' Fixture Customer ',email:' CUSTOMER@EXAMPLE.INVALID '};
async function run(flowId:string,flowVersionId:string,input:any=payload){const r=createFlowRun({flowId,flowVersionId});runIds.push(r.id);enqueue({jobType:RUN_FLOW,payload:{runId:r.id,payload:input},flowId,flowRunId:r.id});await worker.drain();for(const child of listRuns({limit:500}).filter(x=>x.parentRunId))if(!runIds.includes(child.id))runIds.push(child.id);return getFlowRun(r.id)!;}
async function fixture(originalParent=parentTestGraph('placeholder-only-in-fixture'),originalChild=childTestGraph(),timeoutChild=false){
 mode='success';now=Date.now();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const g=configuredSubflowGraphs(originalParent,originalChild);
 if(timeoutChild)g.child.nextAction={name:'delay',type:'PIECE',settings:{pieceName:'@activepieces/piece-delay',pieceVersion:'0.3.27',actionName:'delayFor',input:{unit:'seconds',delayFor:120}},nextAction:g.child.nextAction};
 const child=createFlow(),cv=createDraftVersion({flowId:child.id,displayName:'Fixture child',trigger:g.child});lockVersion(cv.id);setPublishedVersion(child.id,cv.id);updateFlowStatus(child.id,'ENABLED');
 g.parent.nextAction.settings.input.flow=child.id;const parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Fixture parent',trigger:g.parent});expect(versionReadiness(parent.id,pv.id).issues).toEqual([]);lockVersion(pv.id);setPublishedVersion(parent.id,pv.id);updateFlowStatus(parent.id,'ENABLED');
 return {parent,pv,child,cv,run:(input?:any)=>run(parent.id,pv.id,input),children:()=>listRuns({flowId:child.id})};
}
async function finish(id:string){
 // Engine log completion and child continuation admission are separate durable writes.
 for(let attempt=0;attempt<100;attempt++){
  resumeSubflowCalls(now);await worker.drain();const run=getFlowRun(id)!;
  if(!['PAUSED','QUEUED','RUNNING'].includes(run.status))return run;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 return getFlowRun(id)!;
}
function consume(run:any,node='consume'){return run.steps?.[node]?.output?.output;}
test('saves both disabled drafts with setup required and tests both via public tool',async()=>{
 const child=createFlow(),cv=createDraftVersion({flowId:child.id,displayName:'Saved child',trigger:childTestGraph()}),parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Saved parent',trigger:parentTestGraph(child.id)});
 for(const [flow,version]of [[child,cv],[parent,pv]] as const){expect(flow.status).toBe('DISABLED');expect(flow.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);expect(compileWorkflow(version.trigger,{pieces:catalog,phase:'composition'}).ready).toBe(true);expect(versionReadiness(flow.id,version.id).ready).toBe(false);}
 const tool=createManageWorkflowTool({pieceRegistry:catalog}),result=String(await tool.execute({action:'validate_fixtures',flow:parent.id}));expect(result).toContain('"passed":true');expect(result).toContain('"childFlowId":"'+child.id+'"');expect(result).toContain('"externalActions":0');
});
for(const scenario of ['success','invalid','failure','timeout'])test('real parent/child worker: '+scenario,async()=>{
 const f=await fixture(undefined,undefined,scenario==='timeout');mode=scenario;const first=await f.run();expect(first.status).toBe('PAUSED');expect(f.children()).toHaveLength(1);
 if(scenario==='timeout'){expect(f.children()[0]!.status).toBe('PAUSED');now+=60_000;new TimerWaitpointScheduler().tick(now);await worker.drain();}
 const final=await finish(first.id);expect(final.status).toBe(scenario==='success'?'SUCCEEDED':'FAILED');
 if(scenario==='success')expect(consume(final)).toEqual({valid:true,customer:{id:'customer-1',name:'Fixture Customer',email:'customer@example.invalid'},issues:[]});
 else expect(final.failedStep?.errorMessage).toContain(scenario==='invalid'?'different shape':scenario==='failure'?'failed':'did not finish');
 const replay=await f.run();expect(replay.status).toBe(final.status);expect(f.children()).toHaveLength(1);
},60_000);
// The daemon wires the worker's job-settled hook to the scheduler, so a parent continues when its child ends without waiting for the poll.
async function runWithSettleHook(flowId:string,versionId:string){
 const scheduler=new TimerWaitpointScheduler();
 const hooked=new Worker({log:()=>{},handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime),now:()=>now})},onJobSettled:job=>{scheduler.afterJobSettled(job);}});
 const r=createFlowRun({flowId,flowVersionId:versionId});runIds.push(r.id);enqueue({jobType:RUN_FLOW,payload:{runId:r.id,payload},flowId,flowRunId:r.id});
 await hooked.drain();
 for(const child of listRuns({limit:500}).filter(x=>x.parentRunId))if(!runIds.includes(child.id))runIds.push(child.id);
 return getFlowRun(r.id)!;
}
for(const scenario of ['success','invalid'])test('a parent continues as soon as its child ends, with no poll: '+scenario,async()=>{
 const f=await fixture();mode=scenario;
 const final=await runWithSettleHook(f.parent.id,f.pv.id);
 expect(final.status).toBe(scenario==='success'?'SUCCEEDED':'FAILED');
 if(scenario==='invalid')expect(final.failedStep?.errorMessage).toMatch(/invalid_output|different shape/);
});
test('without the settle hook the poll still continues a parent after a restart',async()=>{
 const f=await fixture(),first=await f.run();expect(first.status).toBe('PAUSED');
 new TimerWaitpointScheduler().tick(now);await worker.drain();
 expect(getFlowRun(first.id)!.status).toBe('SUCCEEDED');
});
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
test('canceling parent also cancels its waiting child',async()=>{const f=await fixture(undefined,undefined,true);mode='timeout';const first=await f.run();expect(cancelFlowRun(first.id).accepted).toBe(true);expect(f.children()[0]!.status).toBe('STOPPED');expect(resumeSubflowCalls(now)).toBe(0);});
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
  const f=await fixture(saved.parent,saved.child,scenario==='timeout');mode=scenario==='restart'?'success':scenario;const first=await f.run();expect(first.status).toBe('PAUSED');
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
 mode='success';authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});const final=await finish((await run(p.id,pv.id)).id);expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('did not send back a result');
});
test('completion before deadline survives downtime beyond the deadline',async()=>{const f=await fixture(),first=await f.run();now+=120_000;expect((await finish(first.id)).status).toBe('SUCCEEDED');});
test('child completed at the deadline is a timeout',async()=>{const f=await fixture(),first=await f.run();const c=f.children()[0]!;getWorkflowDb().run('UPDATE flow_run SET finish_time=? WHERE id=?',[now+60_000,c.id]);now+=60_000;const final=await finish(first.id);expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('did not finish');});
test('child completion cannot be forged by another step',async()=>{const f=await fixture(),r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);await expect(services.subflowResult!({result:{}},{runId:r.id,projectId:DEFAULT_IDS.project,stepName:f.pv.trigger.nextAction!.name,executionPath:[]})).rejects.toThrow('pinned version');});
test('Authority approval pins the child version before dispatch',async()=>{
 const f=await fixture();authority.setGovernedCategories(['spawn_agent']);const r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);
 const node:any=f.pv.trigger.nextAction,ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>},input={...node.settings.input,invocationKey:'fixture-request',payload};
 const pending=await services.subflowCall!(input,ctx) as any;expect(pending.approval).toBeDefined();expect(f.children()).toHaveLength(0);
 approvals.approve(pending.approval.approvalId,'fixture');const result=await services.subflowCall!(input,ctx) as any;expect(result.waitpointId).toBeDefined();expect(f.children()).toHaveLength(1);
});

test('a settled child continues its parent through the continuation claim, and not while Jarvis is paused',async()=>{
 const f=await fixture(),first=await f.run();expect(first.status).toBe('PAUSED');expect(f.children()[0]!.status).toBe('SUCCEEDED');
 const controller=new EmergencyController();controller.pause();setActiveEmergencyController(controller);
 try{expect(resumeSubflowCalls(now)).toBe(0);expect(getWorkflowDb().query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status='QUEUED'").all(first.id)).toHaveLength(0);}
 finally{setActiveEmergencyController(null);}
 expect(resumeSubflowCalls(now)).toBe(1);
 const job=getWorkflowDb().query("SELECT payload FROM workflow_job WHERE flow_run_id=? AND status='QUEUED'").get(first.id) as {payload:string};
 const [wait]=listWaitpointsByFlowRun(first.id);expect(JSON.parse(job.payload).waitpointId).toBe(wait!.id);
 await worker.drain();expect(getFlowRun(first.id)!.status).toBe('SUCCEEDED');
});
test('a child stopped at the deadline reports the approval cards the stop closed',async()=>{
 const f=await fixture(undefined,undefined,true);mode='timeout';const first=await f.run(),child=f.children()[0]!;expect(child.status).toBe('PAUSED');
 const card=approvals.createRequest({agentId:'workflow:'+child.id,agentName:'Fixture child',toolName:'workflow_start',toolArguments:{},actionCategory:'spawn_agent',urgency:'normal',reason:'fixture',context:'{}',executionMode:'workflow'});
 saveWorkflowEffect({id:'fixture-child-card-'+child.id,runId:child.id,projectId:DEFAULT_IDS.project,flowId:f.child.id,versionId:f.cv.id,versionDigest:'',stepName:'returned',executionPath:[],route:'fixture',toolName:'workflow_start',actionCategory:'spawn_agent',requestDigest:'',arguments:{},target:{},provenance:{},decision:'approval_required',reason:'fixture',status:'pending',approvalId:card.id,waitpointId:null,createdAt:now});
 const heard:string[]=[];now+=60_000;resumeSubflowCalls(now,id=>heard.push(id));
 expect(getFlowRun(child.id)!.status).toBe('STOPPED');expect(approvals.getRequest(card.id)!.status).toBe('denied');expect(heard).toEqual([card.id]);
 await worker.drain();await finish(first.id);
});
test('a parent cannot call itself as a reusable child',async()=>{
 const p=createFlow(),graph=parentTestGraph('');graph.nextAction.settings.input.flow=p.id;graph.nextAction.settings.input.invocationKey='{{trigger.request_id}}';
 const pv=createDraftVersion({flowId:p.id,displayName:'Self caller',trigger:graph});lockVersion(pv.id);expect(()=>setPublishedVersion(p.id,pv.id)).toThrow('recursive cycle');
 mode='success';authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 expect((await run(p.id,pv.id)).status).toBe('FAILED');expect(listRuns({flowId:p.id})).toHaveLength(1);
});
test('the approval card names the child workflow it starts',async()=>{
 const f=await fixture();authority.setGovernedCategories(['spawn_agent']);const r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);
 const node:any=f.pv.trigger.nextAction,ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>};
 const pending=await services.subflowCall!({...node.settings.input,invocationKey:'card-request',payload},ctx) as any;
 expect(JSON.parse(approvals.getRequest(pending.approval.approvalId)!.context).intent).toBe('Start and wait for the workflow '+f.child.id+' named "Fixture child", with the input '+canonicalJson(payload));
});
// #1242: a child a person turned off is not started by a parent; one saved off and never turned on still is.
test('a turned-off child fails the parent step with a clear message before any approval card and starts nothing',async()=>{
 const f=await fixture();updateFlowStatus(f.child.id,'DISABLED');authority.setGovernedCategories(['spawn_agent']);const cards=approvals.getPending().length;
 expect(versionReadiness(f.parent.id,f.pv.id).issues.map(i=>i.message)).toContainEqual(expect.stringContaining('Target workflow is turned off'));
 const r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);
 const node:any=f.pv.trigger.nextAction,ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>};
 await expect(services.subflowCall!({...node.settings.input,invocationKey:'off-request',payload},ctx)).rejects.toThrow('Child workflow is turned off');
 expect(approvals.getPending()).toHaveLength(cards);expect(f.children()).toHaveLength(0);
 updateFlowStatus(f.child.id,'ENABLED');expect(versionReadiness(f.parent.id,f.pv.id).issues).toEqual([]);
});
test('a child turned off after its call was approved is refused at dispatch',async()=>{
 const f=await fixture();authority.setGovernedCategories(['spawn_agent']);const r=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(r.id);
 const node:any=f.pv.trigger.nextAction,ctx={runId:r.id,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>};
 const pending=await services.subflowCall!({...node.settings.input,invocationKey:'approved-request',payload},ctx) as any;expect(pending.approval).toBeDefined();
 updateFlowStatus(f.child.id,'DISABLED');approvals.approve(pending.approval.approvalId,'fixture');
 await expect(services.subflowCall!({...node.settings.input,invocationKey:'approved-request',payload},ctx)).rejects.toThrow('Child workflow is turned off');
 expect(f.children()).toHaveLength(0);
 // Recorded as a definite refusal before anything started, not as an uncertain dispatch.
 expect(listWorkflowEffects(r.id)[0]!.outcome).toMatchObject({status:'blocked',code:'FLOW_TURNED_OFF',effect:'not_started'});
 // Turned on again: this run's step keeps its refusal, never "may have occurred"; a later run calls the child.
 updateFlowStatus(f.child.id,'ENABLED');
 await expect(services.subflowCall!({...node.settings.input,invocationKey:'approved-request',payload},ctx)).rejects.toThrow('Child workflow is turned off');
 const later=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(later.id);const laterCtx={...ctx,runId:later.id};
 let again:any=await services.subflowCall!({...node.settings.input,invocationKey:'approved-request',payload},laterCtx);
 if(again.approval){approvals.approve(again.approval.approvalId,'fixture');again=await services.subflowCall!({...node.settings.input,invocationKey:'approved-request',payload},laterCtx);}
 expect(again.approval).toBeUndefined();expect(f.children()).toHaveLength(1);
});
test('a repeated invocation key with different data is refused as not started, with a typed code',async()=>{
 const f=await fixture();authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const node:any=f.pv.trigger.nextAction,call=(runId:string,data:unknown)=>services.subflowCall!({...node.settings.input,invocationKey:'lc-const',payload:data},{runId,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[] as Array<[string,number]>});
 const first=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'}),second=createFlowRun({flowId:f.parent.id,flowVersionId:f.pv.id,status:'RUNNING'});runIds.push(first.id,second.id);
 await call(first.id,payload);
 await expect(call(second.id,{...(payload as object),other:2})).rejects.toThrow('Include something that changes per item');
 expect(listWorkflowEffects(second.id)[0]!.outcome).toMatchObject({status:'blocked',code:'INVOCATION_KEY_REUSED',effect:'not_started'});
 expect(projectFailure({source:'action',outcome:listWorkflowEffects(second.id)[0]!.outcome! as any},{label:'The step "child"',sideEffects:true}))
  .toMatchObject({code:'INVOCATION_KEY_REUSED',effect:'none',next:[{step:'edit_and_run_again'},{step:'open_details'}]});
});
test('a published child saved off and never turned on is still called',async()=>{
 const g=configuredSubflowGraphs(parentTestGraph('placeholder-only-in-fixture'),childTestGraph());mode='success';authority.updateConfig({...authority.getConfig(),overrides:[],governed_categories:[]});
 const child=createFlow(),cv=createDraftVersion({flowId:child.id,displayName:'Never on',trigger:g.child});lockVersion(cv.id);setPublishedVersion(child.id,cv.id);
 expect(getFlow(child.id)).toMatchObject({status:'DISABLED',disabled_at:null});
 g.parent.nextAction.settings.input.flow=child.id;const parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Calls never-on child',trigger:g.parent});
 expect(versionReadiness(parent.id,pv.id).issues).toEqual([]);lockVersion(pv.id);setPublishedVersion(parent.id,pv.id);
 const first=await run(parent.id,pv.id);expect(listRuns({flowId:child.id})).toHaveLength(1);expect((await finish(first.id)).status).toBe('SUCCEEDED');
});
test('run_workflow, through the same dispatch, refuses a turned-off target',async()=>{
 const g=configuredSubflowGraphs(parentTestGraph('placeholder-only-in-fixture'),childTestGraph());
 const off=createFlow(),ov=createDraftVersion({flowId:off.id,displayName:'Off target',trigger:g.child});lockVersion(ov.id);setPublishedVersion(off.id,ov.id);
 getWorkflowDb().run("UPDATE flow SET status='DISABLED', disabled_at=? WHERE id=?",[Date.now(),off.id]);
 expect(()=>new JarvisWorkflowRunnerAdapter().startNow({flowId:off.id},undefined,DEFAULT_IDS.project)).toThrow(expect.objectContaining({code:'FLOW_TURNED_OFF'}));
 expect(listRuns({flowId:off.id})).toHaveLength(0);
});

for (const value of [
 {approval:true,amount:0},
 {waitpointId:'business-reference-123',active:false},
 {status:'pending',approval:{waitpointId:'business-approval'},result:{waitpointId:'nested'}},
]) test('business result keys are data through real child completion and parent replay: '+JSON.stringify(value),async()=>{
 const f=await fixture();
 const childGraph=structuredClone(f.cv.trigger);
 childGraph.nextAction!.nextAction!.settings!.input={result:value};
 const cv=createDraftVersion({flowId:f.child.id,displayName:'Business result',trigger:childGraph});lockVersion(cv.id);setPublishedVersion(f.child.id,cv.id);
 const parentGraph=structuredClone(f.pv.trigger);parentGraph.nextAction!.settings!.input!.outputSchema={type:'object'};
 const pv=createDraftVersion({flowId:f.parent.id,displayName:'Consume business result',trigger:parentGraph});lockVersion(pv.id);setPublishedVersion(f.parent.id,pv.id);
 const first=await run(f.parent.id,pv.id);
 expect(f.children()).toHaveLength(1);expect(f.children()[0]!.status).toBe('SUCCEEDED');
 expect(listWaitpointsByFlowRun(f.children()[0]!.id)).toHaveLength(0);
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});
 const final=await finish(first.id);expect(final.status).toBe('SUCCEEDED');expect(consume(final)).toEqual(value);
 const replay=await run(f.parent.id,pv.id);expect(replay.status).toBe('SUCCEEDED');expect(consume(replay)).toEqual(value);expect(f.children()).toHaveLength(1);
});

async function sharedApprovalFixture() {
 const f=await fixture();
 const graph=structuredClone(f.cv.trigger);
 graph.nextAction={name:'review',type:'PIECE',settings:{pieceName:HUMAN_INPUT_PIECE,pieceVersion:'0.0.1',actionName:'request_approval',input:{title:'Shared child review',prompt:'Approve this synthetic child',requestKey:'review',timeoutHours:1}},nextAction:graph.nextAction};
 const cv=createDraftVersion({flowId:f.child.id,displayName:'Shared child approval',trigger:graph});lockVersion(cv.id);setPublishedVersion(f.child.id,cv.id);
 return f;
}
for(const canceledIndex of [0,1]) test(`cancel shared parent ${canceledIndex}: the surviving parent can approve after database reopen`,async()=>{
 const f=await sharedApprovalFixture(),parents=[await f.run(),await f.run()],child=f.children()[0]!;
 expect(parents.map(r=>r.status)).toEqual(['PAUSED','PAUSED']);expect(f.children()).toHaveLength(1);expect(child.status).toBe('PAUSED');
 expect(cancelFlowRun(parents[canceledIndex]!.id).accepted).toBe(true);
 resumeCompletedChildRuns();
 expect(getFlowRun(child.id)?.status).toBe('PAUSED');
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));setEncryptionKey(Buffer.alloc(32,79));configureWorkflowReadiness({pieces:catalog});
 resumeCompletedChildRuns();
 const request=listHumanInputs(DEFAULT_IDS.project).find(r=>r.runId===child.id)!;
 expect(request.status).toBe('pending');expect(resolveHumanInput(DEFAULT_IDS.project,request.id,{decision:'approve',generation:request.generation??0}).status).toBe(200);
 resumeHumanInputs();await worker.drain();expect(getFlowRun(child.id)?.status).toBe('SUCCEEDED');
 expect((await finish(parents[1-canceledIndex]!.id)).status).toBe('SUCCEEDED');expect(getFlowRun(parents[canceledIndex]!.id)?.status).toBe('STOPPED');expect(f.children()).toHaveLength(1);
});
for(const order of [[0,1],[1,0]]) test(`last shared parent cancellation closes child and approval: ${order}`,async()=>{
 const f=await sharedApprovalFixture(),parents=[await f.run(),await f.run()],child=f.children()[0]!;
 cancelFlowRun(parents[order[0]!]!.id);expect(getFlowRun(child.id)?.status).toBe('PAUSED');
 cancelFlowRun(parents[order[1]!]!.id);expect(getFlowRun(child.id)?.status).toBe('STOPPED');
 expect(listHumanInputs(DEFAULT_IDS.project).find(r=>r.runId===child.id)?.status).toBe('cancelled');
 resumeSubflowCalls(now);
 for(const parent of parents)expect(getWorkflowDb().query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status='QUEUED'").all(parent.id)).toHaveLength(0);
});
test('explicit child cancellation still stops a child shared by live parents',async()=>{
 const f=await sharedApprovalFixture(),parents=[await f.run(),await f.run()],child=f.children()[0]!;
 expect(cancelFlowRun(child.id).accepted).toBe(true);expect(getFlowRun(child.id)?.status).toBe('STOPPED');
 for(const parent of parents)expect((await finish(parent.id)).status).toBe('FAILED');
});

// The call step itself fails by default; the later require_success step is not what makes the run fail.
async function callOnly(options:{continueOnChildFailure?:boolean}={},noReturn=false){
 const f=await fixture(),g=configuredSubflowGraphs(parentTestGraph('x'),childTestGraph());
 const child=createFlow();let childGraph=g.child;if(noReturn)delete childGraph.nextAction.nextAction;
 const cv=createDraftVersion({flowId:child.id,displayName:'Customer checker',trigger:childGraph});lockVersion(cv.id);setPublishedVersion(child.id,cv.id);updateFlowStatus(child.id,'ENABLED');
 g.parent.nextAction.settings.input.flow=child.id;if(options.continueOnChildFailure!==undefined)g.parent.nextAction.settings.input.continueOnChildFailure=options.continueOnChildFailure;delete g.parent.nextAction.nextAction;
 const parent=createFlow(),pv=createDraftVersion({flowId:parent.id,displayName:'Call only',trigger:g.parent});lockVersion(pv.id);setPublishedVersion(parent.id,pv.id);updateFlowStatus(parent.id,'ENABLED');
 return {run:()=>run(parent.id,pv.id),f};
}
test('a failing child fails the calling step and the run by default, naming the child',async()=>{
 const c=await callOnly();mode='failure';const final=await finish((await c.run()).id);
 expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('The workflow "Customer checker" failed');expect(final.failedStep?.errorMessage).not.toContain('CHILD_FAILED');
});
test('a child that returns nothing fails the calling step by default',async()=>{
 const c=await callOnly({},true);const final=await finish((await c.run()).id);
 expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('The workflow "Customer checker" finished but did not send back a result');
});
test('a child result that does not match the schema fails the calling step by default',async()=>{
 const c=await callOnly();mode='invalid';const final=await finish((await c.run()).id);
 expect(final.status).toBe('FAILED');expect(final.failedStep?.errorMessage).toContain('different shape than this step expects');
});
test('continueOnChildFailure keeps the parent green and returns the status object',async()=>{
 for(const [scenario,status,code] of [['failure','failed','CHILD_FAILED'],['invalid','invalid_output','CHILD_RESULT_INVALID']] as const){
  const c=await callOnly({continueOnChildFailure:true});mode=scenario;const final=await finish((await c.run()).id);
  expect(final.status).toBe('SUCCEEDED');expect((final.steps as any)?.child?.output?.output).toMatchObject({status,code});
 }
 const none=await callOnly({continueOnChildFailure:true},true),final=await finish((await none.run()).id);
 expect(final.status).toBe('SUCCEEDED');expect((final.steps as any)?.child?.output?.output).toMatchObject({status:'invalid_output',code:'CHILD_RESULT_MISSING'});
});
