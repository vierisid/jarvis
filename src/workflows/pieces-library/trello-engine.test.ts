/** Published piece metadata/read actions plus the managed send adapter in the
 * real engine. Provider URLs in disposable package/engine copies target a
 * local fixture; no live Trello calls or account credentials are used.
 * Run JARVIS_TEST_TRELLO_ENGINE=1 bun test this-file (installs pinned 0.7.1). */
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {initWorkflowDb, closeWorkflowDb, DEFAULT_IDS} from '../db';
import {createFlow} from '../db/repos/flow';
import {createDraftVersion} from '../db/repos/flow-version';
import {createFlowRun,getFlowRun} from '../db/repos/flow-run';
import {enqueue} from '../db/repos/job-queue';
import {CredentialResolver} from '../credentials/adapter';
import {JarvisTrelloConnectionSource} from '../credentials/trello-source';
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
const gate=process.env.JARVIS_TEST_TRELLO_ENGINE==='1';
const piece='@activepieces/piece-trello';
let dir:string, api:SandboxApi, runtime:EngineRuntime, provider:ReturnType<typeof Bun.serve>;
let runId:string|undefined;
const requests:Array<{method:string;path:string;body:unknown;auth:string|null}>=[];
beforeAll(async()=>{
 if(!gate)return;
 dir=mkdtempSync(join(tmpdir(),'jarvis-trello-engine-'));
 initWorkflowDb(join(dir,'db.sqlite'));
 writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,dependencies:{[piece]:'0.7.1'}}));
 const install=spawnSync('bun',['install','--silent','--backend','copy'],{cwd:dir,encoding:'utf8'});
 if(install.status!==0)throw new Error('npm install failed: '+install.stderr);
 const board='a'.repeat(24),list='b'.repeat(24),card='c'.repeat(24),done='d'.repeat(24);
 provider=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const url=new URL(req.url),path=url.pathname;
  const raw=['POST','PUT'].includes(req.method)?await req.text():'';
  const body=raw?JSON.parse(raw):{};
  requests.push({method:req.method,path,body,auth:req.headers.get('authorization')});
  if(req.headers.get('authorization')!=='OAuth oauth_consumer_key="PUBLIC_KEY", oauth_token="ENGINE_ONLY_TRELLO"')return new Response('invalid token',{status:401});
  if(path==='/1/members/me/boards')return Response.json([{id:board,name:'Sandbox',closed:false}]);
  if(path===`/1/boards/${board}/lists`)return Response.json([{id:list,name:'To do',idBoard:board,closed:false},{id:done,name:'Done',idBoard:board,closed:false}]);
  if(path===`/1/lists/${list}`)return Response.json({id:list,idBoard:board,closed:false});
  if(path==='/1/cards' || path===`/1/cards/${card}`)return Response.json({id:card,name:'Sandbox card',desc:'',idBoard:board,idList:body.idList || list,url:'https://trello.com/c/abcd1234',closed:false});
  return new Response('unknown endpoint',{status:404});
 }});
 // Keep the published piece intact. Managed dispatch is deliberately qualified
 // through our adapter; only the disposable engine's fixed API origin changes.
 mkdirSync(join(dir,'connections'));
 writeFileSync(join(dir,'connections/trello.json'),JSON.stringify({version:1,provider:'trello',status:'connected',generation:randomUUID(),access_token:'ENGINE_ONLY_TRELLO',api_key:'PUBLIC_KEY',account:{id:'e'.repeat(24),label:'Owner'},workspaces:[],connected_at:new Date().toISOString()}));
 const resolver=new CredentialResolver();resolver.register(new JarvisTrelloConnectionSource(dir));
 api=new SandboxApi({services:buildSandboxServiceBackends({credentialResolver:resolver,llmManager:{} as any,channelService:{} as any,wsService:{} as any,eventBuffer:new WorkflowEventBuffer(),approvalManager:new ApprovalManager(),auditTrail:new AuditTrail(),emergencyController:new EmergencyController(),authorityEngine:new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'})})});
 await api.start({port:0});
 const bundle=await buildEngineBundle();
 const fixtureBundle=join(dir,'engine-fixture.cjs');
 writeFileSync(fixtureBundle,readFileSync(bundle.bundlePath,'utf8').replaceAll('https://api.trello.com/1/',`http://127.0.0.1:${provider.port}/1/`));
 const digest=createHash('sha256').update(readFileSync(fixtureBundle)).digest('hex');
 runtime=new EngineRuntime({api,bundlePath:fixtureBundle,expectedDigest:digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code'),egressPolicy:'private-allowed'});
},120000);
afterAll(async()=>{
 if(!gate)return;
 await runtime?.shutdown();await api?.stop();provider?.stop(true);closeWorkflowDb();
 if(runId)rmSync(join(workflowLogsBase(),runId+'.bin'),{force:true});
 if(dir)rmSync(dir,{recursive:true,force:true});
});
test.skipIf(!gate)('published Trello metadata and boards → lists → create → read → move through the real engine',async()=>{
 const {catalog,failures}=await buildPieceCatalog({runtime,pieceRoots:[join(dir,'node_modules/@activepieces')],projectId:DEFAULT_IDS.project,pieceTimeoutMs:30000,overallTimeoutMs:45000});
 expect(failures).toEqual([]);
 const metadata=catalog.get(piece)!;
 expect(metadata.auth?.type).toBe('BASIC_AUTH');
 for(const name of ['list_boards','list_lists','create_card','get_card','move_card']) {
   expect(metadata.actions[name]?.requireAuth).toBe(true);expect(metadata.actions[name]?.outputSample).toBeDefined();
 }
 expect(metadata.actions.create_card?.outputSample).toMatchObject({idList:'b'.repeat(24)});
 const step=(name:string,actionName:string,input:Record<string,unknown>,nextAction?:any)=>({name,type:'PIECE' as const,settings:{pieceName:piece,pieceVersion:'0.7.1',actionName,input:{auth:'{{connections.jarvis:trello}}',...input}},...(nextAction?{nextAction}:{})});
 const move=step('move','move_card',{card_id:'{{read.id}}',list_id:'{{lists.lists[1].id}}'});
 const read=step('read','get_card',{cardId:'{{create.id}}'},move);
 const create=step('create','create_card',{board_id:'{{boards.boards[0].id}}',list_id:'{{lists.lists[0].id}}',name:'Sandbox card'},read);
 const lists=step('lists','list_lists',{board_id:'{{boards.boards[0].id}}'},create);
 const boards=step('boards','list_boards',{},lists);
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Trello qualification',trigger:{name:'trigger',type:'EMPTY',nextAction:boards}});
 const run=createFlowRun({flowId:flow.id,flowVersionId:version.id});runId=run.id;
 const worker=new Worker({log:()=>{},handlers:{RUN_FLOW:createRunFlowHandler({executor:new EngineFlowExecutor(runtime,{terminalTimeoutMs:5000})})}});
 enqueue({jobType:'RUN_FLOW',flowRunId:run.id,maxAttempts:1,payload:{runId:run.id}});await worker.drain();
 const complete=getFlowRun(run.id)!;
 expect({status:complete.status,steps:complete.steps}).toMatchObject({status:'SUCCEEDED'});
 expect(requests.map(r=>r.method)).toEqual(['GET','GET','GET','POST','GET','PUT']);
 expect(requests[5]!.path).toBe('/1/cards/'+'c'.repeat(24));
 expect(requests[5]!.body).toEqual({idList:'d'.repeat(24)});
 expect(JSON.stringify(complete.steps)).not.toContain('ENGINE_ONLY_TRELLO');
},90000);
