import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler, type CronOccurrence } from '../../lib/cron-scheduler';
import { scheduleTriggerPayload } from './schedule-payload';
import { resolveFixtureValue } from './json-mapping-fixtures';
import { digest } from './effect-context';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { PieceCatalog } from './piece-catalog';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, lockVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { claimFire } from '../db/repos/trigger-fire';
import { enqueue } from '../db/repos/job-queue';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { buildSandboxServiceBackends } from './service-backends';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { DeferredExecutor } from '../../authority/deferred-executor';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { DecisionQueue } from '../../brief/decisions';
import { sendNotification } from '../activepieces/packages/pieces/jarvis/notify/src/lib/actions/send-notification';

const check = (value: unknown, message: string): void => { if (!value) throw Error('Durable schedule fixture: '+message); };
type Scenario = {name:string; start:string; end:string; occurrences:number; restart?:string; deliveries?:number; replay?:boolean; delayed?:boolean; outcome?:'failure'|'uncertain'|'lost_reply'};
export const dailyDstCases: Scenario[] = [
  {name:'Normal winter date',start:'2026-01-15T01:29:00Z',end:'2026-01-15T01:31:00Z',occurrences:1},
  {name:'Normal summer date',start:'2026-07-15T00:29:00Z',end:'2026-07-15T00:31:00Z',occurrences:1},
  {name:'Spring gap is skipped, not shifted',start:'2026-03-29T00:58:00Z',end:'2026-03-29T01:32:00Z',occurrences:0},
  {name:'Both autumn occurrences share state',start:'2026-10-25T00:29:00Z',end:'2026-10-25T01:32:00Z',occurrences:1},
  {name:'Restart between autumn occurrences',start:'2026-10-25T00:29:00Z',end:'2026-10-25T01:32:00Z',restart:'2026-10-25T01:29:00Z',occurrences:1},
  {name:'Start after first autumn occurrence',start:'2026-10-25T01:29:00Z',end:'2026-10-25T01:32:00Z',occurrences:0},
  {name:'Concurrent duplicate admission and completed replay after restart',start:'2026-10-24T00:29:00Z',end:'2026-10-24T00:31:00Z',occurrences:1,deliveries:5,replay:true},
  {name:'Delayed execution crosses local midnight after database reopen',start:'2026-10-24T00:29:00Z',end:'2026-10-24T00:31:00Z',occurrences:1,delayed:true,replay:true},
  {name:'Notification failure remains explicit on replay',start:'2026-10-24T00:29:00Z',end:'2026-10-24T00:31:00Z',occurrences:1,outcome:'failure',replay:true},
  {name:'Uncertain send stays in Needs you after restart without resending',start:'2026-10-24T00:29:00Z',end:'2026-10-24T00:31:00Z',occurrences:1,outcome:'uncertain',replay:true},
  {name:'Lost action response reuses confirmed durable receipt',start:'2026-10-24T00:29:00Z',end:'2026-10-24T00:31:00Z',occurrences:1,outcome:'lost_reply',replay:true},
];

function validate(saved:any) {
  const t=saved?.settings, n=saved?.nextAction;
  check(JSON.stringify(saved).length<=100_000,'definition exceeds 100 KB');
  check(saved?.type==='PIECE_TRIGGER'&&t?.pieceName==='schedule'&&t.input?.cron_expression==='30 2 * * *'
    &&t.input?.timezone==='Europe/Rome'&&t.input?.dst_policy==='skip_missing_first_repeated','suite requires daily 02:30 Rome and explicit skip_missing_first_repeated policy');
  check(n?.type==='PIECE'&&['@jarvispieces/piece-jarvis-notify','jarvis-notify'].includes(n.settings?.pieceName)&&n.settings?.actionName==='notify','requires notification action');
  for(const node of [saved,n]) {
    check(!node.children?.length&&!node.firstLoopAction&&!node.onFailureAction,'branches not covered');
    check(!node.settings?.propertySettings||Object.keys(node.settings.propertySettings).length===0,'property processors not covered');
    check(!node.settings?.retryOnFailure&&!node.settings?.continueOnFailure&&!node.settings?.errorHandlingOptions?.retryOnFailure?.value&&!node.settings?.errorHandlingOptions?.continueOnFailure?.value,'retry/continue settings not covered');
  }
  check(!n.nextAction,'only schedule -> dashboard notification supported');
  const input=n.settings.input;
  check(Array.isArray(input?.channels)&&input.channels.length===1&&input.channels[0]==='dashboard'&&!input.meetingGuard,'only dashboard without meeting guard supported');
  check(typeof input.message==='string'&&input.message.length>0,'message missing');
  check(typeof input.idempotencyKey==='string'&&input.idempotencyKey.includes('{{'+saved.name+'.scheduledDate}}'),'key must use persisted scheduledDate');
  return n;
}

/** Real scheduler/SQLite/effect services, isolated from the retained workspace. No provider or engine subprocess. */
async function execute(saved:any) {
  const node=validate(saved), directory=mkdtempSync(join(tmpdir(),'jarvis-dst-fixtures-')), results:any[]=[];
  const log=console.log;console.log=()=>{};
  try {
    for(const [index,c] of dailyDstCases.entries()) {
      const file=join(directory,index+'.db');initWorkflowDb(file);
      const configure=()=>configureWorkflowReadiness({pieces:new PieceCatalog([{name:node.settings.pieceName,displayName:'Notify',description:'Isolated fixture',actions:{notify:{name:'notify',displayName:'Notify',description:'Fixed local implementation'}}}])});
      configure();
      const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Isolated DST fixture',trigger:saved});
      lockVersion(version.id);setPublishedVersion(flow.id,version.id);
      let now=Date.parse(c.start), attempts=0, confirmations=0, acceptedByMock=0, scheduled=0, duplicates=0;
      const occurrences:CronOccurrence[]=[], runIds:string[]=[], statuses:string[]=[], keys:string[]=[];
      let services:ReturnType<typeof buildSandboxServiceBackends>, queue:DecisionQueue;
      const wire=()=>{
        // The caller validates installed metadata; this isolated registry admits only the fixed action exercised below.
        configure();
        const approvals=new ApprovalManager(),audit=new AuditTrail();
        services=buildSandboxServiceBackends({credentialResolver:new CredentialResolver(),eventBuffer:new WorkflowEventBuffer(),llmManager:{} as any,channelService:{} as any,
          authorityEngine:new AuthorityEngine({default_level:10,governed_categories:[],overrides:[],context_rules:[],learning:{enabled:false,suggest_threshold:10},emergency_state:'normal'}),
          approvalManager:approvals,auditTrail:audit,emergencyController:new EmergencyController(),
          wsService:{broadcastNotificationToDashboard:()=>{
            attempts++;
            if(c.outcome==='failure')return 0;
            acceptedByMock++;
            if(c.outcome==='uncertain')throw Error('Synthetic response lost after dashboard accepted');
            confirmations++;return 1;
          }} as any});
        queue=new DecisionQueue(getWorkflowDb(),{approvalManager:approvals,deferredExecutor:new DeferredExecutor(approvals,audit)});
      };
      wire();updateFlowStatus(flow.id,'ENABLED');
      const reopen=()=>{closeWorkflowDb();initWorkflowDb(file);wire();};
      const scheduler=()=>{
        const cron=new CronScheduler(()=>now);
        cron.schedule('fixture',saved.settings.input.cron_expression,o=>{scheduled++;occurrences.push(o);},
          {timezone:'Europe/Rome',dstPolicy:saved.settings.input.dst_policy});return cron;
      };
      let cron=scheduler();
      try {
        for(now=Date.parse(c.start);now<=Date.parse(c.end);now+=60_000) {
          if(c.restart&&now===Date.parse(c.restart)){cron.cancelAll();reopen();cron=scheduler();}
          cron.runDue('fixture',now);
        }
      } finally {cron.cancelAll();}
      check(scheduled===c.occurrences,c.name+': wrong occurrence count');
      for(const o of occurrences) {
        const admissions=await Promise.all(Array.from({length:c.deliveries??1},async()=>claimFire({flowId:flow.id,flowVersionId:version.id,source:'schedule',dedupeKey:o.key,scheduledFor:o.at,observedAt:o.at},()=>{
          const run=createFlowRun({flowId:flow.id,flowVersionId:version.id,status:'RUNNING'});
          enqueue({jobType:'RUN_FLOW',flowId:flow.id,flowRunId:run.id,flowVersionId:version.id,payload:{runId:run.id,triggerPayload:scheduleTriggerPayload({timezone:'Europe/Rome'},o)}});
          return {runId:run.id};
        })));
        for(const a of admissions)if(a.outcome==='started')runIds.push(a.runId);else if(a.outcome==='duplicate')duplicates++;
      }
      if(c.delayed){now+=86_400_000;reopen();}
      async function dispatch(runId:string,lostReply=false){
        const row=getWorkflowDb().query('SELECT payload FROM workflow_job WHERE flow_run_id=? LIMIT 1').get(runId) as {payload:string};
        const payload=JSON.parse(row.payload).triggerPayload;
        const input=resolveFixtureValue(node.settings.input,{[saved.name]:payload});keys.push(input.idempotencyKey);
        check(input.idempotencyKey.includes(payload.scheduledDate),'lost scheduled date');
        let posted=false;
        globalThis.fetch=(async(url:any,init:any)=>{
          check(url==='http://fixture.invalid/v1/jarvis/notify'&&init?.method==='POST'&&!posted,'unexpected network request');posted=true;
          const request=JSON.parse(init.body);let report:any;
          try {report=await services.notify!({priority:'normal',...request},{runId,projectId:DEFAULT_IDS.project,stepName:node.name,executionPath:[]});}
          catch(error:any){return Response.json({outcome:error.outcome??{status:'unknown',code:'FIXTURE_UNRESOLVED',effect:'may_have_occurred',message:error.message}},{status:502});}
          if(lostReply)throw Error('Synthetic action response lost after persisted receipt');
          return Response.json(report);
        }) as typeof fetch;
        try {
          await sendNotification({propsValue:input,server:{apiUrl:'http://fixture.invalid',token:'synthetic'},step:{name:node.name},run:{waitForWaitpoint:()=>{throw Error('Unexpected approval');}}});
          statuses.push('SUCCEEDED');updateRun(runId,{status:'SUCCEEDED'});
        }catch(error:any){statuses.push(error.outcome?.status==='error'?'FAILED':'UNCERTAIN');updateRun(runId,{status:'FAILED'});}
      }
      for(const id of runIds)await dispatch(id,c.outcome==='lost_reply');
      const firstEffects=runIds.flatMap(id=>listWorkflowEffects(id));
      if(c.outcome==='uncertain'){
        check(firstEffects[0]?.status==='unknown','unconfirmed delivery was reported complete');
        check((await queue!.read()).data.items.some(item=>item.state==='unknown'&&item.decisionId==='effect:'+firstEffects[0]!.id),'missing Needs you review');
      }
      if(c.replay&&runIds[0]) {
        reopen();updateRun(runIds[0],{status:'RUNNING'});await dispatch(runIds[0]);
        // A fresh run with the same date/key must also consult the durable identity.
        const replay=createFlowRun({flowId:flow.id,flowVersionId:version.id,status:'RUNNING'});
        const row=getWorkflowDb().query('SELECT payload FROM workflow_job WHERE flow_run_id=? LIMIT 1').get(runIds[0]) as {payload:string};
        enqueue({jobType:'RUN_FLOW',flowRunId:replay.id,payload:JSON.parse(row.payload)});await dispatch(replay.id);
      }
      const reviews=(await queue!.read()).data.items.filter(item=>item.state==='unknown');
      check(attempts===c.occurrences,c.name+': duplicate notification attempt');
      check(confirmations===(c.outcome==='failure'||c.outcome==='uncertain'?0:c.occurrences),c.name+': wrong confirmation count');
      if(c.outcome==='uncertain')check(reviews.some(item=>item.decisionId==='effect:'+firstEffects[0]!.id),'review lost on reopen');
      if(c.outcome==='failure')check(!statuses.includes('SUCCEEDED'),'rejected send reported success');
      if(c.outcome==='uncertain')check(!statuses.includes('SUCCEEDED'),'uncertain send reported success');
      if(c.delayed)check(keys.every(key=>key.includes('2026-10-24')),'delayed execution changed scheduled date');
      results.push({name:c.name,passed:true,scheduledOccurrences:scheduled,occurrences:occurrences.map(o=>({at:new Date(o.at).toISOString(),key:o.key})),notificationAttempts:attempts,
        confirmedDeliveries:confirmations,acceptedByMock,duplicateAdmissions:duplicates,deduplicationKeys:[...new Set(keys)],statuses,reviewItems:reviews.map(item=>({state:item.state,actions:item.supportedActions})),
        restarted:!!(c.restart||c.replay||c.delayed),executedAt:new Date(c.delayed?now:Date.parse(c.end)).toISOString()});
      closeWorkflowDb();
    }
    return {passed:true,definitionDigest:digest(saved),cases:results,externalActions:0,
      scope:'Saved-graph integration fixtures: production scheduler driven minute by minute with controlled clock; actual temporary SQLite admission, queued payloads, notification effect and identity receipts; database/service reopen; expression resolution, notify action and Needs you projection. Providers mocked.',
      limitations:'No engine subprocess or worker lifecycle, real timer waits, browser UI, live dashboard sockets or host-crash fault injection. Authority uses a permissive isolated fixture policy; production policy is not exercised. Database reopen is tested, not process termination.',
      configuration:'Retained workflow, configuration, accounts, activation and runs unchanged; all runs exist only in deleted temporary fixture databases.'};
  }finally{console.log=log;closeWorkflowDb();rmSync(directory,{recursive:true,force:true});}
}

export async function validateDurableScheduleFixtures(saved:any){
  validate(saved);
  const child=Bun.spawn([process.execPath,'--no-env-file',fileURLToPath(import.meta.url)],{env:{},stdin:new Blob([JSON.stringify(saved)]),stdout:'pipe',stderr:'ignore'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},30_000);
  try {
    const chunks:Uint8Array[]=[];let size=0;const reader=child.stdout.getReader();
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;check(size<=1_000_000,'output exceeds 1 MB');chunks.push(value);}
    const code=await child.exited;check(!timedOut,'timed out');const result=JSON.parse(Buffer.concat(chunks).toString());check(code===0&&result.ok,result.error??'execution failed');return result.report;
  }finally{clearTimeout(timer);child.kill();}
}
if(import.meta.main){
  globalThis.fetch=(()=>{throw Error('Real network disabled');}) as unknown as typeof fetch;
  try{const report=await execute(await Bun.stdin.json());console.log(JSON.stringify({ok:true,report}));}
  catch(e){console.log(JSON.stringify({ok:false,error:e instanceof Error?e.message:String(e)}));process.exitCode=1;}
}
