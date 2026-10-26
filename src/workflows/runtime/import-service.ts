import {randomUUID} from 'node:crypto';
import {IMPORT_ACCOUNTS,IMPORT_ACTION,IMPORT_PIECE,importSetup,importSlice,type ImportRequest} from './contact-import';
import {importTransport} from './import-transport';
import {acquireImport} from '../db/repos/contact-import';
import {connectionBindings,currentConnectionIdentity,enforceRunConnectionBinding} from '../db/repos/binding-pins';
import {createWaitpoint} from '../db/repos/waitpoint';
import {walkFlowNodes} from '../db/flow-graph';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import type {CredentialResolver} from '../credentials/adapter';
export function createContactImportService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;request?:ImportRequest;now?:()=>number}){
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=importSetup(input),{run,version,stepName,executionPath}=resolveEffectContext(ctx,IMPORT_PIECE,IMPORT_ACTION);
    const saved=walkFlowNodes(version.trigger).find(n=>n.name===stepName)!;
    if(digest(importSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Import setup must match the saved workflow');
    const accounts={hubspotConnection:IMPORT_ACCOUNTS.hubspotConnection,...(setup.sourceAuth==='oauth2'?{sourceConnection:IMPORT_ACCOUNTS.sourceConnection}:{})};
    const identities=Object.fromEntries(Object.keys(accounts).map(field=>[field,currentConnectionIdentity(ctx.projectId,String(setup[field]),deps.credentials)]));
    const clock=deps.now??Date.now,key=digest(['contact-import-v1',ctx.projectId,run.flowId,setup.importId]);
    const park=(result:{complete:boolean;resumeAt?:number})=>{if(result.complete)return result;const wait=createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName,type:'TIMER',resumeDateTime:new Date(result.resumeAt!).toISOString()});return {...result,waitpointId:wait.id};};
    const acquired=acquireImport(key,digest([setup,identities]),randomUUID(),clock);
    if('busyUntil'in acquired)return park({complete:false,resumeAt:acquired.busyUntil});
    try {
    const previous=getWorkflowEffect(workflowEffectId(ctx.runId,stepName,executionPath,'contact-import'));
    // Only a fenced owner may recover a dispatch abandoned by a lost worker.
    // The import ledger reconciles any possibly committed write before retrying.
    // A reported failure needs a new run (and fresh approval), retaining progress.
    if(previous?.status==='dispatching'){
      previous.status='pending';delete previous.outcome;delete previous.error;saveWorkflowEffect(previous);
    }
    const reply=await deps.effects.invoke({context:ctx,piece:IMPORT_PIECE,action:IMPORT_ACTION,route:'contact-import',toolName:'workflow_contact_import',category:'write_data',categories:['read_data','write_data'],toolCategory:'imports',request:setup,
      deferCompletion:result=>(result as {complete?:boolean})?.complete===false,
      prepare:()=>({arguments:setup,target:{source:setup.sourceUrl,account:setup.hubspotConnection,importId:setup.importId,effect:'Read selected API pages and upsert contacts by primary email. No deletion, messages or payments.'}}),
      execute:async(_args,checkpoint)=>{
        const tokens:{source?:string;hubspot:string}={hubspot:''};
        const check=()=>{checkpoint();for(const field of Object.keys(accounts)){const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,String(setup[field]),deps.credentials);if(refusal)throw Error(refusal);}};
        for(const [field,pieceName]of Object.entries(accounts)){
          const id=String(setup[field]);check();if(id.startsWith('jarvis:')||!connectionBindings(version.trigger).has(id))throw Error('Select a saved import account');
          const resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId:id});
          if(!resolved||resolved.pieceName!==pieceName||resolved.status&&resolved.status!=='ACTIVE'||resolved.type!=='OAUTH2'||typeof resolved.value.access_token!=='string'||!resolved.value.access_token)throw Error('Connect the selected import accounts securely');
          tokens[field==='hubspotConnection'?'hubspot':'source']=resolved.value.access_token;
        }
        check();return importSlice(setup,acquired.store,deps.request??importTransport(setup,tokens,()=>{check();acquired.store.check();}),clock(),clock,ctx.runId);
      }});
    if(reply.approval)return {approval:reply.approval};
    return park(reply.result as {complete:boolean;resumeAt?:number});
    } finally {acquired.release();}
  };
}
