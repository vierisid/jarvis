import {getWorkflowDb} from '../db';
import {getFlowInProject} from '../db/repos/flow';
import {getFlowVersion,getLatestDraft} from '../db/repos/flow-version';
import {getSubflowCall,settleSubflow} from '../db/repos/subflow';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import {createWaitpoint} from '../db/repos/waitpoint';
import {JarvisWorkflowRunnerAdapter} from '../adapters/workflow-runner';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {SUBFLOW_PIECE,boundedJson,childCallInput} from './subflow-contract';
import {assertRunNotCanceled} from './cancellation';

export function createSubflowService(effects:WorkflowEffectBoundary,now=Date.now){
 return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
  const call=childCallInput(input),{run,stepName,executionPath}=resolveEffectContext(ctx,SUBFLOW_PIECE,'call');
  const id=digest(['subflow-v1',ctx.projectId,run.flowId,stepName,call.invocationKey]);
  const fingerprint=digest(call),effectId=workflowEffectId(ctx.runId,stepName,executionPath,'subflow');
  const db=getWorkflowDb();
  const previous=getWorkflowEffect(effectId);
  // Dispatch consists solely of a SQLite transaction. Re-entry can only find its committed child or create the rolled-back one.
  if(previous?.status==='dispatching'){previous.status='pending';delete previous.outcome;delete previous.error;saveWorkflowEffect(previous);}
  const reply=await effects.invoke({context:ctx,piece:SUBFLOW_PIECE,action:'call',route:'subflow',toolName:'workflow_start',category:'spawn_agent',toolCategory:'delegation',request:call,
   prepare:()=>{
    const old=getSubflowCall(id);if(old&&old.fingerprint!==fingerprint)throw Error('Invocation key was already used with different payload or configuration');
    const flow=getFlowInProject(ctx.projectId,call.flow);if(!flow)throw Error('Reusable child workflow not found in this project');
    const versionId=old?.version_id??flow.published_version_id??getLatestDraft(flow.id)?.id;
    const version=versionId?getFlowVersion(versionId):null;if(!version&&!old?.result_json)throw Error('Reusable child version unavailable');
    return {arguments:{...call,versionId,versionDigest:old?.version_digest??digest(version!.trigger)},target:{flowId:call.flow,versionId,invocationKey:call.invocationKey}};
   },
   execute:async(args,checkpoint)=>db.transaction(()=>{
    checkpoint();const old=getSubflowCall(id);
    if(old){if(old.fingerprint!==fingerprint)throw Error('Invocation key was already used with different payload or configuration');return {callId:id};}
    const version=getFlowVersion(String(args.versionId));if(!version||digest(version.trigger)!==args.versionDigest)throw Error('Child version changed after review');
    const deadline=now()+call.timeoutSeconds*1000;
    const started=new JarvisWorkflowRunnerAdapter().startNow({flowId:call.flow,payload:call.payload as Record<string,unknown>,waitForCompletion:true},ctx.runId,ctx.projectId,{effectId,stepName,versionId:version.id,deadline});
    db.run('INSERT INTO workflow_subflow_call (id,parent_flow_id,fingerprint,child_run_id,effect_id,version_id,version_digest,deadline,schema_json) VALUES (?,?,?,?,?,?,?,?,?)',[id,run.flowId,fingerprint,started.runId,effectId,version.id,String(args.versionDigest),deadline,JSON.stringify(call.outputSchema)]);
    db.run('INSERT INTO workflow_subflow_wait (call_id,parent_run_id,waitpoint_id) VALUES (?,?,?)',[id,ctx.runId,started.waitpointId!]);
    return {callId:id};
   }).immediate()});
  if(reply.approval)return {approval:reply.approval};
  const saved=getSubflowCall(id);if(!saved||saved.fingerprint!==fingerprint)throw Error('Child invocation receipt unavailable or changed');
  const result=settleSubflow(id,now());if(result)return result;
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
