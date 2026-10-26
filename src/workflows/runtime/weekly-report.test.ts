import {beforeEach,afterEach,expect,test} from 'bun:test';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {reportReceipt} from '../db/repos/weekly-report';
import {collectWeeklyReport,saveWeeklyReport,reportSetup,reportWeeks,localMidnight,reportTransport,decimal,comparison,hubspotSearchBody,HUBSPOT_SEARCH_PATH,isReportStep,REPORT_PIECE,REPORT_ACTION} from './weekly-report';
import {nodeConnectionReferences} from '../db/repos/binding-pins';
import {workflowSafeguards} from './workflow-safeguards';
import {compileWorkflow} from './workflow-readiness';
import {getCronTimezone,setCronTimezone} from '../../lib/cron-scheduler';
import {reportFixtureSetup as setup,reportFixtureNow as now,reportFixtureRequest} from './report-fixtures';
beforeEach(()=>initWorkflowDb(':memory:'));afterEach(()=>closeWorkflowDb());
test('Rome complete calendar weeks resolve spring and autumn DST independently',()=>{
  for(const [date,hours]of [['2026-03-30T09:00:00Z',167],['2026-10-26T09:00:00Z',169]] as const){const w=reportWeeks(Date.parse(date),'Europe/Rome')[0]!;expect((w.end-w.start)/3600000).toBe(hours);expect(w.localStart).toBe(date.startsWith('2026-03')?'2026-03-23':'2026-10-19');}
  expect(reportWeeks(Date.parse('2026-10-25T10:00:00Z'),'Europe/Rome')[0]!.localEnd).toBe('2026-10-19');
});
test('full multipage report deduplicates overlaps, separates currencies and uses exact amounts',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({overlap:true}),now);
  expect(r.partial).toBe(false);expect(r.datasets[0]!.totals).toEqual({EUR:{count:2,amount:'3'},JPY:{count:1,amount:'5'}});
  expect(r.datasets[0]!.coverage).toMatchObject({pages:3,unique:3,terminal:true});
  expect(r.comparisons.find(c=>c.source==='hubspot-deals')).toMatchObject({current:{amount:'123.456789'},prior:{amount:'0'},amountChange:{percentage:null,label:'New activity; percentage not defined'}});
  expect(r.content).toContain('BALANCE currency');expect(r.content).toContain('not a historical pipeline snapshot');
});
test('zero and negative baselines never divide by zero or imply growth',()=>{
  expect(comparison(0n,0n).label).toBe('No change; both zero');expect(comparison(decimal('5'),0n).percentage).toBeNull();expect(comparison(0n,-1n).percentage).toBeNull();expect(comparison(decimal('150'),decimal('100')).percentage).toBe('50');
  expect(comparison(decimal('999999999999999999'),decimal('0.000001')).percentage).toBe('99999999999999999899999900');
  expect(()=>decimal('1e5')).toThrow();expect(()=>decimal('1.0000001')).toThrow();
});
test('source failure or cursor loops discard all partial totals but retain other source',async()=>{
  for(const option of [{failStripe:true},{cycle:true},{modeMismatch:true}]){
    const r=await collectWeeklyReport(setup,reportFixtureRequest(option),now);expect(r.partial).toBe(true);expect(r.datasets[0]!.coverage.status).toBe('Unavailable');expect(r.datasets[0]!.totals).toEqual({});expect(r.datasets[2]!.coverage.status).toBe('Complete');
  }
});
test('incomplete monetary fields make affected dataset unavailable, not zero',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({missingAmount:true}),now);expect(r.datasets[2]!.coverage.status).toBe('Unavailable');expect(r.datasets[2]!.totals).toEqual({});
});
test('both unavailable sources still produce an explicit honest report; complete empty differs',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({failStripe:true,failHubspot:true}),now);expect(r.datasets.every(d=>d.coverage.status==='Unavailable')).toBe(true);expect(r.comparisons.every(c=>c.status==='Unavailable')).toBe(true);
  const empty=await collectWeeklyReport(setup,reportFixtureRequest({empty:true}),now);expect(empty.partial).toBe(false);expect(empty.comparisons.every(c=>c.countCurrent===0&&c.countPrior===0)).toBe(true);
});
test('invalid source evidence and changed overlapping records cannot become complete',async()=>{
  for(const mutate of [(p:string,path:string,r:any)=>p==='stripe'&&r.data?.length?{...r,data:r.data.map((x:any)=>({...x,source:null}))}:r,
    (p:string,path:string,r:any)=>p==='stripe'&&r.data?.length?{...r,has_more:undefined}:r]){
    expect((await collectWeeklyReport(setup,reportFixtureRequest({mutate}),now)).datasets[0]!.coverage.status).toBe('Unavailable');
  }
});
test('new Doc content and destination verified, successful weekly replay does not write',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({writes}),r=await collectWeeklyReport(setup,req,now),ledger=reportReceipt('a');
  const out=await saveWeeklyReport(setup,r,req,ledger,'week');expect(out.documentId).toBe('doc1');expect(writes).toHaveLength(2);
  expect((await saveWeeklyReport(setup,r,req,reportReceipt('b'),'week')).documentId).toBe('doc1');expect(writes).toHaveLength(2);
});
test('uncertain document creation and wrong readback remain fenced across retries',async()=>{
  for(const [key,options]of [['unknown',{unknownCreate:true}],['bad',{badContent:true}]] as const){
    const writes:any[]=[],req=reportFixtureRequest({...options,writes}),r=await collectWeeklyReport(setup,req,now);
    await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),key)).rejects.toThrow();const n=writes.length;
    await expect(saveWeeklyReport(setup,r,req,reportReceipt('b'),key)).rejects.toThrow('unresolved');expect(writes).toHaveLength(n);
  }
});
test('concurrent weekly claims admit exactly one document',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({writes}),r=await collectWeeklyReport(setup,req,now);
  const out=await Promise.allSettled(['a','b'].map(owner=>saveWeeklyReport(setup,r,req,reportReceipt(owner),'same')));expect(out.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(writes).toHaveLength(2);
});
test('setup rejects unknown accounts and semantics; provider transport forbids other writes',async()=>{
  expect(()=>reportSetup({...setup,stripeDateBasis:''})).toThrow();expect(()=>reportSetup({...setup,googleConnection:'{{connections.fake}}'})).toThrow();
  const req=reportTransport({stripe:'fake',hubspot:'fake',google:'fake'},()=>{},(async()=>{throw Error('No network should run');}) as any);
  for(const [p,path,body]of [['stripe','/v1/refunds',{}],['hubspot','/crm/v3/objects/deals',{}],['google','/drive/v3/files/other/permissions',{}],['google','/v1/documents/existing:batchUpdate',{requests:[]}],['google','//evil.test',undefined]] as any[])await expect(req(p,path,body)).rejects.toThrow();
});
test('cancellation or account checkpoint failure cannot be disguised as unavailable source',async()=>{
  await expect(collectWeeklyReport(setup,reportFixtureRequest({failStripe:true}),now,()=>{throw Error('Cancelled');})).rejects.toThrow('Cancelled');
});

test('incomplete HubSpot date or currency invalidates the dataset and never assumes EUR',async()=>{
 for(const field of ['closedate','deal_currency_code']){
  const req=reportFixtureRequest({mutate:(p,path,r)=>p==='hubspot'&&path==='/crm/v3/objects/deals/search'?{...r,results:r.results.map((x:any)=>({...x,properties:{...x.properties,[field]:null}}))}:r});
  expect((await collectWeeklyReport(setup,req,now)).datasets[2]!.coverage.status).toBe('Unavailable');
 }
});
test('wrong Google identity, folder or permission prevents document creation',async()=>{
 for(const mutate of [(p:string,path:string,r:any)=>path.startsWith('/drive/v3/about')?{user:{emailAddress:'wrong@example.com'}}:r,
  (p:string,path:string,r:any)=>path.startsWith('/drive/v3/files/folder')?{...r,capabilities:{canAddChildren:false}}:r]){
  const writes:any[]=[],req=reportFixtureRequest({mutate,writes}),r=await collectWeeklyReport(setup,req,now);
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),'bad-destination')).rejects.toThrow();expect(writes).toHaveLength(0);
 }
});
test('transport will insert only once into its newly created Doc, never an existing document',async()=>{
 const req=reportTransport({stripe:'fake',hubspot:'fake',google:'fake'},()=>{},(async()=>Response.json({id:'newdoc'})) as any);
 const body={requests:[{insertText:{location:{index:1},text:'report'}}]};
 await expect(req('google','/v1/documents/newdoc:batchUpdate',body)).rejects.toThrow('scope');
 await req('google','/drive/v3/files',{name:'Report',mimeType:'application/vnd.google-apps.document',parents:['folder'],appProperties:{jarvisReport:'key'}});
 await req('google','/v1/documents/newdoc:batchUpdate',body);
 await expect(req('google','/v1/documents/newdoc:batchUpdate',body)).rejects.toThrow('scope');
});
test('empty timezone uses the timezone configured for Jarvis, explicit zones stay and define the weeks',async()=>{
  const previous=getCronTimezone();
  try {
    setCronTimezone('America/New_York');
    for(const timezone of [undefined,null,'',' '])expect(reportSetup({...setup,timezone}).timezone).toBe('America/New_York');
    expect(reportSetup({...setup,timezone:'Asia/Tokyo'}).timezone).toBe('Asia/Tokyo');
    expect(()=>reportSetup({...setup,timezone:'Not/AZone'})).toThrow();
    setCronTimezone(null);
    expect(reportSetup({...setup,timezone:''}).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally { setCronTimezone(previous); }
  const ny=reportWeeks(Date.parse('2026-11-02T12:00:00Z'),'America/New_York')[0]!;
  expect([ny.localStart,new Date(ny.start).toISOString(),new Date(ny.end).toISOString(),(ny.end-ny.start)/3600000]).toEqual(['2026-10-26','2026-10-26T04:00:00.000Z','2026-11-02T05:00:00.000Z',169]);
  // 02:00Z on 2026-10-26 is Monday in Rome but still Sunday in New York, so the last complete week differs.
  const at=Date.parse('2026-10-26T02:00:00Z');expect(reportWeeks(at,'Europe/Rome')[0]!.localStart).toBe('2026-10-19');
  const r=await collectWeeklyReport({...setup,timezone:'America/New_York'},reportFixtureRequest(),at);
  expect(r.content).toContain('Reporting timezone: America/New_York.');expect(r.weeks[0]!.localStart).toBe('2026-10-12');
});
test('a local midnight skipped by DST starts at the transition; a repeated one uses the first occurrence',()=>{
  expect(new Date(localMidnight(Date.UTC(2026,8,6),'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z');
  expect(new Date(localMidnight(Date.UTC(2026,2,29),'Asia/Beirut')).toISOString()).toBe('2026-03-28T22:00:00.000Z');
  expect(new Date(localMidnight(Date.UTC(2026,10,1),'America/Havana')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  expect(new Date(localMidnight(Date.UTC(2026,9,26),'Europe/Rome')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
});
test('a create that was refused or never dispatched releases the weekly claim; a later run creates the report',async()=>{
  for(const [key,refuse] of [['rejected',(async()=>new Response('{}',{status:403})) as any],['cancelled','checkpoint']] as const){
    const writes:any[]=[],fixture=reportFixtureRequest({writes}),r=await collectWeeklyReport(setup,fixture,now);
    const transport=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{if(refuse==='checkpoint')throw Error('Cancelled');},refuse==='checkpoint'?(async()=>{throw Error('No network should run');}) as any:refuse);
    const failing=async(p:any,path:string,body?:any)=>body?transport(p,path,body):fixture(p,path,body);
    await expect(saveWeeklyReport(setup,r,failing,reportReceipt('a'),key)).rejects.toThrow(refuse==='checkpoint'?'Cancelled':'HTTP 403');expect(writes).toHaveLength(0);
    expect((await saveWeeklyReport(setup,r,fixture,reportReceipt('b'),key)).documentId).toBe('doc1');expect(writes).toHaveLength(2);
  }
  const transport=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>new Response('{}',{status:503})) as any),fixture=reportFixtureRequest(),r=await collectWeeklyReport(setup,fixture,now);
  await expect(saveWeeklyReport(setup,r,async(p,path,body)=>body?transport(p,path,body):fixture(p,path,body),reportReceipt('a'),'uncertain')).rejects.toThrow('HTTP 503');
  await expect(saveWeeklyReport(setup,r,fixture,reportReceipt('b'),'uncertain')).rejects.toThrow('unresolved');
});

const deal=(id:number,date:string|number,amount='1',dealstage='won',deal_currency_code='EUR')=>({id:String(id),properties:{dealstage,closedate:typeof date==='number'?new Date(date).toISOString():date,amount,deal_currency_code}});
test('pending, failed and canceled refunds stay out of exact totals and are disclosed per currency',async()=>{
  const statuses:Record<number,string>={1:'pending',2:'succeeded',3:'failed'};
  const r=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>statuses[n]!}),now),refunds=r.datasets[1]!;
  expect(refunds.coverage).toMatchObject({source:'stripe-refunds',status:'Complete',unique:3});
  expect(refunds.totals).toEqual({EUR:{count:1,amount:'2'}});
  expect(refunds.excluded).toEqual({pending:{EUR:{count:1,amount:'1'}},failed:{JPY:{count:1,amount:'5'}}});
  expect(r.content).toContain('stripe-refunds | current | Excluded from totals: 1 pending refund (EUR 1.00) and 1 failed refund (JPY 5) not included');
  expect(r.content).toContain('pending, failed and canceled refunds are excluded from totals');
  expect(r.comparisons.find(c=>c.source==='stripe-refunds'&&c.currency==='EUR')).toMatchObject({current:{count:1,amount:'2'}});
  expect(r.comparisons.some(c=>c.source==='stripe-refunds'&&c.currency==='JPY')).toBe(false);
  const all=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>n===3?'canceled':'pending'}),now);
  expect(all.datasets[1]!.totals).toEqual({});
  expect(all.content).toContain('stripe-refunds | current | 0 records; no currency inferred\nstripe-refunds | current | Excluded from totals: 2 pending refunds (EUR 3.00) and 1 canceled refund (JPY 5) not included');
});
test('an unknown refund status makes refunds unavailable instead of dropping the refund',async()=>{
  for(const status of ['requires_action','refunded',undefined,null]){
    const r=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>n===2?status as any:'succeeded'}),now);
    expect(r.datasets[1]!.coverage).toMatchObject({status:'Unavailable',reason:'Refund status cannot be confirmed'});expect(r.datasets[1]!.totals).toEqual({});expect(r.datasets[1]!.excluded).toBeUndefined();
    expect(r.datasets[0]!.coverage.status).toBe('Complete');expect(r.partial).toBe(true);
  }
});
test('HubSpot search is filtered to each week in the timezone configured for Jarvis and read twice',async()=>{
  const previous=getCronTimezone();let s;
  try{setCronTimezone('America/New_York');s=reportSetup({...setup,timezone:''});}finally{setCronTimezone(previous);}
  const searches:any[]=[],r=await collectWeeklyReport(s,reportFixtureRequest({searches}),Date.parse('2026-11-02T12:00:00Z'));
  const windows=searches.map(b=>{const [stage,from,to]=b.filterGroups[0].filters;expect(stage).toEqual({propertyName:'dealstage',operator:'IN',values:['won']});expect([from.propertyName,from.operator,to.propertyName,to.operator]).toEqual(['closedate','GTE','closedate','LT']);return [new Date(Number(from.value)).toISOString(),new Date(Number(to.value)).toISOString()];});
  const current=['2026-10-26T04:00:00.000Z','2026-11-02T05:00:00.000Z'],prior=['2026-10-19T04:00:00.000Z','2026-10-26T04:00:00.000Z'];
  expect(windows).toEqual([current,current,prior,prior]);
  expect(r.datasets.filter(d=>d.coverage.source==='hubspot-deals').map(d=>d.coverage.status)).toEqual(['Complete','Complete']);
  // Deal 4 (2026-10-26T10:00Z) is in the New York current week and deal 2 is outside both; the lost-stage deal never counts.
  expect(r.datasets[2]!.totals).toEqual({EUR:{count:1,amount:'999'}});expect(r.datasets[5]!.totals).toEqual({EUR:{count:1,amount:'123.456789'}});
});
test('HubSpot search pagination reads every page with exact totals',async()=>{
  const week=reportWeeks(now,'Europe/Rome')[0]!,deals=Array.from({length:900},(_,i)=>deal(i+1,week.start+i*1000,'0.000001',i%2?'won':'lost',i%3?'EUR':'usd'));
  const searches:any[]=[],r=await collectWeeklyReport(setup,reportFixtureRequest({deals,searches}),now),d=r.datasets[2]!;
  expect(d.coverage).toMatchObject({status:'Complete',pages:6,unique:450,terminal:true});
  expect(searches.slice(0,3).map(b=>b.after)).toEqual([undefined,'200','400']);
  expect(d.totals).toEqual({EUR:{count:300,amount:'0.0003'},USD:{count:150,amount:'0.00015'}});
});
test('a week over the HubSpot search cap is split into smaller windows, never truncated',async()=>{
  const week=reportWeeks(now,'Europe/Rome')[0]!,span=week.end-week.start,deals=Array.from({length:10050},(_,i)=>deal(i+1,week.start+Math.floor(i*span/10050)));
  const searches:any[]=[],r=await collectWeeklyReport(setup,reportFixtureRequest({deals,searches}),now),d=r.datasets[2]!;
  expect(d.coverage).toMatchObject({status:'Complete',unique:10050});expect(d.totals).toEqual({EUR:{count:10050,amount:'10050'}});
  const firstPages=searches.filter(b=>b.after===undefined).map(b=>[Number(b.filterGroups[0].filters[1].value),Number(b.filterGroups[0].filters[2].value)]);
  expect(firstPages.slice(0,3)).toEqual([[week.start,week.end],[week.start,week.start+Math.floor(span/2)],[week.start+Math.floor(span/2),week.end]]);
  expect(r.content).toContain('a window that could reach the 10000-result search cap is split');
});
test('a window over the search cap that cannot be split is unavailable',async()=>{
  const week=reportWeeks(now,'Europe/Rome')[0]!,deals=Array.from({length:10000},(_,i)=>deal(i+1,week.start+5000));
  const r=await collectWeeklyReport(setup,reportFixtureRequest({deals}),now),d=r.datasets[2]!;
  expect(d.coverage.status).toBe('Unavailable');expect(d.coverage.reason).toContain('More than 10000 matching HubSpot deals share one closedate millisecond');expect(d.totals).toEqual({});
  expect(r.datasets[5]!.coverage.status).toBe('Complete');
});
test('deals that change or shift during or between HubSpot search reads make the week unavailable',async()=>{
  const week=reportWeeks(now,'Europe/Rome')[0]!,deals=Array.from({length:300},(_,i)=>deal(i+1,week.start+i*1000));
  let n=0;const changed=reportFixtureRequest({deals,mutate:(p,path,r)=>{if(path!==HUBSPOT_SEARCH_PATH)return r;n++;return n===3?{...r,results:r.results.map((x:any)=>({...x,properties:{...x.properties,amount:'2'}}))}:r;}});
  expect((await collectWeeklyReport(setup,changed,now)).datasets[2]!.coverage.reason).toContain('changed between the two complete reads');
  let m=0;const shifted=reportFixtureRequest({deals,mutate:(p,path,r)=>{if(path!==HUBSPOT_SEARCH_PATH)return r;m++;return m===2?{...r,total:r.total+1}:r;}});
  expect((await collectWeeklyReport(setup,shifted,now)).datasets[2]!.coverage.reason).toContain('total changed during pagination');
  let k=0;const repeated=reportFixtureRequest({deals,mutate:(p,path,r)=>{if(path!==HUBSPOT_SEARCH_PATH)return r;k++;return k===2?{...r,results:[deals[199],...r.results.slice(1)]}:r;}});
  expect((await collectWeeklyReport(setup,repeated,now)).datasets[2]!.coverage.reason).toContain('results shifted');
  const outside=reportFixtureRequest({deals,mutate:(p,path,r)=>path===HUBSPOT_SEARCH_PATH&&r.results.length?{...r,results:[{...r.results[0],properties:{...r.results[0].properties,dealstage:'lost'}},...r.results.slice(1)]}:r});
  expect((await collectWeeklyReport(setup,outside,now)).datasets[2]!.coverage.reason).toContain('outside the selected stages');
});
test('transport allows exactly the deal search POST and refuses every other HubSpot write',async()=>{
  const sent:any[]=[],req=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async(url:any,init:any)=>{sent.push([String(url),init.method,init.body]);return Response.json({total:0,results:[]});}) as any,0);
  const body=hubspotSearchBody(setup,1000,2000),page=hubspotSearchBody(setup,1000,2000,'200');
  await req('hubspot',HUBSPOT_SEARCH_PATH,body);await req('hubspot',HUBSPOT_SEARCH_PATH,page);
  expect(sent).toEqual([['https://api.hubapi.com/crm/v3/objects/deals/search','POST',JSON.stringify(body)],['https://api.hubapi.com/crm/v3/objects/deals/search','POST',JSON.stringify(page)]]);
  const f=(i:number,patch:any)=>({...body,filterGroups:[{filters:body.filterGroups[0].filters.map((x:any,j:number)=>j===i?{...x,...patch}:x)}]});
  for(const [path,b] of [
    ['/crm/v3/objects/deals',{properties:{amount:'1'}}],['/crm/v3/objects/deals/1',{properties:{amount:'1'}}],['/crm/v3/objects/deals/batch/update',{inputs:[]}],['/crm/v3/objects/deals/batch/archive',{inputs:[]}],
    ['/crm/v3/objects/contacts/search',body],[HUBSPOT_SEARCH_PATH+'?archived=true',body],['/crm/v3/objects/deals?limit=100',undefined],[HUBSPOT_SEARCH_PATH,undefined],
    [HUBSPOT_SEARCH_PATH,{...body,extra:1}],[HUBSPOT_SEARCH_PATH,{...body,limit:201}],[HUBSPOT_SEARCH_PATH,hubspotSearchBody(setup,1000,2000,'9900')],[HUBSPOT_SEARCH_PATH,{...body,sorts:[{propertyName:'amount',direction:'DESCENDING'}]}],
    [HUBSPOT_SEARCH_PATH,{...body,filterGroups:[...body.filterGroups,...body.filterGroups]}],[HUBSPOT_SEARCH_PATH,f(0,{operator:'NOT_IN'})],[HUBSPOT_SEARCH_PATH,f(1,{operator:'GT'})],[HUBSPOT_SEARCH_PATH,f(2,{value:'500'})],[HUBSPOT_SEARCH_PATH,f(2,{propertyName:'createdate'})],
  ] as any[])await expect(req('hubspot',path,b)).rejects.toThrow('outside the read/create-new-document scope');
  expect(sent).toHaveLength(2);
});
test('transport paces HubSpot searches',async()=>{
  const at:number[]=[],req=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>{at.push(Date.now());return Response.json({total:0,results:[]});}) as any,80);
  for(let i=0;i<3;i++)await req('hubspot',HUBSPOT_SEARCH_PATH,hubspotSearchBody(setup,1000,2000));
  expect(at[1]!-at[0]!).toBeGreaterThanOrEqual(75);expect(at[2]!-at[1]!).toBeGreaterThanOrEqual(75);
});
test('every check treats a short report piece name as the report step; readiness refuses it',()=>{
  const graph=(pieceName:string)=>({name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'schedule',input:{cron_expression:'0 9 * * 1'}},
    nextAction:{name:'report',type:'PIECE',settings:{pieceName,actionName:REPORT_ACTION,input:{...setup}}}});
  for(const name of [REPORT_PIECE,'jarvis-report']) {
    const g=graph(name),node=g.nextAction as any;
    expect(isReportStep(node.settings)).toBe(true);
    expect(nodeConnectionReferences(node).map(([id])=>id)).toEqual(['fixture-stripe','fixture-hubspot','fixture-google']);
    expect(workflowSafeguards(g).safeguards.map(x=>x.kind)).toContain('weekly-source-scope');
    const refused=compileWorkflow(g,{connection:()=>null}).issues.filter(i=>i.code==='PIECE'&&i.message.includes('full piece name'));
    expect(refused).toHaveLength(name===REPORT_PIECE?0:1);
  }
  const evil=graph('@evil/piece-jarvis-report');
  expect(isReportStep(evil.nextAction.settings)).toBe(false);
  expect(workflowSafeguards(evil).safeguards.map(x=>x.kind)).not.toContain('weekly-source-scope');
});
