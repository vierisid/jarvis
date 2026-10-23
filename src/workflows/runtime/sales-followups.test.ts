import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initWorkflowDb,closeWorkflowDb,getWorkflowDb} from '../db';
import {salesLedger} from '../db/repos/sales-followup';
import {processSalesFollowups,salesSetup,salesDay,salesIdentity,salesTransport} from './sales-followups';
import {salesFixtureSetup as setup,salesFixtureNow as now,salesFixtureDeal as deal,salesFixtureRequest as request} from './sales-fixtures';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'jarvis-sales-'));initWorkflowDb(join(dir,'fixture.db'));});
afterEach(()=>{closeWorkflowDb();rmSync(dir,{recursive:true,force:true});});
const run=(req=request(),clock=()=>now,scope='fixture')=>processSalesFollowups(setup,req,salesLedger('run'),scope,clock);

test('paginated deals create personalized drafts and one complete summary',async()=>{
  const drafts:any[]=[],calls:string[]=[];const r=await run(request([deal(),deal(2)],{drafts,calls}));
  expect(r.counts.drafted).toBe(2);expect(r.results).toHaveLength(2);expect(r.summary).toContain('Nothing sent');
  expect(calls.some(c=>c.includes('after=next'))).toBe(true);
  const raw=Buffer.from(drafts[0].message.raw,'base64url').toString();
  expect(raw).toContain('To: person1@example.net');expect(raw).not.toContain('\r\nBcc:');
  expect(Buffer.from(raw.split('\r\n\r\n')[1]!,'base64').toString()).toContain('Project 1 for Company 1');
});
test('repeated and concurrent runs claim a contact only once',async()=>{
  const drafts:any[]=[],req=request([deal()],{drafts});
  const all=await Promise.all([run(req),run(req),run(req)]);expect(drafts).toHaveLength(1);
  expect(all.flatMap(x=>x.results).filter(r=>r.status==='drafted')).toHaveLength(1);
  expect((await run(req)).counts.already_processed).toBe(1);
});
test('duplicate deals for one contact create one draft',async()=>{
  const drafts:any[]=[],base=request([deal(),deal(2)],{drafts});
  const r=await run(async(p,path,body)=>path.includes('/deals/2/associations/')?{results:[{toObjectId:'1'}]}:base(p,path,body));
  expect(drafts).toHaveLength(1);expect(r.counts.already_processed).toBe(1);
});
test('recent reply on a later page vetoes drafts',async()=>{
  const drafts:any[]=[],calls:string[]=[];const r=await run(request([deal()],{drafts,calls,replied:['person1@example.net'],pageTwoReply:true}));
  expect(r.counts.replied).toBe(1);expect(drafts).toHaveLength(0);expect(calls.some(c=>c.includes('pageToken=next'))).toBe(true);
});
test('ambiguous sender or multiple contacts require review, never guess',async()=>{
  for(const opts of [{multipleContacts:true},{replied:['person1@example.net'],badSender:true}]) {
    const drafts:any[]=[];const r=await run(request([deal()],{...opts,drafts}),()=>now,JSON.stringify(opts));
    expect(r.counts.review).toBe(1);expect(drafts).toHaveLength(0);
  }
});
test('one deal failure does not stop later deals; summary retains failure',async()=>{
  const drafts:any[]=[];const r=await run(request([deal(),deal(2)],{drafts,failContact:'1'}));
  expect(r.counts.review).toBe(1);expect(r.counts.drafted).toBe(1);expect(r.summary).toContain('Contact read unavailable');
});
test('lost draft response stays uncertain across database reopen and repeated runs',async()=>{
  const drafts:any[]=[];const first=await run(request([deal()],{drafts,unknownDraft:true}));
  expect(first.counts.unknown).toBe(1);closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));
  const second=await run(request([deal()],{drafts}));expect(second.counts.review).toBe(1);expect(drafts).toHaveLength(1);
  expect(getWorkflowDb().query('select state from workflow_sales_followup').get()).toEqual({state:'unknown'});
});
test('claim survives a crash before completion and history cleanup',async()=>{
  const key=salesIdentity('fixture',setup,'person1@example.net',salesDay(now,setup.timezone).date);
  expect(salesLedger('interrupted').claim(key)).toBe('claimed');closeWorkflowDb();initWorkflowDb(join(dir,'fixture.db'));
  const drafts:any[]=[];expect((await run(request([deal()],{drafts}))).counts.review).toBe(1);expect(drafts).toHaveLength(0);
});
test('closed, recent and missing-date deals are not drafted; boundary is inclusive',async()=>{
  const drafts:any[]=[];const r=await run(request([deal(1,{dealstage:'closedwon'}),deal(2,{last_activity:new Date(now-7*86400_000+1).toISOString()}),deal(3,{last_activity:null}),deal(4,{last_activity:new Date(now-7*86400_000).toISOString()})],{drafts}));
  expect(r.counts.drafted).toBe(1);expect(r.counts.review).toBe(1);expect(r.results.find(r=>r.status==='drafted')!.dealId).toBe('4');
});
test('fresh deal check skips changed activity',async()=>{
  const drafts:any[]=[];const r=await run(request([deal()],{drafts,changedDeal:deal(1,{last_activity:new Date(now).toISOString()})}));expect(r.counts.ineligible).toBe(1);expect(drafts).toHaveLength(0);
});
test('full discovery failure occurs before any drafting',async()=>{
  const drafts:any[]=[];await expect(run(request([deal()],{drafts,cycle:true}))).rejects.toThrow('cursor');expect(drafts).toHaveLength(0);
});
test('mailbox mismatch and closed stage configuration fail before writes',async()=>{
  const drafts:any[]=[];await expect(run(request([deal()],{drafts,owner:'different@example.com'}))).rejects.toThrow('does not match');
  await expect(processSalesFollowups({...setup,openStageIds:['closedwon']},request([deal()],{drafts}),salesLedger('run'),'fixture',()=>now)).rejects.toThrow('confirmed open');expect(drafts).toHaveLength(0);
});
test('Rome date handles UTC boundary and DST; weekends perform no access',async()=>{
  expect(salesDay(Date.parse('2026-10-22T22:30:00Z'),'Europe/Rome')).toEqual({date:'2026-10-23',weekday:true});
  expect(salesDay(Date.parse('2026-10-25T23:30:00Z'),'Europe/Rome')).toEqual({date:'2026-10-26',weekday:true});
  const calls:string[]=[];await run(request([deal()],{calls}),()=>Date.parse('2026-10-24T09:00:00Z'));expect(calls).toHaveLength(0);
  expect(salesIdentity('a',setup,'PERSON1@example.net','2026-10-23')).toBe(salesIdentity('a',setup,'person1@example.net','2026-10-23'));
  expect(salesIdentity('a',setup,'person1@example.net','2026-10-23')).not.toBe(salesIdentity('a',setup,'person1@example.net','2026-10-26'));
});
test('date rollover before dispatch stops draft and records review',async()=>{
  let ticks=0;const drafts:any[]=[];const r=await run(request([deal()],{drafts}),()=>++ticks<3?now:now+86400_000);
  expect(r.counts.review).toBe(1);expect(drafts).toHaveLength(0);
});
test('transport excludes send, draft update, arbitrary hosts, mutations and redirects',async()=>{
  const calls:any[]=[];const req=salesTransport({hubspot:'synthetic',gmail:'synthetic'},()=>{},(async(url:any,init:any)=>{calls.push({url,init});return Response.json({id:'d',message:{id:'m'}});}) as typeof fetch);
  for(const [provider,path,body] of [['gmail','/gmail/v1/users/me/drafts/send',{}],['gmail','/gmail/v1/users/me/messages/send',{}],['gmail','/gmail/v1/users/me/drafts/1',{}],['hubspot','/crm/v3/objects/deals/1',{}],['gmail','https://evil.invalid',undefined],['gmail','/gmail/v1/users/me/threads/abc?format=full',{}]] as const)
    await expect(req(provider,path,body)).rejects.toThrow('only permit');
  expect(calls).toHaveLength(0);await req('gmail','/gmail/v1/users/me/drafts',{message:{raw:'eA'}});expect(calls[0].init.redirect).toBe('error');expect(calls[0].init.method).toBe('POST');
});
test('setup rejects credentials, missing CRM, invalid windows and injection',()=>{
  for(const v of [{crmProvider:''},{replyLookbackDays:0},{inactivityProperty:'x?inject'},{gmailConnection:'{{connections.secret}}'},{ownerEmail:'x@example.com\r\nBcc:x@y.com'}])expect(()=>salesSetup({...setup,...v})).toThrow();
});

test('cancellation stops the batch even when one draft already completed',async()=>{
  const drafts:any[]=[];
  await expect(processSalesFollowups(setup,request([deal(),deal(2)],{drafts}),salesLedger('run'),'fixture',()=>now,()=>{if(drafts.length)throw Error('Run canceled');})).rejects.toThrow('Run canceled');
  expect(drafts).toHaveLength(1);
});
test('outbound, draft, old and unrelated messages do not count as recent replies',async()=>{
  for(const override of [{labelIds:['SENT']},{labelIds:['DRAFT']},{internalDate:String(now-8*86400_000)},{payload:{headers:[{name:'From',value:'someoneelse@example.net'}]}}]) {
    const drafts:any[]=[],base=request([deal()],{drafts,replied:['person1@example.net']});
    const r=await run(async(p,path,body)=>{const result=await base(p,path,body);if(path.includes('/threads/abc?'))Object.assign(result.messages[0],override);return result;},()=>now,JSON.stringify(override));
    expect(r.counts.drafted).toBe(1);
  }
});
test('Unicode personalization uses folded MIME without header injection',async()=>{
  const drafts:any[]=[];await run(request([deal(1,{dealname:'\r\nBcc: nobody@example.com '+ '🌊'.repeat(140)})],{drafts}));
  const raw=Buffer.from(drafts[0].message.raw,'base64url').toString();
  expect(raw.split('\r\n').every(line=>Buffer.byteLength(line)<998)).toBe(true);expect(raw).not.toContain('\r\nBcc:');
});
