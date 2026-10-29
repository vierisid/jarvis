import { SALES_ACCOUNTS, SALES_ACTION, SALES_PIECE, processSalesFollowups, salesSetup, salesTransport } from './sales-followups';
import { salesLedger } from '../db/repos/sales-followup';
import { connectionBindings, enforceRunConnectionBinding, recordRunCredentialOutcome } from '../db/repos/binding-pins';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import { managedConnectionMisuse, managedSourceFor, type CredentialResolver } from '../credentials/adapter';
import { ConnectionCredentialError, OAUTH2_TYPES } from '../credentials/pasted-oauth2';
import { isSalesFollowupsStep, SALES_ACCOUNT_LABELS } from '../sales-accounts';
import { MANAGED_HUBSPOT_REFUSAL } from '../meeting-accounts';

export function createSalesFollowupsService(deps: {effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}) {
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=salesSetup(input);
    const {run,version}=resolveEffectContext(ctx,SALES_PIECE,SALES_ACTION);
    const saved=(await import('../db/flow-graph')).walkFlowNodes(version.trigger).find(n=>n.name===ctx.stepName);
    if(!saved||!isSalesFollowupsStep(saved.type,saved.settings))throw Error('Sales configuration must match a saved sales follow-up step');
    if(digest(salesSetup(saved.settings?.input ?? {}))!==digest(setup))throw Error('Sales setup must match the saved workflow step');
    const reply=await deps.effects.invoke({context:ctx,piece:SALES_PIECE,action:SALES_ACTION,route:'sales-followups',
      toolName:'workflow_sales_followups',category:'write_data',categories:['read_data','write_data'],toolCategory:'sales',request:{...setup},
      prepare:()=>({arguments:{...setup},target:{crm:'hubspot',mailbox:setup.ownerEmail,accounts:[setup.hubspotConnection,setup.gmailConnection],effect:'Create unsent Gmail drafts only; never send'}}),
      execute:async(args,checkpoint)=>{
        const s=salesSetup(args),tokens={} as {hubspot:string;gmail:string};
        const check=()=>{
          checkpoint();
          for(const field of Object.keys(SALES_ACCOUNTS) as Array<keyof typeof SALES_ACCOUNTS>){
            const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,s[field],deps.credentials);if(refusal)throw Error(refusal);
          }
        };
        const fields=Object.keys(SALES_ACCOUNTS) as Array<keyof typeof SALES_ACCOUNTS>;
        // The readiness rule, for every account before any binding is checked or
        // anything is resolved: a managed connection only by the sales exemption
        // (jarvis:google as the Gmail account of the saved step), so a refused id writes nothing.
        for(const field of fields){
          const externalId=s[field];
          if(!connectionBindings(version.trigger).has(externalId))throw Error('Sales account is not bound to this workflow');
          if(externalId.startsWith('jarvis:')){
            if(field==='hubspotConnection')throw Error(MANAGED_HUBSPOT_REFUSAL);
            const source=managedSourceFor(deps.credentials.list(),externalId);
            const misuse=source?managedConnectionMisuse(source,SALES_ACCOUNTS[field],`settings.input.${field}`,saved.settings,saved.type):'Managed connection source is unavailable';
            if(misuse)throw Error(misuse);
          }
        }
        for(const field of fields){
          const pieceName=SALES_ACCOUNTS[field],externalId=s[field];
          check();let resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
          if(resolved?.pieceName&&resolved.pieceName!==pieceName)throw Error('Sales account belongs to a different provider');
          if(!resolved||resolved.type!=='OAUTH2'||resolved.status&&resolved.status!=='ACTIVE')throw Error('Connect the selected account securely before running');
          // A stored OAuth2 token is refreshed when it is about to expire, only
          // after the run's binding check passed (as the engine's connection route does).
          try{resolved=await deps.credentials.fresh(resolved);}
          catch(error){
            if(!(error instanceof ConnectionCredentialError))throw error;
            // Typed on the run's binding, as the engine's connection route records it, for the failure card.
            recordRunCredentialOutcome(ctx.runId,externalId,{code:error.code,message:error.message});
            // Only an expired or refused credential needs a person to reconnect; the others pass.
            const account=`the selected ${SALES_ACCOUNT_LABELS[field]} account (${externalId})`;
            throw Error(error.code==='CONNECTION_EXPIRED'?`Reconnect ${account}: ${error.message}`
              :error.code==='CONNECTION_REFRESH_UNREACHABLE'?`Nothing was read: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later. ${error.message}`
              :`Nothing was read: ${account} changed while Jarvis refreshed it. Start a new run. ${error.message}`);
          }
          if(resolved.stored&&OAUTH2_TYPES.has(resolved.type))recordRunCredentialOutcome(ctx.runId,externalId,null);
          if(typeof resolved.value.access_token!=='string')throw Error('Connect the selected account securely before running');
          tokens[field.replace('Connection','') as keyof typeof tokens]=resolved.value.access_token;
        }
        const result=await processSalesFollowups(s,salesTransport(tokens,check,deps.fetchImpl),salesLedger(ctx.runId),digest([ctx.projectId,run.flowId]),deps.now,check);
        // One summary per run, not per day: a later run the same day can save new drafts or report uncertain ones, so it is never suppressed.
        return {...result,notificationKey:`sales-summary:${ctx.runId}`};
      }});
    return reply.approval?{approval:reply.approval}:reply.result;
  };
}
