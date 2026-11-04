import { fileURLToPath } from 'node:url';
import { sanitizedEnv } from '../../util/subprocess-env';
import { CronScheduler, cronWallTimeKey, validateCronExpression } from '../../lib/cron-scheduler';
import { scheduleTriggerPayload } from './schedule-payload';
import { resolveFixtureValue } from './json-mapping-fixtures';
import { digest } from './effect-context';
import { REPORT_PIECE, type ReportRequest } from './weekly-report';
import { canonicalZone, effectiveScheduleZone } from '../runner/triggers/schedule-zone';
import { QUARTERLY_ZONE, collectQuarterlyReport, quarterlySetup, quarterlyTransport, reportQuarters, QUARTERLY_ACTION, QUARTERLY_REQUIRED, type QuarterlySetup } from './quarterly-report';

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

type Deal = { id: string; archived?: boolean; properties: Record<string, any> };
const dealTime = (raw: unknown) => typeof raw === 'string' && /^\d{13}$/.test(raw) ? Number(raw) : typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
/** A synthetic HubSpot deal store answering CRM search as HubSpot documents it (https://developers.hubspot.com/docs/api/crm/search):
 * filters applied, archived deals never returned, ascending hs_object_id, offset `after` paging, `total`, and a 400 past
 * 10,000 results. `pageSize` below the requested limit exercises pagination. */
export function hubspotDealStore(deals: Deal[], pageSize = 200) {
  return (path: string, body?: Record<string, any>): Record<string, any> => {
    const u = new URL('https://fixture.invalid' + path);
    ensure(u.pathname === '/crm/v3/objects/deals/search' && body, 'unexpected endpoint');
    const filters = body!.filterGroups[0].filters as Array<Record<string, any>>, offset = Number(body!.after ?? 0);
    if (offset + body!.limit > 10000) throw Error('Fixture HubSpot search past 10,000 results (HTTP 400)');
    const all = deals.filter(d => !d.archived && filters.every(f => {
      const v = d.properties[f.propertyName];
      if (f.operator === 'IN') return f.values.includes(v);
      if (f.operator === 'NOT_HAS_PROPERTY') return v == null || v === '';
      const t = dealTime(v);
      return f.operator === 'GTE' ? t >= Number(f.value) : f.operator === 'LT' ? t < Number(f.value) : (() => { throw Error('Fixture: unsupported operator'); })();
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const results = all.slice(offset, offset + Math.min(body!.limit, pageSize));
    return { total: all.length, results, ...offset + results.length < all.length ? { paging: { next: { after: String(offset + results.length) } } } : {} };
  };
}

/** Synthetic provider only. */
export function quarterlyFixtureRequest(setup: QuarterlySetup, at: string, scenario: QuarterlyScenario, calls: string[] = []): ReportRequest {
  const [current,prior] = reportQuarters(at);
  const row = (id:string,date:number,amount:any,c='EUR'):Deal => ({id,properties:{dealstage:setup.dealStageIds[0],[setup.dealDateProperty]:new Date(date).toISOString(),amount,deal_currency_code:c}});
  const currentRow=row('current-eur',current!.start,'150');
  if(scenario==='missing_amount')currentRow.properties.amount=null;
  if(scenario==='missing_currency')currentRow.properties.deal_currency_code='';
  if(scenario==='missing_date')currentRow.properties[setup.dealDateProperty]='';
  const deals:Deal[]=scenario==='empty'?[]:[currentRow,row('prior-eur',prior!.start,'100'),row('new-usd',current!.end-1,'25','USD'),row('zero-now',current!.start+1,'0','JPY'),row('zero-before',prior!.start+1,'0','JPY'),
    row('prior-end',prior!.end-1,'50'),row('excluded-end',current!.end,'99999'),row('excluded-start',prior!.start-1,'99999'),{...row('open',current!.start,'99999'),properties:{...row('open',current!.start,'99999').properties,dealstage:'not-selected'}},{...row('archived',current!.start,'99999'),archived:true}];
  // One deal a page, so every quarter takes several pages.
  const store=hubspotDealStore(deals,1);
  return async(provider,path,body)=>{
    ensure(provider==='hubspot'&&(body===undefined||path==='/crm/v3/objects/deals/search'),'unexpected provider mutation');calls.push(path);
    const u=new URL('https://fixture.invalid'+path);
    if(scenario==='source_failure')throw Error('Fixture source unavailable');
    if(u.pathname==='/account-info/v3/details')return {portalId:scenario==='account_mismatch'?'wrong':setup.hubspotPortalId};
    if(u.pathname===`/crm/v3/properties/deals/${setup.dealDateProperty}`)return {name:setup.dealDateProperty,type:'datetime'};
    if(u.pathname==='/crm/v3/pipelines/deals')return {results:[{stages:setup.dealStageIds.map(id=>({id,metadata:{isClosed:scenario==='open_stage'?'false':'true'}}))}]};
    const dated=body?.filterGroups?.[0]?.filters?.length===3;
    if(scenario==='page_failure'&&dated&&body!.after!==undefined)throw Error('Fixture second page unavailable');
    const page=store(path,body);
    if(scenario==='cursor_cycle'&&dated&&page.paging)page.paging.next.after='0';
    // `page_limit` keeps its name for saved fixture cases; it now models the search limit: every window reports a
    // full 10,000-result cap, so no split can ever be read completely.
    if(scenario==='page_limit'&&dated)return {...page,total:10000};
    return page;
  };
}

function prepare(saved:any, fixture:any) {
  ensure(JSON.stringify({saved,fixture}).length<200000,'input limit 200 KB');
  const report=saved?.nextAction, notify=report?.nextAction, expression=saved?.settings?.input?.cron_expression;
  ensure(saved?.type==='PIECE_TRIGGER'&&saved.settings?.pieceName==='schedule'&&canonicalZone(effectiveScheduleZone(saved.settings))===QUARTERLY_ZONE,'requires a schedule that fires in Europe/Rome (choose that time zone)');
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
      const u=new URL(String(url)),search=u.pathname==='/crm/v3/objects/deals/search';
      ensure(u.origin==='https://api.hubapi.com'&&init.method===(search?'POST':'GET')&&init.redirect==='error','read-only request scope');
      return Response.json(await request('hubspot',u.pathname+u.search,search?JSON.parse(init.body):undefined));
    }) as typeof fetch;
    // Synthetic provider: no search pacing is needed.
    const output=await collectQuarterlyReport(setup,quarterlyTransport('synthetic-fixture',()=>{},providerFetch,undefined,0),props.scheduledFor);
    if(c.expectedQuarter)ensure(output.quarters[0]!.label===c.expectedQuarter,c.name+': quarter differs');
    if(c.expectedPrior)ensure(output.quarters[1]!.label===c.expectedPrior,c.name+': prior quarter differs');
    const unavailable=!['complete','empty','missing_amount','notification_failure','notification_uncertain'].includes(c.scenario);
    ensure(output.partial===unavailable,c.name+': completeness differs');
    if(unavailable)ensure(output.comparisons[0]?.status==='Unavailable',c.name+': partial comparison leaked');
    // Unavailable for the scenario's own reason, never a fixture fault that also reads as Unavailable.
    const reason:Record<string,string>={source_failure:'Fixture source unavailable',page_failure:'second page unavailable',cursor_cycle:'Repeated or invalid cursor',page_limit:'cannot be split',
      missing_currency:'company currency is unknown',missing_date:'Selected date missing',account_mismatch:'portal mismatch',open_stage:'available closed stages'};
    if(unavailable)ensure(output.datasets.some(d=>d.coverage.reason?.includes(reason[c.scenario]!)),c.name+': Unavailable for another reason');
    if(['page_failure','cursor_cycle','page_limit','missing_date'].includes(c.scenario))ensure(output.datasets.every(d=>Object.keys(d.totals).length===0),'partial aggregates leaked');
    // A deal with no amount is left out of totals and disclosed by count; the quarter stays complete.
    if(c.scenario==='missing_amount')ensure(output.datasets[0]!.noAmount===1&&!output.datasets[0]!.totals.EUR&&output.datasets[1]!.totals.EUR?.amount==='150'&&output.summary.includes('1 deal with no amount not included'),'missing amount must be disclosed, not counted');
    if(c.scenario==='complete') {
      ensure(output.datasets[0]!.totals.EUR?.amount==='150'&&output.datasets[1]!.totals.EUR?.amount==='150','page coverage or boundaries differ');
      ensure(output.comparisons.find(x=>x.currency==='USD')?.amountChange.percentage===null,'zero baseline divided');
      ensure(output.comparisons.find(x=>x.currency==='JPY')?.amountChange.label==='No change; both zero','both-zero baseline differs');
      ensure(output.datasets[0]!.coverage.pages===6,'pagination not exercised');
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
  const child=Bun.spawn([process.execPath,'--no-env-file',fileURLToPath(import.meta.url)],{env:sanitizedEnv(),stdin:new Blob([JSON.stringify({saved,fixture})]),stdout:'pipe',stderr:'ignore'});
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
