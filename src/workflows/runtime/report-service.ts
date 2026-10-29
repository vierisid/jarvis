import {collectWeeklyReport,reportSetup,reportTransport,saveWeeklyReport,type ReportProvider} from './weekly-report';
import {reportReceipt} from '../db/repos/weekly-report';
import {connectionBindings,enforceRunConnectionBinding,recordRunCredentialOutcome} from '../db/repos/binding-pins';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import type {WorkflowEffectBoundary} from './effect-boundary';
import type {CredentialResolver} from '../credentials/adapter';
import {ConnectionCredentialError,OAUTH2_TYPES} from '../credentials/pasted-oauth2';
import {REPORT_ACCOUNTS,REPORT_ACCOUNT_LABELS,REPORT_ACTION,REPORT_PIECE,isWeeklyReportStep,managedReportRefusal} from '../report-accounts';
export function createWeeklyReportService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}){
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=reportSetup(input),{run,version}=resolveEffectContext(ctx,REPORT_PIECE,REPORT_ACTION);
    const saved=(await import('../db/flow-graph')).walkFlowNodes(version.trigger).find(n=>n.name===ctx.stepName);
    if(!saved||!isWeeklyReportStep(saved.type,saved.settings))throw Error('Report configuration must match a saved weekly report step');
    if(digest(reportSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Report setup must match saved workflow');
    const reply=await deps.effects.invoke({context:ctx,piece:REPORT_PIECE,action:REPORT_ACTION,route:'weekly-report',toolName:'workflow_weekly_report',category:'write_data',categories:['read_data','write_data'],toolCategory:'reports',request:{...setup},
      prepare:()=>({arguments:{...setup},target:{accounts:[setup.stripeConnection,setup.hubspotConnection,setup.googleConnection],folder:setup.folderId,effect:'Read selected financial/CRM sources; create and verify one new report Doc. No source mutations or sharing.'}}),
      execute:async(args,checkpoint)=>{
        const s=reportSetup(args),tokens={} as Record<ReportProvider,string>;
        const fields=Object.keys(REPORT_ACCOUNTS) as Array<keyof typeof REPORT_ACCOUNTS>;
        const check=()=>{checkpoint();for(const field of fields){const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,s[field],deps.credentials);if(refusal)throw Error(refusal);}};
        // The readiness rule, for every account before any binding is checked or anything is
        // resolved: the saved step itself names it, and no managed connection is accepted
        // (no exemption covers the report), so a refused id reads and writes nothing.
        for(const field of fields){
          const externalId=s[field];
          if(saved.settings?.input?.[field]!==externalId)throw Error('Report account must match the saved workflow step');
          if(!connectionBindings(version.trigger).has(externalId))throw Error('Report account not bound');
          if(externalId.startsWith('jarvis:'))throw Error(managedReportRefusal(field));
        }
        for(const field of fields){
          const pieceName=REPORT_ACCOUNTS[field],externalId=s[field];
          check();let resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
          if(resolved?.pieceName&&resolved.pieceName!==pieceName)throw Error('Report account provider mismatch');
          const usable=resolved?.type==='OAUTH2'||field==='stripeConnection'&&resolved?.type==='SECRET_TEXT';
          if(!resolved||!usable||resolved.status&&resolved.status!=='ACTIVE')throw Error('Connect the selected report accounts securely before running');
          // A stored OAuth2 token is refreshed when it is about to expire, only
          // after the run's binding check passed (as the engine's connection route does).
          try{resolved=await deps.credentials.fresh(resolved);}
          catch(error){
            if(!(error instanceof ConnectionCredentialError))throw error;
            // Typed on the run's binding, as the engine's connection route records it, for the failure card.
            recordRunCredentialOutcome(ctx.runId,externalId,{code:error.code,message:error.message});
            // Only an expired or refused credential needs a person to reconnect; the others pass.
            const account=`the selected ${REPORT_ACCOUNT_LABELS[field]} account (${externalId})`;
            throw Error(error.code==='CONNECTION_EXPIRED'?`Reconnect ${account}: ${error.message}`
              :error.code==='CONNECTION_REFRESH_UNREACHABLE'?`Nothing was read: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later. ${error.message}`
              :`Nothing was read: ${account} changed while Jarvis refreshed it. Start a new run. ${error.message}`);
          }
          if(resolved.stored&&OAUTH2_TYPES.has(resolved.type))recordRunCredentialOutcome(ctx.runId,externalId,null);
          const token=resolved.type==='OAUTH2'?resolved.value.access_token:resolved.type==='SECRET_TEXT'?resolved.value.secret_text:undefined;
          if(typeof token!=='string'||!token)throw Error('Connect the selected report accounts securely before running');
          tokens[field.replace('Connection','') as ReportProvider]=token;
        }
        const request=reportTransport(tokens,check,deps.fetchImpl),report=await collectWeeklyReport(s,request,(deps.now??Date.now)(),check);
        check();const key=digest(['weekly-report-v1',ctx.projectId,run.flowId,s,report.weeks[0]!.localStart]);
        return saveWeeklyReport(s,report,request,reportReceipt(ctx.runId),key);
      }});
    return reply.approval?{approval:reply.approval}:reply.result;
  };
}
