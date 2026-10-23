import {REPORT_ACCOUNTS,REPORT_ACTION,REPORT_PIECE,collectWeeklyReport,reportSetup,reportTransport,saveWeeklyReport,type ReportProvider} from './weekly-report';
import {reportReceipt} from '../db/repos/weekly-report';
import {connectionBindings,enforceRunConnectionBinding} from '../db/repos/binding-pins';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import type {WorkflowEffectBoundary} from './effect-boundary';
import type {CredentialResolver} from '../credentials/adapter';
export function createWeeklyReportService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}){
  return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
    const setup=reportSetup(input),{run,version}=resolveEffectContext(ctx,REPORT_PIECE,REPORT_ACTION);
    const saved=(await import('../db/flow-graph')).walkFlowNodes(version.trigger).find(n=>n.name===ctx.stepName)!;
    if(digest(reportSetup(saved.settings?.input??{}))!==digest(setup))throw Error('Report setup must match saved workflow');
    const reply=await deps.effects.invoke({context:ctx,piece:REPORT_PIECE,action:REPORT_ACTION,route:'weekly-report',toolName:'workflow_weekly_report',category:'write_data',categories:['read_data','write_data'],toolCategory:'reports',request:{...setup},
      prepare:()=>({arguments:{...setup},target:{accounts:[setup.stripeConnection,setup.hubspotConnection,setup.googleConnection],folder:setup.folderId,effect:'Read selected financial/CRM sources; create and verify one new report Doc. No source mutations or sharing.'}}),
      execute:async(args,checkpoint)=>{
        const s=reportSetup(args),tokens={} as Record<ReportProvider,string>;
        const check=()=>{checkpoint();for(const field of Object.keys(REPORT_ACCOUNTS) as Array<keyof typeof REPORT_ACCOUNTS>){const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,s[field],deps.credentials);if(refusal)throw Error(refusal);}};
        for(const [field,pieceName] of Object.entries(REPORT_ACCOUNTS)){
          const externalId=s[field as keyof typeof REPORT_ACCOUNTS];check();if(!connectionBindings(version.trigger).has(externalId))throw Error('Report account not bound');
          const resolved=await deps.credentials.resolve({projectId:ctx.projectId,pieceName,externalId});
          const managedGoogle=externalId==='jarvis:google'||externalId.startsWith('jarvis:google:');
          if(externalId.startsWith('jarvis:')&&(!managedGoogle||field!=='googleConnection')||resolved?.pieceName&&resolved.pieceName!==pieceName)throw Error('Report account provider mismatch');
          const token=resolved?.type==='OAUTH2'?resolved.value.access_token:field==='stripeConnection'&&resolved?.type==='SECRET_TEXT'?resolved.value.secret_text:undefined;
          if(!resolved||resolved.status&&resolved.status!=='ACTIVE'||typeof token!=='string'||!token)throw Error('Connect the selected report accounts securely before running');
          tokens[field.replace('Connection','') as ReportProvider]=token;
        }
        const request=reportTransport(tokens,check,deps.fetchImpl),report=await collectWeeklyReport(s,request,(deps.now??Date.now)(),check);
        check();const key=digest(['weekly-report-v1',ctx.projectId,run.flowId,s,report.weeks[0]!.localStart]);
        return saveWeeklyReport(s,report,request,reportReceipt(ctx.runId),key);
      }});
    return reply.approval?{approval:reply.approval}:reply.result;
  };
}
