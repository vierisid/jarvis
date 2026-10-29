import {afterEach,expect,test} from 'bun:test';
import {CronScheduler} from '../../lib/cron-scheduler';
import {collectQuarterlyReport,quarterlySetup,quarterlyTransport,reportQuarters} from './quarterly-report';
import {quarterlyFixtureSetup as setup,quarterlyFixtureRequest,validateQuarterlyFixtures,quarterlyFixtureCases} from './quarterly-report-fixtures';
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
  for(const scenario of ['missing_amount','missing_currency','missing_date','cursor_cycle','page_limit','page_failure'] as const){
    const report=await collectQuarterlyReport(setup,quarterlyFixtureRequest(setup,at,scenario),at);
    expect(report.complete).toBe(false);expect(report.datasets[0]!.totals).toEqual({});expect(report.summary).toContain('Unavailable');
    if(['missing_amount','missing_currency'].includes(scenario))expect(report.datasets[1]!.totals.EUR?.amount).toBe('150');
  }
});
test('unknown dates invalidate both periods; selected stages and date property remain strict',async()=>{
  expect(()=>quarterlySetup({...setup,dealStageIds:[]})).toThrow();expect(()=>quarterlySetup({...setup,dealDateProperty:''})).toThrow();
  const base=quarterlyFixtureRequest(setup,at,'complete');
  for(const mutation of ['changed_duplicate','malformed_page','missing_cursor','date_property']){
    const report=await collectQuarterlyReport(setup,async(p,path,b)=>{const r=structuredClone(await base(p,path,b));if(path.includes('/objects/deals')&&path.includes('after')){
      if(mutation==='changed_duplicate')r.results[0].properties.amount='2';
      if(mutation==='malformed_page')r.results=null;
      if(mutation==='missing_cursor')r.paging={next:{}};
    }if(mutation==='date_property'&&path.includes('/properties/'))r.type='string';return r;},at);
    expect(report.complete).toBe(false);expect(report.datasets.every(d=>Object.keys(d.totals).length===0)).toBe(true);
  }
});
test('negative prior amount is labelled N/A and exact decimal arithmetic is retained',async()=>{
  const request=quarterlyFixtureRequest(setup,at,'complete');const report=await collectQuarterlyReport(setup,async(p,path)=>{
    const data=await request(p,path);for(const r of data.results??[])if(r.id==='prior-eur')r.properties.amount='-100.000001';return data;
  },at);expect(report.comparisons.find(c=>c.currency==='EUR')!.amountChange).toMatchObject({delta:'200.000001',percentage:null,label:'Percentage N/A: negative prior baseline'});
});
test('read-only transport rejects provider writes, redirects and all unrelated providers',async()=>{
  let calls=0;const request=quarterlyTransport('fixture',()=>{},(async(url:any,init:any)=>{calls++;expect(init.method).toBe('GET');expect(init.redirect).toBe('error');return Response.json({results:[]});}) as typeof fetch);
  await request('hubspot','/crm/v3/objects/deals');expect(calls).toBe(1);
  for(const [provider,path,body] of [['hubspot','/crm/v3/objects/deals',{}],['google','/drive/v3/files',undefined],['hubspot','//evil.invalid',undefined]] as const){
    await expect(Promise.resolve().then(()=>request(provider,path,body))).rejects.toThrow();
  }expect(calls).toBe(1);
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
