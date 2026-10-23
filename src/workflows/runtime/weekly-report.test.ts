import {beforeEach,afterEach,expect,test} from 'bun:test';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {reportReceipt} from '../db/repos/weekly-report';
import {collectWeeklyReport,saveWeeklyReport,reportSetup,reportWeeks,reportTransport,decimal,comparison} from './weekly-report';
import {reportFixtureSetup as setup,reportFixtureNow as now,reportFixtureRequest} from './report-fixtures';
beforeEach(()=>initWorkflowDb(':memory:'));afterEach(()=>closeWorkflowDb());
test('Rome complete calendar weeks resolve spring and autumn DST independently',()=>{
  for(const [date,hours]of [['2026-03-30T09:00:00Z',167],['2026-10-26T09:00:00Z',169]] as const){const w=reportWeeks(Date.parse(date))[0]!;expect((w.end-w.start)/3600000).toBe(hours);expect(w.localStart).toBe(date.startsWith('2026-03')?'2026-03-23':'2026-10-19');}
  expect(reportWeeks(Date.parse('2026-10-25T10:00:00Z'))[0]!.localEnd).toBe('2026-10-19');
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
  const req=reportFixtureRequest({mutate:(p,path,r)=>p==='hubspot'&&path.startsWith('/crm/v3/objects/deals?')?{...r,results:r.results.map((x:any)=>({...x,properties:{...x.properties,[field]:null}}))}:r});
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
