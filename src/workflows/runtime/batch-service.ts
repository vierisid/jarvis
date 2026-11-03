import {randomUUID} from 'node:crypto';
import {BATCH_PIECE,BATCH_ACTION,BATCH_ACCOUNTS,batchSetup,batchInput,batchSlice,batchTransport} from './lead-batch';
import {acquireBatch} from '../db/repos/lead-batch';
import {connectionBindings,currentConnectionIdentity,enforceRunConnectionBinding,recordRunCredentialOutcome} from '../db/repos/binding-pins';
import {createWaitpoint} from '../db/repos/waitpoint';
import {walkFlowNodes} from '../db/flow-graph';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import {managedConnectionMisuse,managedSourceFor,type CredentialResolver} from '../credentials/adapter';
import {BATCH_ACCOUNT_LABELS,isLeadBatchStep,type BatchAccountField} from '../batch-accounts';
import {ConnectionCredentialError,OAUTH2_TYPES} from '../credentials/pasted-oauth2';
export function createLeadBatchService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}) {
 return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
  const setup=batchSetup(input),batch=batchInput(setup,input.submission),{run,version,stepName,executionPath}=resolveEffectContext(ctx,BATCH_PIECE,BATCH_ACTION);
  const saved=walkFlowNodes(version.trigger).find(n=>n.name===stepName);
  if(!saved||!isLeadBatchStep(saved.type,saved.settings))throw Error('Batch configuration must match a saved lead batch step');
  if(digest(batchSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Batch setup must match the saved workflow');
  // The readiness rule, before any identity is read, lease taken or credential resolved: the
  // saved step itself names the account, and a managed connection is refused by
  // managedConnectionMisuse (no exemption covers lead batches), so nothing is written.
  for(const field of Object.keys(BATCH_ACCOUNTS) as BatchAccountField[]){
   const externalId=setup[field];
   if(saved.settings?.input?.[field]!==externalId)throw Error('Batch account must match the saved workflow step');
   if(!connectionBindings(version.trigger).has(externalId))throw Error('Batch account is not bound to this workflow');
   if(externalId.startsWith('jarvis:')){
    const source=managedSourceFor(deps.credentials.list(),externalId);
    const misuse=source?managedConnectionMisuse(source,BATCH_ACCOUNTS[field],`settings.input.${field}`,saved.settings,saved.type):'Managed connection source is unavailable';
    throw Error(misuse??`A managed connection cannot be the ${BATCH_ACCOUNT_LABELS[field]} account of a lead batch`);
   }
  }
  const account=currentConnectionIdentity(ctx.projectId,setup.hubspotConnection,deps.credentials),clock=deps.now??Date.now;
  const identity=digest(['lead-batch-v1',ctx.projectId,run.flowId,batch.id]);
  const park=(result:any)=>{if(result.complete)return result;const wait=createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName,type:'TIMER',resumeDateTime:new Date(result.resumeAt).toISOString()});return {...result,waitpointId:wait.id};};
  const lease=acquireBatch(identity,digest([setup,account,batch]),batch,randomUUID(),clock);
  if('busyUntil'in lease)return park({complete:false,resumeAt:lease.busyUntil});
  try {
   const previous=getWorkflowEffect(workflowEffectId(ctx.runId,stepName,executionPath,'lead-batch'));
   // Safe only under the fenced ledger: abandoned record dispatches become uncertain.
   // The abandoned slice may have reached HubSpot, so the effect is marked as having
   // run: a later stop of this run must not receipt it not_started.
   if(previous?.status==='dispatching'){
    previous.status='pending';delete previous.outcome;delete previous.error;
    previous.partial={slices:(previous.partial?.slices??0)+1,at:Date.now()};saveWorkflowEffect(previous);
   }
   const reply=await deps.effects.invoke({context:ctx,piece:BATCH_PIECE,action:BATCH_ACTION,route:'lead-batch',toolName:'workflow_lead_batch',category:'write_data',toolCategory:'workflow',request:{...setup,batch},deferCompletion:r=>(r as any)?.complete===false,
    prepare:()=>({arguments:{...setup,batch},target:{account:setup.hubspotConnection,submissionId:batch.id,records:batch.leads.length,effect:'Update existing HubSpot contacts only; retain all record outcomes and report partial failure'}}),
    execute:async(_args,checkpoint)=>{
     const check=()=>{checkpoint();lease.store.check();const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,setup.hubspotConnection,deps.credentials);if(refusal)throw Error(refusal);};
     check();const externalId=setup.hubspotConnection,pieceName=BATCH_ACCOUNTS.hubspotConnection;
     let resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
     if(!resolved||resolved.pieceName!==pieceName||resolved.status&&resolved.status!=='ACTIVE'||resolved.type!=='OAUTH2')throw Error('Connect the selected HubSpot OAuth2 account securely');
     // Refresh a stored token that is about to expire, after the binding check passed
     // (as the engine's connection route does). An expired token would otherwise turn
     // every remaining record into a terminal HTTP 401 failure.
     try{resolved=await deps.credentials.fresh(resolved);}
     catch(error){
      if(!(error instanceof ConnectionCredentialError))throw error;
      recordRunCredentialOutcome(ctx.runId,externalId,{code:error.code,message:error.message});
      throw Error(error.code==='CONNECTION_EXPIRED'?`Reconnect the selected HubSpot account (${externalId}): ${error.message}`
       :`No lead was updated in this step: Jarvis could not refresh the selected HubSpot account (${externalId}). Deliver the same submission again later to resume unfinished records. ${error.message}`);
     }
     if(resolved.stored&&OAUTH2_TYPES.has(resolved.type))recordRunCredentialOutcome(ctx.runId,externalId,null);
     if(typeof resolved.value.access_token!=='string'||!resolved.value.access_token)throw Error('Connect the selected HubSpot OAuth2 account securely');
     check();return batchSlice(setup,lease.store,batchTransport(setup,resolved.value.access_token,check,deps.fetchImpl),identity,clock);
    }});
   return reply.approval?{approval:reply.approval}:park(reply.result);
  }finally{lease.release();}
 };
}
