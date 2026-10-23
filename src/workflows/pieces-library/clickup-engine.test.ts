/** Actual npm piece in the real engine. Only its provider base URL is replaced
 * in a disposable copy; no live ClickUp calls or account credentials are used.
 * Run JARVIS_TEST_CLICKUP_ENGINE=1 bun test this-file (installs pinned 0.9.1). */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {initWorkflowDb, closeWorkflowDb, DEFAULT_IDS} from '../db';
import {createFlow} from '../db/repos/flow';
import {createDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {CredentialResolver} from '../credentials/adapter';
import {JarvisClickUpConnectionSource} from '../credentials/clickup-source';
import {AuthorityEngine} from '../../authority/engine';
import {ApprovalManager} from '../../authority/approval';
import {AuditTrail} from '../../authority/audit';
import {EmergencyController} from '../../authority/emergency';
import {WorkflowEventBuffer} from '../runtime/event-buffer';
import {buildSandboxServiceBackends} from '../runtime/service-backends';
import {buildPieceCatalog} from '../runtime/piece-catalog';
import {SandboxApi} from '../sandbox-api/server';
import {workflowLogsBase} from '../sandbox-api/config';
import {buildEngineBundle} from '../runner/engine-runtime/build';
import {EngineRuntime} from '../runner/engine-runtime/engine-runtime';
import {EngineFlowExecutor} from '../runner/engine-runtime/engine-flow-executor';
import {createRunFlowHandler} from '../runner/handler';
import {Worker} from '../queue/worker';
const gate=process.env.JARVIS_TEST_CLICKUP_ENGINE==='1';
const piece='@activepieces/piece-clickup';
let dir:string, api:SandboxApi, runtime:EngineRuntime, provider:ReturnType<typeof Bun.serve>;
let runId:string|undefined;
const requests:Array<{method:string;path:string;body:unknown;auth:string|null}>=[];
let task:Record<string,unknown>={};
beforeAll(async()=>{
 if(!gate)return;
 dir=mkdtempSync(join(tmpdir(),'jarvis-clickup-engine-'));
 initWorkflowDb(join(dir,'db.sqlite'));
 writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,dependencies:{[piece]:'0.9.1'}}));
 const install=spawnSync('bun',['install','--silent','--backend','copy'],{cwd:dir,encoding:'utf8'});
 if(install.status!==0)throw new Error('npm install failed: '+install.stderr);
 provider=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  const body=['POST','PUT'].includes(req.method)?await req.json():null;
  requests.push({method:req.method,path,body,auth:req.headers.get('authorization')});
  if(req.headers.get('authorization')!=='Bearer ENGINE_ONLY_CLICKUP')return Response.json({err:'unauthorized'},{status:401});
  if(req.method==='POST'&&path==='/api/v2/list/list1/task') task={id:'task1',name:(body as any).name,url:'https://app.clickup.com/t/task1',status:{status:'to do',type:'open'},list:{id:'list1',name:'Sandbox'}};
  else if(req.method==='PUT'&&path==='/api/v2/task/task1') task={...task,...body as object};
  else if(req.method==='GET'&&path==='/api/v2/list/list1/task')return Response.json({tasks:[task]});
  else if(!(req.method==='GET'&&path==='/api/v2/task/task1'))return Response.json({err:'unknown route'},{status:404});
  return Response.json(task);
 }});
 const bundleFile=join(dir,'node_modules',piece,'src/index.js');
 const published=readFileSync(bundleFile,'utf8');
 expect(published.split('https://api.clickup.com/api/v2').length-1).toBe(7);
 writeFileSync(bundleFile+'.fixture',published.replaceAll('https://api.clickup.com/api/v2',`http://127.0.0.1:${provider.port}/api/v2`));
 renameSync(bundleFile+'.fixture',bundleFile); // Break any package-cache hardlink before replacing the bytes.
 mkdirSync(join(dir,'connections'));
 writeFileSync(join(dir,'connections/clickup.json'),JSON.stringify({version:1,provider:'clickup',status:'connected',generation:randomUUID(),access_token:'ENGINE_ONLY_CLICKUP',account:{id:'7',label:'Sandbox owner'},workspaces:[{id:'8',name:'Sandbox'}],connected_at:new Date().toISOString()}));
 const resolver=new CredentialResolver();resolver.register(new JarvisClickUpConnectionSource(dir));
 api=new SandboxApi({services:buildSandboxServiceBackends({credentialResolver:resolver,llmManager:{} as any,channelService:{} as any,wsService:{} as any,eventBuffer:new WorkflowEventBuffer(),approvalManager:new ApprovalManager(),auditTrail:new AuditTrail(),emergencyController:new EmergencyController(),authorityEngine:new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'})})});
 await api.start({port:0});
 const bundle=await buildEngineBundle();
 runtime=new EngineRuntime({api,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code'),egressPolicy:'private-allowed'});
},120000);
afterAll(async()=>{
 if(!gate)return;
 await runtime?.shutdown();await api?.stop();provider?.stop(true);closeWorkflowDb();
 if(runId)rmSync(join(workflowLogsBase(),runId+'.bin'),{force:true});
 if(dir)rmSync(dir,{recursive:true,force:true});
});
test.skipIf(!gate)('catalog extraction and create/read/update/find through actual engine, managed credential and downstream references',async()=>{
 const {catalog,failures}=await buildPieceCatalog({runtime,pieceRoots:[join(dir,'node_modules/@activepieces')],projectId:DEFAULT_IDS.project,pieceTimeoutMs:30000,overallTimeoutMs:45000});
 expect(failures).toEqual([]);
 const metadata=catalog.get(piece)!;
 expect(metadata.auth?.type).toBe('OAUTH2');
 for(const name of ['create_task','get_list_task','update_task','get_task_by_name']){
  expect(metadata.actions[name]?.requireAuth).toBe(true);
  expect(metadata.actions[name]?.outputSample).toMatchObject({id:'task_example'});
 }
 const step=(name:string,actionName:string,input:Record<string,unknown>,nextAction?:any)=>({name,type:'PIECE' as const,settings:{pieceName:piece,pieceVersion:'0.9.1',actionName,...(actionName==='create_task'?{propertySettings:{custom_fields:{schema:{}}}}:{}),input:{auth:'{{connections.jarvis:clickup}}',...input}},...(nextAction?{nextAction}:{})});
 const find=step('find','get_task_by_name',{workspace_id:'8',space_id:'space1',list_id:'list1',task_name:'Updated by Jarvis'});
 const update=step('update','update_task',{workspace_id:'8',space_id:'space1',list_id:'list1',task_id:'{{read.id}}',name:'Updated by Jarvis'},find);
 const read=step('read','get_list_task',{task_id:'{{create.id}}'},update);
 const create=step('create','create_task',{workspace_id:'8',space_id:'space1',list_id:'list1',name:'Created by Jarvis',description:'Sandbox only',custom_fields:{},check_required_custom_fields:true},read);
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'ClickUp qualification',trigger:{name:'trigger',type:'EMPTY',nextAction:create}});
 const run=createFlowRun({flowId:flow.id,flowVersionId:version.id});runId=run.id;
 const worker=new Worker({log:()=>{},handlers:{RUN_FLOW:createRunFlowHandler({executor:new EngineFlowExecutor(runtime,{terminalTimeoutMs:5000})})}});
 enqueue({jobType:'RUN_FLOW',flowRunId:run.id,maxAttempts:1,payload:{runId:run.id}});await worker.drain();
 const complete=getFlowRun(run.id)!;
 expect({status:complete.status,steps:complete.steps}).toMatchObject({status:'SUCCEEDED'});
 expect(requests.map(r=>r.method+' '+r.path)).toEqual(['POST /api/v2/list/list1/task','GET /api/v2/task/task1','PUT /api/v2/task/task1','GET /api/v2/list/list1/task']);
 expect((complete.steps?.find as any).output.output).toMatchObject({id:'task1',name:'Updated by Jarvis'});
 expect(JSON.stringify(complete.steps)).not.toContain('ENGINE_ONLY_CLICKUP');
},90000);
