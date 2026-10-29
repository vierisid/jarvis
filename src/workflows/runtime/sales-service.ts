import { SALES_ACCOUNTS, SALES_ACTION, SALES_PIECE, processSalesFollowups, salesSetup, salesTransport } from './sales-followups';
import { salesLedger } from '../db/repos/sales-followup';
import { connectionBindings, enforceRunConnectionBinding } from '../db/repos/binding-pins';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import type { CredentialResolver } from '../credentials/adapter';

export function createSalesFollowupsService(deps: {effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}) {
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=salesSetup(input);
    const {run,version}=resolveEffectContext(ctx,SALES_PIECE,SALES_ACTION);
    const saved=(await import('../db/flow-graph')).walkFlowNodes(version.trigger).find(n=>n.name===ctx.stepName)!;
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
        for(const [field,pieceName] of Object.entries(SALES_ACCOUNTS)){
          const externalId=s[field as keyof typeof SALES_ACCOUNTS];
          if(!connectionBindings(version.trigger).has(externalId))throw Error('Sales account is not bound to this workflow');
          check();const resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
          const google=externalId==='jarvis:google'||externalId.startsWith('jarvis:google:');
          if(externalId.startsWith('jarvis:')&&(!google||field==='hubspotConnection')||resolved?.pieceName&&resolved.pieceName!==pieceName)throw Error('Sales account belongs to a different provider');
          if(!resolved||resolved.type!=='OAUTH2'||resolved.status&&resolved.status!=='ACTIVE'||typeof resolved.value.access_token!=='string')throw Error('Connect the selected account securely before running');
          tokens[field.replace('Connection','') as keyof typeof tokens]=resolved.value.access_token;
        }
        const result=await processSalesFollowups(s,salesTransport(tokens,check,deps.fetchImpl),salesLedger(ctx.runId),digest([ctx.projectId,run.flowId]),deps.now,check);
        // One summary per run, not per day: a later run the same day can save new drafts or report uncertain ones, so it is never suppressed.
        return {...result,notificationKey:`sales-summary:${ctx.runId}`};
      }});
    return reply.approval?{approval:reply.approval}:reply.result;
  };
}
