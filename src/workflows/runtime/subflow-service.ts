import {getWorkflowDb} from '../db';
import {getFlowInProject} from '../db/repos/flow';
import {getFlowVersion,getLatestDraft} from '../db/repos/flow-version';
import {getSubflowCall,settleSubflow} from '../db/repos/subflow';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import {createWaitpoint} from '../db/repos/waitpoint';
import {JarvisWorkflowRunnerAdapter} from '../adapters/workflow-runner';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {SUBFLOW_PIECE,boundedJson,childCallInput,childFailureMessage,type ChildResult} from './subflow-contract';
import {assertRunNotCanceled} from './cancellation';
import {childTurnedOffOutcome,isTurnedOff} from '../db/repos/flow-turn-off';
import {ActionOutcomeError} from '../../actions/action-outcome';
import {boundedApprovalLabel} from '../../authority/approval-delivery';
import {WorkflowRunnerError} from '../adapters/workflow-runner';
/** A flow name on a step error: the 512 the HTTP routes cap a `displayName` at, as a start card shows one. */
const CHILD_NAME_MAX_CHARS=512;
/**
 * The child's name as its failure message shows it (#1325): one line, format
 * characters gone and cut with a visible "..." (`boundedApprovalLabel`), then
 * quoted as JSON so a quote in the name cannot close its own quotes and forge
 * the sentence after it, and wrapped in a bidi isolate when it holds non-ASCII
 * text so right-to-left text cannot reorder the message, as start cards do (#1316).
 */
export function childNameShown(name:string):string {
 const json=JSON.stringify(boundedApprovalLabel(name,CHILD_NAME_MAX_CHARS));
 return /[^\x00-\x7f]/.test(json)?'"\u2068'+json.slice(1,-1)+'\u2069"':json;
}
/** A child turned off after review is a definite refusal before anything started, not an uncertain dispatch. */
function startChild(...args:Parameters<JarvisWorkflowRunnerAdapter['startNow']>){
 try{return new JarvisWorkflowRunnerAdapter().startNow(...args);}
 catch(e){if(e instanceof WorkflowRunnerError&&e.code==='FLOW_TURNED_OFF')throw childTurnedOffOutcome();throw e;}
}

/**
 * `intentOf` names the child on the approval card (#1040): the flow ID, its
 * pinned version's name and the payload it is given (#1152), whole for the
 * dashboard and described for a chat card. `cardRefusal` refuses a payload
 * the card could not show whole.
 */
/** Refused before anything is dispatched: the same key now carries another payload. */
const keyReused=()=>new ActionOutcomeError({status:'blocked',code:'INVOCATION_KEY_REUSED',message:'This invocation key was already used with a different payload or configuration. Include something that changes per item in the key.',effect:'not_started'});
export function createSubflowService(effects:WorkflowEffectBoundary,now=Date.now,intentOf?:(flowId:string,versionId:string,payload:unknown)=>{intent:string;channelIntent:string},
 cardRefusal?:(args:Record<string,unknown>)=>string|null){
 return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
  const call=childCallInput(input),continueOnChildFailure=input.continueOnChildFailure===true,{run,stepName,executionPath}=resolveEffectContext(ctx,SUBFLOW_PIECE,'call');
  const id=digest(['subflow-v1',ctx.projectId,run.flowId,stepName,call.invocationKey]);
  const fingerprint=digest(call),effectId=workflowEffectId(ctx.runId,stepName,executionPath,'subflow');
  const db=getWorkflowDb();
  const previous=getWorkflowEffect(effectId);
  // Dispatch consists solely of a SQLite transaction. Re-entry can only find its committed child or create the rolled-back one.
  if(previous?.status==='dispatching'){previous.status='pending';delete previous.outcome;delete previous.error;saveWorkflowEffect(previous);}
  const reply=await effects.invoke({context:ctx,piece:SUBFLOW_PIECE,action:'call',route:'subflow',toolName:'workflow_start',category:'spawn_agent',toolCategory:'delegation',request:call,
   prepare:()=>{
    const old=getSubflowCall(id);if(old&&old.fingerprint!==fingerprint)throw keyReused();
    const flow=getFlowInProject(ctx.projectId,call.flow);if(!flow)throw Error('Reusable child workflow not found in this project');
    // #1242: refused before any approval card; dispatch (startNow) refuses it again.
    if(!old&&isTurnedOff(flow))throw childTurnedOffOutcome();
    const versionId=old?.version_id??flow.published_version_id??getLatestDraft(flow.id)?.id;
    const version=versionId?getFlowVersion(versionId):null;if(!version&&!old?.result_json)throw Error('Reusable child version unavailable');
    return {arguments:{...call,versionId,versionDigest:old?.version_digest??digest(version!.trigger)},target:{flowId:call.flow,versionId,invocationKey:call.invocationKey,...(intentOf&&versionId?intentOf(call.flow,versionId,call.payload):{})}};
   },
   ...(cardRefusal?{cardRefusal}:{}),
   execute:async(args,checkpoint)=>db.transaction(()=>{
    checkpoint();const old=getSubflowCall(id);
    if(old){if(old.fingerprint!==fingerprint)throw keyReused();return {callId:id};}
    const version=getFlowVersion(String(args.versionId));if(!version||digest(version.trigger)!==args.versionDigest)throw Error('Child version changed after review');
    const deadline=now()+call.timeoutSeconds*1000;
    const started=startChild({flowId:call.flow,payload:call.payload as Record<string,unknown>,waitForCompletion:true},ctx.runId,ctx.projectId,{effectId,stepName,versionId:version.id,deadline});
    db.run('INSERT INTO workflow_subflow_call (id,parent_flow_id,fingerprint,child_run_id,effect_id,version_id,version_digest,deadline,schema_json) VALUES (?,?,?,?,?,?,?,?,?)',[id,run.flowId,fingerprint,started.runId,effectId,version.id,String(args.versionDigest),deadline,JSON.stringify(call.outputSchema)]);
    db.run('INSERT INTO workflow_subflow_wait (call_id,parent_run_id,waitpoint_id) VALUES (?,?,?)',[id,ctx.runId,started.waitpointId!]);
    return {callId:id};
   }).immediate()});
  if(reply.approval)return {approval:reply.approval};
  const saved=getSubflowCall(id);if(!saved||saved.fingerprint!==fingerprint)throw Error('Child invocation receipt unavailable or changed');
  // Default: a child that failed, timed out or gave no usable result fails this step. The opt-out returns the status object.
  const settledOutcome=(outcome:ChildResult)=>{
   if(continueOnChildFailure||outcome.status==='succeeded')return outcome;
   const version=getFlowVersion(saved.version_id);throw new ActionOutcomeError({status:'error',code:outcome.code??'CHILD_FAILED',message:childFailureMessage(outcome,childNameShown(version?.displayName||call.flow),call.timeoutSeconds),effect:'may_have_occurred'});
  };
  const result=settleSubflow(id,now());if(result)return settledOutcome(result);
  return db.transaction(()=>{
   assertRunNotCanceled(ctx.runId);
   const existing=db.query('SELECT w.waitpoint_id FROM workflow_subflow_wait w JOIN waitpoint p ON p.id=w.waitpoint_id WHERE w.call_id=? AND w.parent_run_id=? AND p.resumed_at IS NULL').get(id,ctx.runId) as {waitpoint_id:string}|null;
   const waitpointId=existing?.waitpoint_id??createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName,type:'TIMER',resumeDateTime:new Date(saved.deadline).toISOString()}).id;
   db.run('INSERT OR IGNORE INTO workflow_subflow_wait (call_id,parent_run_id,waitpoint_id) VALUES (?,?,?)',[id,ctx.runId,waitpointId]);
   return {waitpointId};
  }).immediate();
 };
}
export async function returnSubflowResult(input:Record<string,unknown>,ctx:WorkflowEffectContext){
 resolveEffectContext(ctx,SUBFLOW_PIECE,'return_result');assertRunNotCanceled(ctx.runId);
 if(!Object.hasOwn(input,'result'))throw Error('Explicit child result required');
 const value=boundedJson(input.result),db=getWorkflowDb();
 db.transaction(()=>{const prior=db.query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(ctx.runId) as {value:string}|null;
  if(prior&&digest(JSON.parse(prior.value))!==digest(input.result))throw Error('Child result already returned with different data');
  db.run('INSERT OR IGNORE INTO workflow_subflow_result (run_id,value) VALUES (?,?)',[ctx.runId,value]);
 }).immediate();return input.result;
}
