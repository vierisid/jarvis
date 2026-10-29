import {randomUUID} from 'node:crypto';
import {ImportStop,importSetup,importSlice,type ImportRequest} from './contact-import';
import {IMPORT_ACCOUNTS,IMPORT_ACCOUNT_LABELS,IMPORT_ACTION,IMPORT_PIECE,importAccountFields,isContactImportStep,managedImportRefusal} from '../import-accounts';
import {ActionOutcomeError} from '../../actions/action-outcome';
import {importTransport} from './import-transport';
import {acquireImport} from '../db/repos/contact-import';
import {connectionBindings,currentConnectionIdentity,enforceRunConnectionBinding,recordRunCredentialOutcome} from '../db/repos/binding-pins';
import {createWaitpoint} from '../db/repos/waitpoint';
import {walkFlowNodes} from '../db/flow-graph';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import type {CredentialResolver} from '../credentials/adapter';
import {ConnectionCredentialError,OAUTH2_TYPES} from '../credentials/pasted-oauth2';
/** How long one daemon call keeps working before it yields to a timer that
 * resumes at once, well inside the 45s import lease that every save renews. */
export const IMPORT_CALL_BUDGET_MS=20_000;
export interface ImportCallBudget {ms:number;operations:number}
export function createContactImportService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;request?:ImportRequest;now?:()=>number;
  /** Per-call work budget; tests narrow it to one operation per call. */
  budget?:()=>ImportCallBudget}){
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=importSetup(input),{run,version,stepName,executionPath}=resolveEffectContext(ctx,IMPORT_PIECE,IMPORT_ACTION);
    const saved=walkFlowNodes(version.trigger).find(n=>n.name===stepName);
    if(!saved||!isContactImportStep(saved.type,saved.settings))throw Error('Import configuration must match a saved contact import step');
    if(digest(importSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Import setup must match the saved workflow');
    const fields=importAccountFields(setup);
    // The readiness rule, for every account before any binding is checked,
    // identity read or credential resolved: the saved step itself names it,
    // and no managed connection is accepted (no exemption covers the import).
    for(const field of fields){
      const externalId=setup[field];
      if(saved.settings?.input?.[field]!==externalId)throw Error('Import account must match the saved workflow step');
      // Defense in depth, unreachable while the check above holds: the pins
      // name every account field of a saved import step, so the graph binds an
      // id the saved step names. Kept so a change to either rule fails closed.
      if(!connectionBindings(version.trigger).has(externalId))throw Error('Import account is not bound to this workflow');
      if(externalId.startsWith('jarvis:'))throw Error(managedImportRefusal(field));
    }
    const identities=Object.fromEntries(fields.map(field=>[field,currentConnectionIdentity(ctx.projectId,setup[field],deps.credentials)]));
    const clock=deps.now??Date.now,key=digest(['contact-import-v1',ctx.projectId,run.flowId,setup.importId]);
    const park=(result:{complete:boolean;resumeAt?:number})=>{if(result.complete)return result;const wait=createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName,type:'TIMER',resumeDateTime:new Date(result.resumeAt!).toISOString()});return {...result,waitpointId:wait.id};};
    // The lock holds the configuration only. Account identities (credential
    // generations included) are not part of it: a reconnect must not strand the
    // import. The slice re-verifies the HubSpot portal when they change.
    const acquired=acquireImport(key,digest(setup),randomUUID(),clock),accounts=digest(identities);
    if('busyUntil'in acquired)return park({complete:false,resumeAt:acquired.busyUntil});
    try {
    const previous=getWorkflowEffect(workflowEffectId(ctx.runId,stepName,executionPath,'contact-import'));
    // Only a fenced owner may recover a dispatch abandoned by a lost worker.
    // The import ledger reconciles any possibly committed write before retrying.
    // A reported failure needs a new run (and fresh approval), retaining progress.
    // The abandoned slice may have reached a provider, so the effect is marked
    // as having run: a later stop of this run must not receipt it not_started.
    if(previous?.status==='dispatching'){
      previous.status='pending';delete previous.outcome;delete previous.error;
      previous.partial={slices:(previous.partial?.slices??0)+1,at:Date.now()};saveWorkflowEffect(previous);
    }
    const reply=await deps.effects.invoke({context:ctx,piece:IMPORT_PIECE,action:IMPORT_ACTION,route:'contact-import',toolName:'workflow_contact_import',category:'write_data',categories:['read_data','write_data'],toolCategory:'imports',request:setup,
      deferCompletion:result=>(result as {complete?:boolean})?.complete===false,
      prepare:()=>({arguments:setup,target:{source:setup.sourceUrl,account:setup.hubspotConnection,importId:setup.importId,effect:'Read selected API pages and upsert contacts by primary email. No deletion, messages or payments.'}}),
      execute:async(_args,checkpoint)=>{
        const tokens:{source?:string;hubspot:string}={hubspot:''};
        const check=()=>{checkpoint();for(const field of fields){const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,setup[field],deps.credentials);if(refusal)throw Error(refusal);}};
        for(const field of fields){
          const pieceName=IMPORT_ACCOUNTS[field],externalId=setup[field];
          check();let resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
          if(!resolved||resolved.pieceName!==pieceName||resolved.status&&resolved.status!=='ACTIVE'||resolved.type!=='OAUTH2')throw Error('Connect the selected import accounts securely');
          // A stored OAuth2 token is refreshed when it is about to expire, only
          // after the run's binding check passed (as the engine's connection route does).
          try{resolved=await deps.credentials.fresh(resolved);}
          catch(error){
            if(!(error instanceof ConnectionCredentialError))throw error;
            // Typed on the run's binding, as the engine's connection route records it, for the failure card.
            recordRunCredentialOutcome(ctx.runId,externalId,{code:error.code,message:error.message});
            // Only an expired or refused credential needs a person to reconnect; the others pass.
            const account=`the selected ${IMPORT_ACCOUNT_LABELS[field]} account (${externalId})`;
            throw Error(error.code==='CONNECTION_EXPIRED'?`Reconnect ${account}: ${error.message}`
              :error.code==='CONNECTION_REFRESH_UNREACHABLE'?`Nothing was imported in this step: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later to resume from the checkpoint. ${error.message}`
              :`Nothing was imported in this step: ${account} changed while Jarvis refreshed it. Start a new run to resume from the checkpoint. ${error.message}`);
          }
          if(resolved.stored&&OAUTH2_TYPES.has(resolved.type))recordRunCredentialOutcome(ctx.runId,externalId,null);
          if(typeof resolved.value.access_token!=='string'||!resolved.value.access_token)throw Error('Connect the selected import accounts securely');
          tokens[field==='hubspotConnection'?'hubspot':'source']=resolved.value.access_token;
        }
        // One call works through as many operations (lookups, writes, page
        // fetches and checkpoints) as fit its budget, each still one reserved,
        // checkpointed slice. It yields to a timer only for a real delay
        // (Retry-After, backoff, a busy lease) or when the budget is spent, and
        // then resumes at once.
        const base=deps.request??importTransport(setup,tokens,()=>{check();acquired.store.check();});
        let dispatched=0;const request:ImportRequest=(...args)=>{dispatched++;return base(...args);};
        const budget=deps.budget?.()??{ms:IMPORT_CALL_BUDGET_MS,operations:Infinity},started=Date.now();
        for(let operations=0;;){
          const before=dispatched;check();
          try{
            const now=clock(),result=await importSlice(setup,acquired.store,request,now,clock,ctx.runId,accounts);
            operations++;
            if(result.complete||result.resumeAt!==undefined&&result.resumeAt>now+1)return result;
            if(operations>=budget.operations||Date.now()-started>=budget.ms)return {...result,resumeAt:clock()};
          }catch(e){
            // A resumable stop is a typed block, not an uncertain dispatch. It
            // says not_started only when no earlier slice of this run, and no
            // earlier request of this call, ran, and the stopping request
            // itself had no effect.
            if(!(e instanceof ImportStop))throw e;
            const ran=before>0||!!getWorkflowEffect(workflowEffectId(ctx.runId,stepName,executionPath,'contact-import'))?.partial;
            throw new ActionOutcomeError({status:'blocked',code:e.code,message:e.message,effect:e.unexecuted&&!ran?'not_started':'may_have_occurred'});
          }
        }
      }});
    if(reply.approval)return {approval:reply.approval};
    return park(reply.result as {complete:boolean;resumeAt?:number});
    } finally {acquired.release();}
  };
}
