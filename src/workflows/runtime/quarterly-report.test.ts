import {afterEach,expect,test} from 'bun:test';
import {CronScheduler,setCronTimezone} from '../../lib/cron-scheduler';
import {collectQuarterlyReport,missingDateSearchBody,quarterlySetup,quarterlyTransport,reportQuarters} from './quarterly-report';
import {hubspotSearchBody,SOURCE_READ_BUDGET_MS} from './weekly-report';
import {quarterlyFixtureSetup as setup,quarterlyFixtureRequest,validateQuarterlyFixtures,quarterlyFixtureCases,hubspotDealStore} from './quarterly-report-fixtures';
import graph from './fixtures/quarterly-report-generated.json';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {createFlow,getFlow} from '../db/repos/flow';
import {createDraftVersion,getFlowVersion} from '../db/repos/flow-version';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {PieceCatalog} from './piece-catalog';
import {compileWorkflow} from './workflow-readiness';
const at='2026-10-05T07:00:00Z';
afterEach(()=>closeWorkflowDb());
test('two complete Rome quarters use civil boundaries, leap year and year rollover',()=>{
  expect(reportQuarters('2024-04-01T07:00:00Z').map(q=>[q.label,new Date(q.start).toISOString(),new Date(q.end).toISOString()])).toEqual([
    ['2024-Q1','2023-12-31T23:00:00.000Z','2024-03-31T22:00:00.000Z'],['2023-Q4','2023-09-30T22:00:00.000Z','2023-12-31T23:00:00.000Z']]);
  expect(reportQuarters('2027-01-04T08:00:00Z').map(q=>q.label)).toEqual(['2026-Q4','2026-Q3']);
  expect(reportQuarters('2026-09-30T22:00:00Z')[0]!.label).toBe('2026-Q3');
  expect(()=>reportQuarters('2026-10-05')).toThrow('persisted');
});
test('cron starts exactly once each quarter at 09:00 Rome, 2023 through 2030',()=>{
  for(let year=2023;year<=2030;year++)for(let month=0;month<12;month++){
    const days=[];for(let day=1;day<=31;day++){
      const date=new Date(Date.UTC(year,month,day));if(date.getUTCMonth()!==month)continue;
      const offset=month>=3&&month<=9?2:1;date.setUTCHours(9-offset);
      if(CronScheduler.matchesIn(graph.settings.input.cron_expression,date,'Europe/Rome'))days.push(day);
    }
    if(month%3!==0)expect(days).toEqual([]);
    else {const expected=1+(8-new Date(Date.UTC(year,month,1)).getUTCDay())%7;expect(days).toEqual([expected]);}
  }
});
test('all saved graph fixture scenarios pass with no configuration mutation',async()=>{
  const before=JSON.stringify(graph),result=await validateQuarterlyFixtures(graph);
  expect(result.passed).toBe(true);expect(result.cases).toHaveLength(quarterlyFixtureCases.length);expect(result.externalActions).toBe(0);expect(JSON.stringify(graph)).toBe(before);
});
test('all pages, boundary inclusion, duplicate IDs, separate currencies and empty periods',async()=>{
  const report=await collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,'complete'),at);
  expect(report.datasets.map(d=>d.totals.EUR)).toEqual([{count:1,amount:'150'},{count:2,amount:'150'}]);
  expect(report.comparisons.find(c=>c.currency==='USD')!.amountChange).toMatchObject({delta:'25',percentage:null});
  const empty=await collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,'empty'),at);expect(empty.complete).toBe(true);expect(empty.comparisons[0]!.countCurrent).toBe(0);
});
test('invalid dates/cursors/amounts/currencies never become complete zero totals',async()=>{
  for(const scenario of ['missing_currency','missing_date','cursor_cycle','page_limit','page_failure'] as const){
    const report=await collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,scenario),at);
    expect(report.complete).toBe(false);expect(report.datasets[0]!.totals).toEqual({});expect(report.summary).toContain('Unavailable');
    if(scenario==='missing_currency')expect(report.datasets[1]!.totals.EUR?.amount).toBe('150');
  }
});
test('a deal with no amount is left out of totals and disclosed by count, not zero and not Unavailable',async()=>{
  const report=await collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,'missing_amount'),at);
  expect(report.complete).toBe(true);expect(report.datasets[0]!.noAmount).toBe(1);expect(report.datasets[0]!.totals.EUR).toBeUndefined();
  expect(report.datasets[1]!.totals.EUR).toEqual({count:2,amount:'150'});expect(report.datasets[1]!.noAmount).toBeUndefined();
  expect(report.summary).toContain('current: excluded from totals: 1 deal with no amount not included');
});
test('unknown dates invalidate both periods; selected stages and date property remain strict',async()=>{
  expect(()=>quarterlySetup({...setup,dealStageIds:[]})).toThrow();expect(()=>quarterlySetup({...setup,dealDateProperty:''})).toThrow();
  const base=quarterlyFixtureRequest(setup,at,'complete');
  for(const mutation of ['changed_between_reads','malformed_page','missing_cursor','date_property']){
    const seen=new Set<string>();
    const report=await collectQuarterlyReport(setup,async(p,path,b)=>{const r=structuredClone(await base(p,path,b));
      const dated=b?.filterGroups?.[0]?.filters?.length===3,key=JSON.stringify(b),repeat=seen.has(key);if(dated)seen.add(key);
      if(dated&&b!.after!==undefined){
        if(mutation==='malformed_page')r.results=null;
        if(mutation==='missing_cursor')r.paging={next:{}};
      }
      // The confirming read sees a deal changed since the first complete read.
      if(mutation==='changed_between_reads'&&dated&&repeat&&r.results.length)r.results[0].properties.amount='2';
      if(mutation==='date_property'&&path.includes('/properties/'))r.type='string';return r;},at);
    expect(report.complete).toBe(false);expect(report.datasets.every(d=>Object.keys(d.totals).length===0)).toBe(true);
    const reason={changed_between_reads:'changed between the two complete reads',malformed_page:'Malformed result page',missing_cursor:'continuation cursor missing',date_property:'datetime date property'}[mutation]!;
    expect(report.datasets.map(d=>d.coverage.reason)).toEqual([expect.stringContaining(reason),expect.stringContaining(reason)]);
  }
});
// #1244: a portal's deals outside the two quarters, however many, do not make either quarter Unavailable.
function portal(deals:any[]){
  const store=hubspotDealStore(deals),searches:any[]=[];
  const request=async(_p:string,path:string,body?:any)=>{
    if(path==='/account-info/v3/details')return {portalId:setup.hubspotPortalId,companyCurrency:'EUR'};
    if(path===`/crm/v3/properties/deals/${setup.dealDateProperty}`)return {name:setup.dealDateProperty,type:'datetime'};
    if(path==='/crm/v3/pipelines/deals')return {results:[{stages:setup.dealStageIds.map(id=>({id,metadata:{isClosed:'true'}}))}]};
    if(body)searches.push(body);
    return store(path,body);
  };
  return {request:request as any,searches};
}
const deal=(id:number,t:number,amount='1')=>({id:String(id).padStart(8,'0'),properties:{dealstage:setup.dealStageIds[0],[setup.dealDateProperty]:String(t),amount,deal_currency_code:'EUR'}});
test('#1244: 25,000 older deals in the portal leave both quarters complete, read by quarter',async()=>{
  const [current,prior]=reportQuarters(at);
  const deals=[...Array.from({length:25_000},(_,i)=>deal(i,prior!.start-1-i*60_000)),deal(30_001,current!.start,'10'),deal(30_002,prior!.end-1,'5')];
  const {request,searches}=portal(deals);
  const report=await collectQuarterlyReport(setup,request,at);
  expect(report.status).toBe('Complete');
  expect(report.datasets.map(d=>d.totals.EUR)).toEqual([{count:1,amount:'10'},{count:1,amount:'5'}]);
  // Each quarter's own date range, nothing else.
  const windows=searches.filter(b=>b.filterGroups[0].filters.length===3).map(b=>b.filterGroups[0].filters.slice(1).map((f:any)=>Number(f.value)));
  expect(new Set(windows.map(w=>JSON.stringify(w)))).toEqual(new Set([JSON.stringify([current!.start,current!.end]),JSON.stringify([prior!.start,prior!.end])]));
});
test('#1244: a quarter above the 10,000-result search cap is split and still complete',async()=>{
  const [current]=reportQuarters(at),span=current!.end-current!.start;
  const deals=Array.from({length:12_000},(_,i)=>deal(i,current!.start+Math.floor(i*span/12_000)));
  const {request,searches}=portal(deals);
  const report=await collectQuarterlyReport(setup,request,at);
  expect(report.datasets[0]!.coverage.status).toBe('Complete');
  expect(report.datasets[0]!.totals.EUR).toEqual({count:12_000,amount:'12000'});
  expect(searches.every(b=>Number(b.after??0)+b.limit<=10_000)).toBe(true);
});
test('#1244: a quarter whose confirming read runs out of the source time budget is Unavailable, not partial',async()=>{
  const [current]=reportQuarters(at);let now=0,searches=0;
  // 450 deals: three pages a read. The first complete read lands, then the clock passes the budget mid-confirmation.
  const {request}=portal(Array.from({length:450},(_,i)=>deal(i,current!.start+i,'10')));
  const report=await collectQuarterlyReport(setup,async(p:any,path:string,b:any)=>{if(b&&b.filterGroups[0].filters.length===3&&++searches===5)now+=SOURCE_READ_BUDGET_MS;return request(p,path,b);},at,()=>{},()=>now);
  expect(searches).toBe(5);expect(report.datasets[0]!.coverage.pages).toBe(5);
  expect(report.complete).toBe(false);expect(report.datasets[0]!.coverage.reason).toContain('time budget');expect(report.datasets[0]!.totals).toEqual({});
  expect(report.datasets[1]!.coverage.reason).toContain('time budget');
});
test('negative prior amount is labelled N/A and exact decimal arithmetic is retained',async()=>{
  const request=quarterlyFixtureRequest(setup,at,'complete');const report=await collectQuarterlyReport(setup,async(p,path,b)=>{
    const data=await request(p,path,b);for(const r of data.results??[])if(r.id==='prior-eur')r.properties.amount='-100.000001';return data;
  },at);expect(report.comparisons.find(c=>c.currency==='EUR')!.amountChange).toMatchObject({delta:'200.000001',percentage:null,label:'Percentage N/A: negative prior baseline'});
});
test('read-only transport rejects provider writes, redirects and all unrelated providers',async()=>{
  const methods:string[]=[];const request=quarterlyTransport('fixture',()=>{},(async(url:any,init:any)=>{methods.push(init.method);expect(init.redirect).toBe('error');return Response.json({results:[]});}) as typeof fetch,async()=>{},0);
  await request('hubspot','/crm/v3/pipelines/deals');
  await request('hubspot','/crm/v3/objects/deals/search',hubspotSearchBody(setup,1,2));
  await request('hubspot','/crm/v3/objects/deals/search',missingDateSearchBody(setup));
  expect(methods).toEqual(['GET','POST','POST']);
  const write={...hubspotSearchBody(setup,1,2),inputs:[{properties:{amount:'1'}}]};
  for(const [provider,path,body] of [['hubspot','/crm/v3/pipelines/deals',{}],['hubspot','/crm/v3/objects/deals',undefined],['hubspot','/crm/v3/objects/deals/batch/update',hubspotSearchBody(setup,1,2)],
    ['hubspot','/crm/v3/objects/deals/search',write],['hubspot','/crm/v3/objects/contacts/search',hubspotSearchBody(setup,1,2)],['hubspot','/crm/v3/objects/deals/search?x=1',hubspotSearchBody(setup,1,2)],
    ['google','/drive/v3/files',undefined],['hubspot','//evil.invalid',undefined]] as const){
    await expect(Promise.resolve().then(()=>request(provider,path,body as any))).rejects.toThrow();
  }
  expect(methods).toHaveLength(3);
});
test('searches are paced under HubSpot\'s five a second; plain reads are not',async()=>{
  const waits:number[]=[];const request=quarterlyTransport('fixture',()=>{},(async()=>Response.json({results:[]})) as unknown as typeof fetch,async ms=>{waits.push(ms);},250);
  await request('hubspot','/crm/v3/pipelines/deals');await request('hubspot','/crm/v3/objects/deals/search',hubspotSearchBody(setup,1,2));
  await request('hubspot','/crm/v3/objects/deals/search',hubspotSearchBody(setup,1,2));
  expect(waits).toHaveLength(1);expect(waits[0]!).toBeGreaterThan(0);expect(waits[0]!).toBeLessThanOrEqual(250);
});
test('cancellation stops even if a source failure could be reported unavailable',async()=>{
  await expect(collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,'source_failure'),at,()=>{throw Error('Cancelled');})).rejects.toThrow('Cancelled');
});
const catalog=new PieceCatalog([
  {name:'@jarvispieces/piece-jarvis-report',displayName:'Reports',description:'',actions:{quarterly_hubspot_report:{name:'quarterly_hubspot_report',displayName:'Quarterly',description:'',inputSchema:{fields:['hubspotConnection','hubspotPortalId','dealDateProperty','dealStageIds','timezone','scheduledFor'].map(k=>({name:k,type:'string' as const,label:k,required:true}))}}}},
  {name:'@jarvispieces/piece-jarvis-notify',displayName:'Notify',description:'',actions:{notify:{name:'notify',displayName:'Notify',description:''}}},
]);
test('public fixture tool validates saved graph without needing account setup or runs',async()=>{
  initWorkflowDb(':memory:');const flow=createFlow(),version=createDraftVersion({flowId:flow.id,displayName:'Quarterly fixture',trigger:graph as any});
  const before=JSON.stringify(getFlowVersion(version.id));const tool=createManageWorkflowTool({pieceRegistry:catalog});
  const text=String(await tool.execute({action:'validate_fixtures',flow:flow.id,fixture_input:{cases:[quarterlyFixtureCases[4]]}}));
  expect(text).toContain('"passed":true');expect(text).toContain(version.id);expect(JSON.stringify(getFlowVersion(version.id))).toBe(before);expect(getFlow(flow.id)).toMatchObject({status:'DISABLED',published_version_id:null});
  const validation=compileWorkflow(graph as any,{pieces:catalog,phase:'composition'});expect(validation.ready).toBe(true);expect(validation.setupIssues).toHaveLength(4);
});
test('clock substitution, unsupported graph edges and real notification channels are rejected',async()=>{
  const invalid=structuredClone(graph);invalid.nextAction.settings.input.scheduledFor='2026-10-05T07:00:00Z';expect(compileWorkflow(invalid as any,{pieces:catalog,phase:'composition'}).ready).toBe(false);
  await expect(validateQuarterlyFixtures(invalid)).rejects.toThrow('scheduledFor');
  const other=structuredClone(graph);other.nextAction.nextAction.settings.input.channels=['telegram'];await expect(validateQuarterlyFixtures(other)).rejects.toThrow('dashboard');
});
test('a blank deal currency falls back to the portal company currency, and only that',async()=>{
  const base=quarterlyFixtureRequest(setup,at,'missing_currency');
  const withCompany=await collectQuarterlyReport(setup,async(p,path,b)=>{const r=await base(p,path,b);return path.startsWith('/account-info')?{...r,companyCurrency:'eur'}:r;},at);
  expect(withCompany.complete).toBe(true);expect(withCompany.datasets[0]!.totals.EUR).toEqual({count:1,amount:'150'});
  const unknown=await collectQuarterlyReport(setup,base,at);
  expect(unknown.complete).toBe(false);expect(unknown.datasets[0]!.coverage.reason).toContain('company currency is unknown');
});
test('readiness refuses a managed HubSpot connection and a non-Rome schedule',()=>{
  const managed=structuredClone(graph) as any;Object.assign(managed.nextAction.settings.input,{...setup,dealStageIds:'won',hubspotConnection:'jarvis:hubspot'});
  expect(compileWorkflow(managed,{pieces:catalog,phase:'composition'}).issues.map((i:any)=>i.message)).toContain('Select a saved HubSpot account; a Jarvis-managed connection cannot be used by the quarterly report');
  const zone=structuredClone(graph) as any;zone.settings.input.timezone='Asia/Tokyo';zone.settings.chosenTimezone='Asia/Tokyo';
  expect(compileWorkflow(zone,{pieces:catalog,phase:'composition'}).issues).toContainEqual(expect.objectContaining({node:'trigger',path:'settings.input.timezone'}));
  // No chosen zone: the schedule fires in Jarvis's configured zone, so that is what is checked.
  const unchosen=structuredClone(graph) as any;delete unchosen.settings.chosenTimezone;
  setCronTimezone('America/New_York');
  try{expect(compileWorkflow(unchosen,{pieces:catalog,phase:'composition'}).issues.map((i:any)=>i.path)).toContain('settings.input.timezone');}
  finally{setCronTimezone(null);}
  setCronTimezone('Europe/Rome');
  try{expect(compileWorkflow(unchosen,{pieces:catalog,phase:'composition'}).issues.map((i:any)=>i.path)).not.toContain('settings.input.timezone');}
  finally{setCronTimezone(null);}
});
test('the quarterly transport reads only its fixed HubSpot endpoints and retries a short 429 once more',async()=>{
  const seen:string[]=[];let limited=1;
  const request=quarterlyTransport('fixture',()=>{},(async(url:any)=>{seen.push(String(url));if(limited-->0)return new Response('',{status:429,headers:{'retry-after':'0'}});return Response.json({results:[]});}) as typeof fetch,async()=>{});
  expect(await request('hubspot','/crm/v3/pipelines/deals')).toEqual({results:[]});expect(seen).toEqual(['https://api.hubapi.com/crm/v3/pipelines/deals','https://api.hubapi.com/crm/v3/pipelines/deals']);
  for(const path of ['/crm/v3/objects/contacts','/crm/v3/objects/deals','/crm/v3/objects/deals/search','/crm/v3/objects/deals/123'])await expect(request('hubspot',path)).rejects.toThrow('outside the HubSpot read scope');
  expect(seen).toHaveLength(2);
});
