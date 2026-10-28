import {randomUUID} from 'node:crypto';
import {BATCH_PIECE,BATCH_ACTION,BATCH_ACCOUNTS,batchSetup,batchInput,batchSlice,batchTransport} from './lead-batch';
import {acquireBatch} from '../db/repos/lead-batch';
import {connectionBindings,currentConnectionIdentity,enforceRunConnectionBinding} from '../db/repos/binding-pins';
import {createWaitpoint} from '../db/repos/waitpoint';
import {walkFlowNodes} from '../db/flow-graph';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import type {CredentialResolver} from '../credentials/adapter';
export function createLeadBatchService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}) {
 return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
  const setup=batchSetup(input),batch=batchInput(setup,input.submission),{run,version,stepName,executionPath}=resolveEffectContext(ctx,BATCH_PIECE,BATCH_ACTION);
  const saved=walkFlowNodes(version.trigger).find(n=>n.name===stepName)!;
  if(digest(batchSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Batch setup must match the saved workflow');
  const account=currentConnectionIdentity(ctx.projectId,setup.hubspotConnection,deps.credentials),clock=deps.now??Date.now;
  const identity=digest(['lead-batch-v1',ctx.projectId,run.flowId,batch.id]);
  const park=(result:any)=>{if(result.complete)return result;const wait=createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName,type:'TIMER',resumeDateTime:new Date(result.resumeAt).toISOString()});return {...result,waitpointId:wait.id};};
  const lease=acquireBatch(identity,digest([setup,account,batch]),batch,randomUUID(),clock);
  if('busyUntil'in lease)return park({complete:false,resumeAt:lease.busyUntil});
  try {
   const previous=getWorkflowEffect(workflowEffectId(ctx.runId,stepName,executionPath,'lead-batch'));
   // Safe only under the fenced ledger: abandoned record dispatches become uncertain.
   if(previous?.status==='dispatching'){previous.status='pending';delete previous.outcome;delete previous.error;saveWorkflowEffect(previous);}
   const reply=await deps.effects.invoke({context:ctx,piece:BATCH_PIECE,action:BATCH_ACTION,route:'lead-batch',toolName:'workflow_lead_batch',category:'write_data',toolCategory:'workflow',request:{...setup,batch},deferCompletion:r=>(r as any)?.complete===false,
    prepare:()=>({arguments:{...setup,batch},target:{account:setup.hubspotConnection,submissionId:batch.id,records:batch.leads.length,effect:'Update existing HubSpot contacts only; retain all record outcomes and report partial failure'}}),
    execute:async(_args,checkpoint)=>{
     const check=()=>{checkpoint();lease.store.check();const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,setup.hubspotConnection,deps.credentials);if(refusal)throw Error(refusal);};
     check();const externalId=setup.hubspotConnection,pieceName=BATCH_ACCOUNTS.hubspotConnection;
     if(externalId.startsWith('jarvis:')||!connectionBindings(version.trigger).has(externalId))throw Error('Select a saved HubSpot account');
     const resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
     if(!resolved||resolved.pieceName!==pieceName||resolved.status&&resolved.status!=='ACTIVE'||resolved.type!=='OAUTH2'||typeof resolved.value.access_token!=='string'||!resolved.value.access_token)throw Error('Connect the selected HubSpot OAuth2 account securely');
     check();return batchSlice(setup,lease.store,batchTransport(setup,resolved.value.access_token,check,deps.fetchImpl),identity,clock);
    }});
   return reply.approval?{approval:reply.approval}:park(reply.result);
  }finally{lease.release();}
 };
}
