import {beforeEach,afterEach,expect,test} from 'bun:test';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {reportReceipt} from '../db/repos/weekly-report';
import {collectWeeklyReport,saveWeeklyReport,reportSetup,reportWeeks,localMidnight,reportTransport,decimal,comparison,hubspotSearchBody,HUBSPOT_SEARCH_PATH,isReportStep,REPORT_PIECE,REPORT_ACTION,SOURCE_READ_BUDGET_MS,retryAfterMs,HUBSPOT_RETRY_MAX_WAIT_MS,reportRecoveryPath,replacementKey} from './weekly-report';
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
test('HubSpot deals with no amount are excluded and counted per week, never zero and never making the week Unavailable',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({missingAmount:true}),now),current=r.datasets[2]!,prior=r.datasets[5]!;
  expect(current.coverage.status).toBe('Complete');expect(current.totals).toEqual({});expect(current.noAmount).toBe(1);expect(prior.noAmount).toBe(1);expect(r.partial).toBe(false);
  expect(r.content).toContain('hubspot-deals | current | Excluded from totals: 1 deal with no amount not included');
  // Only the amountless deal is excluded: the other deals of the week still count.
  const mixed=await collectWeeklyReport(setup,reportFixtureRequest({deals:[deal(1,'2026-10-22T10:00:00Z',null as any),deal(2,'2026-10-22T11:00:00Z','5'),deal(3,'2026-10-23T11:00:00Z','')]}),now);
  expect(mixed.datasets[2]!.totals).toEqual({EUR:{count:1,amount:'5'}});expect(mixed.datasets[2]!.noAmount).toBe(2);
  expect(mixed.content).toContain('hubspot-deals | current | Excluded from totals: 2 deals with no amount not included');
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
test('wrong readback stays fenced across retries, naming the Doc to review',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({badContent:true,writes}),r=await collectWeeklyReport(setup,req,now);
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),'bad')).rejects.toThrow();const n=writes.length;
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('b'),'bad')).rejects.toThrow('unresolved. Review the recorded attempt (Doc doc1, https://docs.google.com/document/d/doc1/edit)');expect(writes).toHaveLength(n);
});
test('a lost create reply is recovered by the Doc report key: an empty Doc is completed, no second Doc is created',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({unknownCreate:true,writes}),r=await collectWeeklyReport(setup,req,now);
  const calls:string[]=[],second=reportFixtureRequest({writes,calls});
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),'lost')).rejects.toThrow('Lost creation reply');expect(writes).toHaveLength(1);
  // The same fixture Drive: the lost reply did create doc1.
  const recovering=async(p:any,path:string,body?:any)=>{calls.push(`${p} ${path}`);return req(p,path,body);};
  const out=await saveWeeklyReport(setup,r,recovering,reportReceipt('b'),'lost');
  expect(calls).toContain(`google ${reportRecoveryPath('lost')}`);
  expect(out.documentId).toBe('doc1');expect(out.documentVerified).toBe(true);expect(writes).toHaveLength(2);expect(writes.filter(w=>w.path.startsWith('/drive/v3/files'))).toHaveLength(1);
  expect((await saveWeeklyReport(setup,r,second,reportReceipt('c'),'lost')).documentId).toBe('doc1');expect(writes).toHaveLength(2);
});
test('a lost create reply with no Doc found, or a found Doc that already has text, stays fenced and names what it found',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest(),now);
  const transport=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>new Response('{}',{status:503})) as any),fixture=reportFixtureRequest();
  await expect(saveWeeklyReport(setup,r,async(p,path,body)=>body?transport(p,path,body):fixture(p,path,body),reportReceipt('a'),'none')).rejects.toThrow('HTTP 503');
  await expect(saveWeeklyReport(setup,r,fixture,reportReceipt('b'),'none')).rejects.toThrow("Drive shows no document carrying this report's key yet");
  const writes:any[]=[],req=reportFixtureRequest({unknownCreate:true,writes});
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),'written')).rejects.toThrow('Lost creation reply');
  // Something wrote into the Doc after the lost reply: Jarvis does not write into it again.
  const dirty=async(p:any,path:string,body?:any)=>{const out=await req(p,path,body);return path==='/v1/documents/doc1'?{...out,body:{content:[{paragraph:{elements:[{textRun:{content:'earlier text'}}]}}]}}:out;};
  await expect(saveWeeklyReport(setup,r,dirty,reportReceipt('b'),'written')).rejects.toThrow('(Doc doc1, https://docs.google.com/document/d/doc1/edit)');expect(writes).toHaveLength(1);
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('c'),'written')).rejects.toThrow('(Doc doc1,');expect(writes).toHaveLength(1);
});
test('a partial report leaves room for one replacement Doc that names it; a complete replacement closes the week',async()=>{
  const writes:any[]=[],options:any={writes,failStripe:true},req=reportFixtureRequest(options);
  const partial=await saveWeeklyReport(setup,await collectWeeklyReport(setup,req,now),req,reportReceipt('a'),'w');
  expect(partial).toMatchObject({documentVerified:true,partial:true,weekClosed:false,documentId:'doc1'});expect(partial.content).toContain('This report is partial. A later run this week may create one replacement report');
  options.failStripe=false;
  const replacement=await saveWeeklyReport(setup,await collectWeeklyReport(setup,req,now),req,reportReceipt('b'),'w');
  expect(replacement).toMatchObject({documentVerified:true,partial:false,weekClosed:true,documentId:'doc2',replaces:{documentId:'doc1',documentUrl:'https://docs.google.com/document/d/doc1/edit'}});
  expect(replacement.title).toEndWith('(replacement)');expect(replacement.content).toContain('This report replaces the earlier partial report for this week: https://docs.google.com/document/d/doc1/edit (Doc doc1).');
  expect(writes.filter(w=>w.body?.mimeType)).toHaveLength(2);
  options.failStripe=true;const n=writes.length;
  expect((await saveWeeklyReport(setup,await collectWeeklyReport(setup,req,now),req,reportReceipt('c'),'w')).documentId).toBe('doc2');expect(writes).toHaveLength(n);
});
test('a partial replacement also closes the week and says so; no third Doc',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({writes,failHubspot:true}),r=await collectWeeklyReport(setup,req,now);
  expect((await saveWeeklyReport(setup,r,req,reportReceipt('a'),'p')).weekClosed).toBe(false);
  const second=await saveWeeklyReport(setup,r,req,reportReceipt('b'),'p');
  expect(second).toMatchObject({partial:true,weekClosed:true,documentId:'doc2',replaces:{documentId:'doc1'}});
  expect(second.content).toContain('This replacement is also partial. The week is now closed: Jarvis will not create another report for it.');
  const n=writes.length;expect((await saveWeeklyReport(setup,r,req,reportReceipt('c'),'p')).documentId).toBe('doc2');expect(writes).toHaveLength(n);
  expect(reportReceipt('x').peek(replacementKey('p')).state).toBe('complete');
});
test('a complete report closes the week at once: a rerun returns its stored result',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({writes}),r=await collectWeeklyReport(setup,req,now);
  const first=await saveWeeklyReport(setup,r,req,reportReceipt('a'),'c');expect(first).toMatchObject({partial:false,weekClosed:true});expect(first.content).not.toContain('partial report');
  expect(await saveWeeklyReport(setup,r,req,reportReceipt('b'),'c')).toEqual(JSON.parse(JSON.stringify(first)));expect(writes).toHaveLength(2);
  expect(reportReceipt('x').peek(replacementKey('c')).state).toBe('none');
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
test('a deal with no currency uses the portal company currency; with neither the week is Unavailable',async()=>{
 const noCode=(p:string,path:string,r:any)=>p==='hubspot'&&path==='/crm/v3/objects/deals/search'?{...r,results:r.results.map((x:any)=>({...x,properties:{...x.properties,deal_currency_code:x.id==='1'?'':null}}))}:r;
 const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:noCode,companyCurrency:'usd'}),now);
 expect(r.datasets[2]!.coverage.status).toBe('Complete');expect(r.datasets[2]!.totals).toEqual({USD:{count:1,amount:'123.456789'}});expect(r.datasets[5]!.totals).toEqual({USD:{count:1,amount:'0'}});
 // A deal that names its currency keeps it.
 const named=await collectWeeklyReport(setup,reportFixtureRequest({companyCurrency:'usd'}),now);expect(named.datasets[2]!.totals).toEqual({EUR:{count:1,amount:'123.456789'}});
 for(const companyCurrency of [undefined,'dollars']){
  const none=await collectWeeklyReport(setup,reportFixtureRequest({mutate:noCode,companyCurrency}),now);
  expect(none.datasets[2]!.coverage.status).toBe('Unavailable');expect(none.datasets[2]!.coverage.reason).toContain('company currency is unknown');
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
  expect(r.content).toContain('pending, requiring customer action (requires_action), failed and canceled refunds are excluded from totals');
  expect(r.comparisons.find(c=>c.source==='stripe-refunds'&&c.currency==='EUR')).toMatchObject({current:{count:1,amount:'2'}});
  expect(r.comparisons.some(c=>c.source==='stripe-refunds'&&c.currency==='JPY')).toBe(false);
  const all=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>n===3?'canceled':'pending'}),now);
  expect(all.datasets[1]!.totals).toEqual({});
  expect(all.content).toContain('stripe-refunds | current | 0 records; no currency inferred\nstripe-refunds | current | Excluded from totals: 2 pending refunds (EUR 3.00) and 1 canceled refund (JPY 5) not included');
});
test('an unknown refund status makes refunds unavailable instead of dropping the refund',async()=>{
  for(const status of ['refunded','requires_capture','',undefined,null]){
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
test('refunds requiring customer action are excluded from totals and disclosed like pending ones',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>n===2?'requires_action':'succeeded'}),now),refunds=r.datasets[1]!;
  expect(refunds.coverage.status).toBe('Complete');
  expect(refunds.totals).toEqual({EUR:{count:1,amount:'1'},JPY:{count:1,amount:'5'}});
  expect(refunds.excluded).toEqual({requires_action:{EUR:{count:1,amount:'2'}}});
  expect(r.content).toContain('stripe-refunds | current | Excluded from totals: 1 refund requiring customer action (EUR 2.00) not included');
  const mixed=await collectWeeklyReport(setup,reportFixtureRequest({refundStatus:n=>n===3?'pending':'requires_action'}),now);
  expect(mixed.content).toContain('Excluded from totals: 1 pending refund (JPY 5) and 2 refunds requiring customer action (EUR 3.00) not included');
});
test('source reads stop at the time budget; unfinished datasets are Unavailable and the report is still saved',async()=>{
  let t=0,late=0,jumped=false;const calls:string[]=[];
  const fixture=reportFixtureRequest({calls});
  const req:typeof fixture=async(p,path,body)=>{
    if(jumped)late++;
    // The first HubSpot search of the current week takes the clock past the budget.
    if(p==='hubspot'&&path===HUBSPOT_SEARCH_PATH&&!jumped){jumped=true;t+=SOURCE_READ_BUDGET_MS;}
    return fixture(p,path,body);
  };
  const r=await collectWeeklyReport(setup,req,now,()=>{},()=>t);
  expect(late).toBe(0);
  const status=r.datasets.map(d=>`${d.coverage.source}/${d.coverage.period}/${d.coverage.status}`);
  expect(status).toEqual(['stripe-payments/current/Complete','stripe-refunds/current/Complete','hubspot-deals/current/Unavailable','stripe-payments/prior/Unavailable','stripe-refunds/prior/Unavailable','hubspot-deals/prior/Unavailable']);
  for(const d of r.datasets.slice(2)){expect(d.coverage.reason).toContain('5-minute source read time budget ran out');expect(d.totals).toEqual({});}
  expect(r.partial).toBe(true);expect(r.content).toContain('stop at a 5-minute source read time budget');
  expect(await saveWeeklyReport(setup,r,fixture,reportReceipt('budget'),'budget')).toMatchObject({documentVerified:true,partial:true,weekClosed:false});
  // Within the budget nothing is affected.
  t=0;expect((await collectWeeklyReport(setup,reportFixtureRequest(),now,()=>{},()=>t+=1000)).partial).toBe(false);
});
test('HubSpot 429 is retried a bounded number of times honouring Retry-After',async()=>{
  const run=async(responses:Array<()=>Response>,provider:'hubspot'|'stripe'='hubspot')=>{
    const waits:number[]=[];let n=0;
    const req=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>responses[Math.min(n++,responses.length-1)]!()) as any,0,async ms=>{waits.push(ms);});
    const path=provider==='hubspot'?HUBSPOT_SEARCH_PATH:'/v1/account',body=provider==='hubspot'?hubspotSearchBody(setup,1000,2000):undefined;
    const out=await req(provider,path,body).then(v=>v,e=>e as Error);return {out,waits,fetches:n};
  };
  const limited=(after?:string)=>()=>new Response('{}',{status:429,headers:after===undefined?{}:{'Retry-After':after}}),ok=()=>Response.json({total:0,results:[]});
  expect(await run([limited('2'),ok])).toEqual({out:{total:0,results:[]},waits:[2000],fetches:2});
  expect(await run([limited(),limited('0'),ok])).toEqual({out:{total:0,results:[]},waits:[1000,0],fetches:3});
  const exhausted=await run([limited('1')]);expect(exhausted.fetches).toBe(3);expect(exhausted.waits).toEqual([1000,1000]);expect((exhausted.out as Error).message).toContain('HTTP 429');
  const tooLong=await run([limited('60'),ok]);expect(tooLong.fetches).toBe(1);expect(tooLong.waits).toEqual([]);expect((tooLong.out as Error).message).toContain('HTTP 429');
  const stripe=await run([limited('1'),()=>Response.json({id:'acct'})],'stripe');expect(stripe.fetches).toBe(1);
  expect(retryAfterMs(new Date(10_000).toUTCString(),7_000)).toBe(3000);expect(retryAfterMs('soon')).toBeNull();expect(retryAfterMs(String(HUBSPOT_RETRY_MAX_WAIT_MS/1000+1))).toBeNull();
  // Cancellation during the wait stops the retry and is known not to have been re-sent.
  let checks=0;const cancelled=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{if(++checks>1)throw Error('Cancelled');},(async()=>limited('1')()) as any,0,async()=>{});
  await expect(cancelled('hubspot',HUBSPOT_SEARCH_PATH,hubspotSearchBody(setup,1000,2000))).rejects.toThrow('Cancelled');
});

// Surviving guards, each pinned against its mutant.
const stripeRows=(f:(rows:any[],path:string)=>any[])=>(p:string,path:string,r:any)=>p==='stripe'&&path.startsWith('/v1/balance_transactions')&&Array.isArray(r.data)?{...r,data:f(r.data,path)}:r;
test('a payment that is not paid or not captured makes payments Unavailable',async()=>{
  for(const field of ['paid','captured']){
    const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:stripeRows(rows=>rows.map(x=>x.type==='charge'?{...x,source:{...x.source,[field]:false}}:x))}),now);
    expect(r.datasets[0]!.coverage.status).toBe('Unavailable');expect(r.datasets[0]!.coverage.reason).toContain('Successful captured payment cannot be confirmed');expect(r.datasets[1]!.coverage.status).toBe('Complete');
  }
});
test('a three-decimal currency keeps its minor unit: BHD 1234 is 1.234',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:stripeRows(rows=>rows.map(x=>x.currency==='jpy'?{...x,currency:'bhd',amount:Math.sign(x.amount)*1234}:x)),refundStatus:n=>n===3?'pending':'succeeded'}),now);
  expect(r.datasets[0]!.totals.BHD).toEqual({count:1,amount:'1.234'});expect(r.datasets[1]!.excluded).toEqual({pending:{BHD:{count:1,amount:'1.234'}}});
  expect(r.content).toContain('1 pending refund (BHD 1.234) not included');
});
test('a HubSpot search whose deals do not add up to its total is Unavailable',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:(p,path,x)=>p==='hubspot'&&path===HUBSPOT_SEARCH_PATH?{...x,total:x.total+1}:x}),now);
  expect(r.datasets[2]!.coverage.status).toBe('Unavailable');expect(r.datasets[2]!.coverage.reason).toContain('different number of deals than its total');
});
test('a Stripe continuation page with no rows is Unavailable, not the end',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:(p,path,x)=>p==='stripe'&&path.startsWith('/v1/balance_transactions')&&path.includes('type=charge')&&!path.includes('starting_after')?{data:[],has_more:true}:x}),now);
  expect(r.datasets[0]!.coverage.status).toBe('Unavailable');expect(r.datasets[0]!.coverage.reason).toContain('Empty continuation page');
});
test('a Stripe record that changes between pages is Unavailable',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({overlap:true,mutate:stripeRows((rows,path)=>path.includes('starting_after')?rows.map(x=>x.id.endsWith('_1')?{...x,amount:x.amount*2}:x):rows)}),now);
  expect(r.datasets[0]!.coverage.status).toBe('Unavailable');expect(r.datasets[0]!.coverage.reason).toContain('Record changed during pagination');
});
test('a different Stripe account than the one selected makes Stripe Unavailable',async()=>{
  const r=await collectWeeklyReport(setup,reportFixtureRequest({mutate:(p,path,x)=>path==='/v1/account'?{id:'acct_other'}:x}),now);
  for(const i of [0,1,3,4]){expect(r.datasets[i]!.coverage.status).toBe('Unavailable');expect(r.datasets[i]!.coverage.reason).toContain('Stripe account or live/test mode mismatch');}
  expect(r.datasets[2]!.coverage.status).toBe('Complete');
});
test('a saved Doc outside the selected folder fails verification',async()=>{
  const writes:any[]=[],req=reportFixtureRequest({writes,mutate:(p,path,x)=>/^\/drive\/v3\/files\/doc\d+\?/.test(path)?{...x,parents:['elsewhere']}:x}),r=await collectWeeklyReport(setup,req,now);
  await expect(saveWeeklyReport(setup,r,req,reportReceipt('a'),'folder')).rejects.toThrow('could not be verified');
});
test('the transport refuses redirects and responses over 4 MB',async()=>{
  const inits:any[]=[];
  const ok=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async(_u:any,init:any)=>{inits.push(init);return Response.json({id:'acct_x'});}) as any);
  await ok('stripe','/v1/account');expect(inits[0].redirect).toBe('error');
  const big=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>new Response('{"a":"'+'x'.repeat(4_000_000)+'"}')) as any);
  await expect(big('stripe','/v1/account')).rejects.toThrow('Source response exceeds completeness limit');
  const small=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async()=>new Response('{"a":"'+'x'.repeat(3_999_000)+'"}')) as any);
  expect((await small('stripe','/v1/account')).a).toHaveLength(3_999_000);
});
test('the transport allows exactly the recovery search, and one insert into a Doc it found',async()=>{
  const seen:string[]=[];
  const req=reportTransport({stripe:'x',hubspot:'x',google:'x'},()=>{},(async(u:any)=>{seen.push(String(u));return Response.json(String(u).includes('/drive/v3/files?')?{files:[{id:'lost',mimeType:'application/vnd.google-apps.document',appProperties:{jarvisReport:'key'}},{id:'other',mimeType:'application/vnd.google-apps.document',appProperties:{jarvisReport:'not-key'}}]}:{documentId:'lost'});}) as any);
  const body={requests:[{insertText:{location:{index:1},text:'report'}}]};
  await expect(req('google','/v1/documents/lost:batchUpdate',body)).rejects.toThrow('scope');
  for(const path of [reportRecoveryPath('key')+'&orderBy=name','/drive/v3/files?q=trashed%3Dfalse',reportRecoveryPath('key').replace('trashed%3Dfalse','trashed%3Dtrue')])await expect(req('google',path)).rejects.toThrow('scope');
  expect(seen).toHaveLength(0);
  await req('google',reportRecoveryPath('key'));
  await expect(req('google','/v1/documents/other:batchUpdate',body)).rejects.toThrow('scope');
  await req('google','/v1/documents/lost:batchUpdate',body);
  await expect(req('google','/v1/documents/lost:batchUpdate',body)).rejects.toThrow('scope');
  expect(()=>reportRecoveryPath("x' or name contains 'y")).toThrow('Invalid report key');
});
