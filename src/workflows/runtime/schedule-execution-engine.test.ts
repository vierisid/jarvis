/** Real published schedules, compiled connector hooks, queue, worker and SQLite. */
import {afterAll,afterEach,beforeAll,expect,setSystemTime,test} from 'bun:test';
import {dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initWorkflowDb,closeWorkflowDb,DEFAULT_IDS} from '../db';
import {createFlow,setPublishedVersion,updateFlowStatus} from '../db/repos/flow';
import {createDraftVersion,lockVersion} from '../db/repos/flow-version';
import {listRuns,getFlowRun} from '../db/repos/flow-run';
import {configureWorkflowReadiness,versionReadiness} from '../db/repos/flow-readiness';
import {CredentialResolver} from '../credentials/adapter';
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
import {PieceCatalog,metadataToCatalogEntry} from './piece-catalog';
let dir:string,api:SandboxApi,runtime:EngineRuntime,worker:Worker,manager:TriggerManager,cron:CronScheduler,catalog:PieceCatalog;
const flowIds:string[]=[],runIds:string[]=[],logs:string[]=[];
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'jarvis-schedule-execution-'));initWorkflowDb(join(dir,'fixture.db'));
 const bundle=await buildEngineBundle();const metas=[];
 for(const part of ['jarvis/test','core/schedule']){
  const path=join(import.meta.dir,'../activepieces/packages/pieces',part);await buildPiece(path);
  const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));metas.push(meta);
  const installed=join(dir,'node_modules',meta.name);mkdirSync(dirname(installed),{recursive:true});symlinkSync(join(path,'dist'),installed,'dir');
 }
 api=new SandboxApi({services:{credentialResolver:new CredentialResolver()}});await api.start({port:0});
 runtime=new EngineRuntime({api,pool:true,bundlePath:bundle.bundlePath,expectedDigest:bundle.digest,cwd:dir,customPiecesPaths:[dir],devPieces:[],baseCodeDir:join(dir,'code')});
 const handle=await runtime.acquire({runId:'schedule-metadata',projectId:DEFAULT_IDS.project});
 try{const entries=[];for(const m of metas)entries.push(metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:m.name,pieceVersion:m.version})));catalog=new PieceCatalog(entries);}finally{await handle.release();}
 configureWorkflowReadiness({pieces:catalog});wireWorker();
},120000);
function wireWorker(){worker=new Worker({log:line=>logs.push(line),handlers:{[RUN_FLOW]:createRunFlowHandler({executor:new EngineFlowExecutor(runtime)})}});}
afterEach(async()=>{setSystemTime();await manager?.stop();cron?.cancelAll();for(const id of flowIds)updateFlowStatus(id,'DISABLED');});
afterAll(async()=>{await runtime?.shutdown();await api?.stop();closeWorkflowDb();for(const id of runIds)rmSync(join(workflowLogsBase(),id+'.bin'),{force:true});if(dir)rmSync(dir,{recursive:true,force:true});});
function save(installed:boolean){
 const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Scheduled occurrence',trigger:{name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:installed?'@activepieces/piece-schedule':'schedule',pieceVersion:'0.1.17',triggerName:'cron_expression',chosenTimezone:'Europe/Rome',input:installed?{cronExpression:'0 9 1-7 1,4,7,10 1',timezone:'Europe/Rome'}:{cron_expression:'0 9 1-7 1,4,7,10 1',timezone:'Europe/Rome'}},nextAction:{name:'capture',type:'PIECE',settings:{pieceName:'@jarvispieces/piece-jarvis-test',pieceVersion:'0.0.1',actionName:'echo',input:{value:{scheduledFor:'{{trigger.scheduledFor}}',scheduledDate:'{{trigger.scheduledDate}}',scheduledMonth:'{{trigger.scheduledMonth}}',occurrenceKey:'{{trigger.occurrenceKey}}'}}}}}});
 expect(versionReadiness(flow.id,version.id).issues).toEqual([]);lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');flowIds.push(flow.id);return flow;
}
for(const installed of [false,true])test('published '+(installed?'installed':'built-in')+' schedule preserves occurrence through worker restart',async()=>{
 const flow=save(installed);setSystemTime(new Date('2026-10-05T06:59:00Z'));
 cron=new CronScheduler();manager=new TriggerManager({eventBus:new WorkflowEventBus(),engineRuntime:runtime,cronScheduler:cron,log:line=>logs.push(line)});await manager.start();
 setSystemTime(new Date('2026-10-05T07:00:00Z'));cron.runDue('flow:'+flow.id);
 for(let i=0;i<200&&!listRuns({flowId:flow.id}).length;i++)await new Promise(r=>setTimeout(r,10));
 const runs=listRuns({flowId:flow.id});expect(runs).toHaveLength(1);const run=runs[0]!;runIds.push(run.id);
 cron.runDue('flow:'+flow.id);await manager.stop();setSystemTime();
 closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));configureWorkflowReadiness({pieces:catalog});wireWorker();await worker.drain();
 const result=getFlowRun(run.id)!;expect(result.failedStep).toBeNull();expect(result.status).toBe('SUCCEEDED');
 expect(result.steps?.capture).toMatchObject({output:{output:{echo:{scheduledFor:'2026-10-05T07:00:00.000Z',scheduledDate:'2026-10-05',scheduledMonth:'2026-10',occurrenceKey:'2026-10-05T09:00'}}}});
 expect(listRuns({flowId:flow.id})).toHaveLength(1);
},60000);
