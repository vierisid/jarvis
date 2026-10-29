import { fileURLToPath } from 'node:url';
import { CronScheduler, cronWallTimeKey, validateCronExpression } from '../../lib/cron-scheduler';
import { scheduleTriggerPayload } from './schedule-payload';
import { resolveFixtureValue } from './json-mapping-fixtures';
import { digest } from './effect-context';
import { REPORT_PIECE, type ReportRequest } from './weekly-report';
import { collectQuarterlyReport, quarterlySetup, quarterlyTransport, reportQuarters, QUARTERLY_ACTION, QUARTERLY_REQUIRED, type QuarterlySetup } from './quarterly-report';

const ensure = (ok: unknown, message: string) => { if (!ok) throw Error('Quarterly fixture: ' + message); };
const scenarios = ['complete', 'empty', 'source_failure', 'page_failure', 'cursor_cycle', 'page_limit', 'missing_amount', 'missing_currency', 'missing_date', 'account_mismatch', 'open_stage', 'notification_failure', 'notification_uncertain'] as const;
export type QuarterlyScenario = typeof scenarios[number];
export const quarterlyFixtureSetup: QuarterlySetup = { hubspotConnection: 'fixture-hubspot', hubspotPortalId: '42', dealDateProperty: 'closedate', dealStageIds: ['won'], timezone: 'Europe/Rome' };
export const quarterlyFixtureCases = [
  {name:'year rollover',scheduledFor:'2027-01-04T08:00:00Z',expectedQuarter:'2026-Q4',expectedPrior:'2026-Q3',scenario:'complete'},
  {name:'leap February and spring DST',scheduledFor:'2024-04-01T07:00:00Z',expectedQuarter:'2024-Q1',expectedPrior:'2023-Q4',scenario:'complete'},
  {name:'non-leap February',scheduledFor:'2025-04-07T07:00:00Z',expectedQuarter:'2025-Q1',expectedPrior:'2024-Q4',scenario:'complete'},
  {name:'summer quarter',scheduledFor:'2026-07-06T07:00:00Z',expectedQuarter:'2026-Q2',expectedPrior:'2026-Q1',scenario:'complete'},
  {name:'delayed beyond next quarter',scheduledFor:'2026-10-05T07:00:00Z',executedAt:'2027-01-05T08:00:00Z',expectedQuarter:'2026-Q3',expectedPrior:'2026-Q2',scenario:'complete'},
  {name:'second Monday excluded',scheduledFor:'2026-10-12T07:00:00Z',expectedMatch:false,scenario:'complete'},
  ...scenarios.filter(s=>s!=='complete').map(s=>({name:s,scheduledFor:'2026-10-05T07:00:00Z',scenario:s})),
];

/** Synthetic provider only. Every cursor is opaque, so treating it as a page number fails. */
export function quarterlyFixtureRequest(setup: QuarterlySetup, at: string, scenario: QuarterlyScenario, calls: string[] = []): ReportRequest {
  const [current,prior] = reportQuarters(at); let page = 0;
  const row = (id:string,date:number,amount:any,c='EUR') => ({id,properties:{dealstage:setup.dealStageIds[0],[setup.dealDateProperty]:new Date(date).toISOString(),amount,deal_currency_code:c}});
  const currentRow=row('current-eur',current!.start,'150');
  if(scenario==='missing_amount')currentRow.properties.amount=null;
  if(scenario==='missing_currency')currentRow.properties.deal_currency_code='';
  if(scenario==='missing_date')currentRow.properties[setup.dealDateProperty]='';
  return async(provider,path,body)=>{
    ensure(provider==='hubspot'&&body===undefined,'unexpected provider mutation');calls.push(path);
    const u=new URL('https://fixture.invalid'+path);
    if(scenario==='source_failure')throw Error('Fixture source unavailable');
    if(u.pathname==='/account-info/v3/details')return {portalId:scenario==='account_mismatch'?'wrong':setup.hubspotPortalId};
    if(u.pathname===`/crm/v3/properties/deals/${setup.dealDateProperty}`)return {name:setup.dealDateProperty,type:'datetime'};
    if(u.pathname==='/crm/v3/pipelines/deals')return {results:[{stages:setup.dealStageIds.map(id=>({id,metadata:{isClosed:scenario==='open_stage'?'false':'true'}}))}]};
    ensure(u.pathname==='/crm/v3/objects/deals','unexpected endpoint');
    const cursor=u.searchParams.get('after');page++;
    if(scenario==='empty')return {results:[]};
    if(scenario==='page_failure'&&cursor)throw Error('Fixture second page unavailable');
    if(scenario==='cursor_cycle')return {results:[currentRow],paging:{next:{after:'same-cursor'}}};
    if(scenario==='page_limit')return {results:[row('page-'+page,current!.start,'1')],paging:{next:{after:'cursor-'+page}}};
    if(!cursor)return {results:[currentRow,row('prior-eur',prior!.start,'100')],paging:{next:{after:'opaque/two?='}}};
    if(cursor==='opaque/two?=')return {results:[currentRow,row('new-usd',current!.end-1,'25','USD'),row('zero-now',current!.start+1,'0','JPY'),row('zero-before',prior!.start+1,'0','JPY')],paging:{next:{after:'last & page'}}};
    ensure(cursor==='last & page','cursor not followed exactly');
    return {results:[row('prior-end',prior!.end-1,'50'),row('excluded-end',current!.end,'99999'),row('excluded-start',prior!.start-1,'99999'),{...row('open',current!.start,'99999'),properties:{dealstage:'not-selected'}},{...row('archived',current!.start,'99999'),archived:true}]};
  };
}

function prepare(saved:any, fixture:any) {
  ensure(JSON.stringify({saved,fixture}).length<200000,'input limit 200 KB');
  const report=saved?.nextAction, notify=report?.nextAction, expression=saved?.settings?.input?.cron_expression;
  ensure(saved?.type==='PIECE_TRIGGER'&&saved.settings?.pieceName==='schedule'&&saved.settings.input.timezone==='Europe/Rome','requires a Rome schedule');
  ensure(typeof expression==='string','configured cron required');validateCronExpression(expression);
  ensure(report?.type==='PIECE'&&report.settings?.pieceName===REPORT_PIECE&&report.settings.actionName===QUARTERLY_ACTION,'requires quarterly HubSpot action');
  ensure(notify?.type==='PIECE'&&String(notify.settings?.pieceName).endsWith('jarvis-notify')&&notify.settings.actionName==='notify'&&!notify.nextAction,'requires final dashboard summary');
  for(const n of [saved,report,notify]) {
    ensure(!n.firstLoopAction&&!n.children?.length,'branches and loops not covered');
    ensure(!n.settings.propertySettings||Object.keys(n.settings.propertySettings).length===0,'property processors not covered');
    ensure(!n.settings.continueOnFailure&&!n.settings.retryOnFailure&&!n.settings.errorHandlingOptions?.continueOnFailure?.value&&!n.settings.errorHandlingOptions?.retryOnFailure?.value,'retry overrides not covered');
  }
  ensure(report.settings.input?.scheduledFor===`{{${saved.name}.scheduledFor}}`,'report must use scheduledFor');
  const cases=fixture?.cases??quarterlyFixtureCases;
  ensure(Array.isArray(cases)&&cases.length>0&&cases.length<=40,'supply 1-40 cases or omit for the standard suite');
  for(const c of cases) {
    ensure(typeof c.name==='string'&&scenarios.includes(c.scenario),'case requires name and supported scenario');
    reportQuarters(c.scheduledFor);
    ensure(Date.parse(c.scheduledFor)%60000===0,'schedule must be a whole minute');
    if(c.executedAt!==undefined){reportQuarters(c.executedAt);ensure(Date.parse(c.executedAt)>=Date.parse(c.scheduledFor),'execution precedes schedule');}
    ensure(c.expectedMatch===undefined||typeof c.expectedMatch==='boolean','expectedMatch must be boolean');
  }
  return {report,notify,expression,cases};
}

export async function runQuarterlyFixtures(saved:any,fixture:any={}) {
  const {report,notify,expression,cases}=prepare(saved,fixture);
  const {sendNotification}=await import('../activepieces/packages/pieces/jarvis/notify/src/lib/actions/send-notification');
  const results=[];
  const originalFetch=globalThis.fetch;
  try { for(const c of cases) {
    const at=Date.parse(c.scheduledFor), matches=CronScheduler.matchesIn(expression,new Date(at),'Europe/Rome');
    ensure(matches===(c.expectedMatch??true),c.name+': cron match differs');
    if(!matches){results.push({name:c.name,passed:true,status:'NOT_SCHEDULED'});continue;}
    const payload=JSON.parse(JSON.stringify(scheduleTriggerPayload({cronExpression:expression,timezone:'Europe/Rome'},{at,key:cronWallTimeKey(new Date(at),'Europe/Rome'),lateMs:0},at)));
    const props=resolveFixtureValue(report.settings.input,{[saved.name]:payload});
    for(const key of QUARTERLY_REQUIRED)if(props[key]===undefined||props[key]===null||props[key]==='')props[key]=quarterlyFixtureSetup[key];
    const setup=quarterlySetup(props), calls:string[]=[], request=quarterlyFixtureRequest(setup,c.scheduledFor,c.scenario,calls);
    const providerFetch=(async(url:any,init:any)=>{
      const u=new URL(String(url));ensure(u.origin==='https://api.hubapi.com'&&init.method==='GET'&&init.redirect==='error','read-only request scope');
      return Response.json(await request('hubspot',u.pathname+u.search));
    }) as typeof fetch;
    const output=await collectQuarterlyReport(setup,quarterlyTransport('synthetic-fixture',()=>{},providerFetch),props.scheduledFor);
    if(c.expectedQuarter)ensure(output.quarters[0]!.label===c.expectedQuarter,c.name+': quarter differs');
    if(c.expectedPrior)ensure(output.quarters[1]!.label===c.expectedPrior,c.name+': prior quarter differs');
    const unavailable=!['complete','empty','notification_failure','notification_uncertain'].includes(c.scenario);
    ensure(output.partial===unavailable,c.name+': completeness differs');
    if(unavailable)ensure(output.comparisons[0]?.status==='Unavailable',c.name+': partial comparison leaked');
    if(['page_failure','cursor_cycle','page_limit','missing_date'].includes(c.scenario))ensure(output.datasets.every(d=>Object.keys(d.totals).length===0),'partial aggregates leaked');
    if(c.scenario==='complete') {
      ensure(output.datasets[0]!.totals.EUR?.amount==='150'&&output.datasets[1]!.totals.EUR?.amount==='150','page coverage or boundaries differ');
      ensure(output.comparisons.find(x=>x.currency==='USD')?.amountChange.percentage===null,'zero baseline divided');
      ensure(output.comparisons.find(x=>x.currency==='JPY')?.amountChange.label==='No change; both zero','both-zero baseline differs');
      ensure(output.datasets[0]!.coverage.pages===3,'pagination not exercised');
    }
    const input=resolveFixtureValue(notify.settings.input,{[saved.name]:payload,[report.name]:output});
    ensure(input.message===output.summary&&input.idempotencyKey===output.notificationKey,'summary/key must consume report output');
    ensure(JSON.stringify(input.channels)==='["dashboard"]'&&!input.meetingGuard,'dashboard only');
    let notificationCalls=0,status='SUCCEEDED';
    globalThis.fetch=(async(url:any,init:any)=>{
      ensure(url==='http://fixture.invalid/v1/jarvis/notify'&&init.method==='POST','unexpected notification request');notificationCalls++;
      if(c.scenario==='notification_uncertain')throw Error('fixture-response-lost');
      return c.scenario==='notification_failure'?new Response('fixture failure',{status:503}):Response.json({delivered:['dashboard'],failed:[],unknown:[]});
    }) as typeof fetch;
    try {await sendNotification({propsValue:input,server:{apiUrl:'http://fixture.invalid',token:'synthetic-fixture'},step:{name:notify.name},executionPath:[],run:{id:'fixture-run',waitForWaitpoint:()=>{throw Error('Unexpected approval');}}} as any);}
    catch(e){const message=String(e);ensure(c.scenario==='notification_failure'&&message.includes('503')||c.scenario==='notification_uncertain'&&message.includes('fixture-response-lost'),'unexpected notification error');status=c.scenario==='notification_failure'?'FAILED':'UNCERTAIN';}
    ensure(notificationCalls===1,'summary count differs');
    ensure(status===(c.scenario==='notification_failure'?'FAILED':c.scenario==='notification_uncertain'?'UNCERTAIN':'SUCCEEDED'),'notification status differs');
    results.push({name:c.name,passed:true,status,reportStatus:output.status,quarters:output.quarters,totals:output.datasets.map(d=>d.totals),coverage:output.datasets.map(d=>d.coverage),comparisons:output.comparisons,notificationKey:input.idempotencyKey,providerReads:calls.length,notificationCalls,executedAt:c.executedAt??c.scheduledFor});
  } } finally {globalThis.fetch=originalFetch;}
  return {passed:true,definitionDigest:digest(saved),cases:results,externalActions:0,scope:'Saved-graph component fixtures: real cron matcher, serialized occurrence, expression resolver, quarterly collector/read-only HTTP transport and notify transport against synthetic providers. Not end-to-end.',limitations:'No durable worker/DB restart, Authority, real credentials, live HubSpot or dashboard delivery, or persistent notification deduplication. Delays reuse serialized scheduled occurrence.',configuration:'Only empty setup substituted in memory. Saved draft, accounts and workflow runs unchanged.'};
}

export async function validateQuarterlyFixtures(saved:any,fixture:any={}) {
  prepare(saved,fixture);
  const child=Bun.spawn([process.execPath,'--no-env-file',fileURLToPath(import.meta.url)],{env:{},stdin:new Blob([JSON.stringify({saved,fixture})]),stdout:'pipe',stderr:'ignore'});
  let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill();},15000);
  try {
    const reader=child.stdout.getReader(),chunks:Uint8Array[]=[];let size=0;
    for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;ensure(size<=1000000,'output limit 1 MB');chunks.push(n.value);}
    const exit=await child.exited;ensure(!timeout,'fixture timed out');const result=JSON.parse(Buffer.concat(chunks).toString());ensure(exit===0&&result.ok,result.error??'fixture failed');return result.report;
  }finally{clearTimeout(timer);child.kill();}
}
if(import.meta.main){
  globalThis.fetch=(()=>{throw Error('Real network disabled in quarterly fixtures');}) as unknown as typeof fetch;
  try{const {saved,fixture}=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({ok:true,report:await runQuarterlyFixtures(saved,fixture)}));}
  catch(e){console.log(JSON.stringify({ok:false,error:String(e)}));process.exitCode=1;}
}
