import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initWorkflowDb,closeWorkflowDb,getWorkflowDb} from '../db';
import {salesLedger} from '../db/repos/sales-followup';
import {processSalesFollowups,salesSetup,salesDay,salesIdentity,salesTransport,isSalesStep,SALES_PIECE,SALES_ACTION,SALES_DEAL_LIMIT,type SalesRequest} from './sales-followups';
import {nodeConnectionReferences} from '../db/repos/binding-pins';
import {workflowSafeguards} from './workflow-safeguards';
import {compileWorkflow} from './workflow-readiness';
import {getCronTimezone,setCronTimezone} from '../../lib/cron-scheduler';
import {salesFixtureSetup as setup,salesFixtureNow as now,salesFixtureDeal as deal,salesFixtureRequest as request} from './sales-fixtures';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'jarvis-sales-'));initWorkflowDb(join(dir,'fixture.db'));});
afterEach(()=>{closeWorkflowDb();rmSync(dir,{recursive:true,force:true});});
const run=(req=request(),clock=()=>now,scope='fixture')=>processSalesFollowups(setup,req,salesLedger('run'),scope,clock);

test('paginated deals create personalized drafts and one complete summary',async()=>{
  const drafts:any[]=[],searches:any[]=[];const r=await run(request([deal(),deal(2)],{drafts,searches}));
  expect(r.counts.drafted).toBe(2);expect(r.results).toHaveLength(2);expect(r.summary).toContain('Nothing sent');
  expect(searches.map(b=>b.after)).toEqual([undefined,'next']);
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
  // The deal search is the only HubSpot POST, and only with search fields.
  for(const [path,body] of [['/crm/v3/objects/deals/search',{filterGroups:[],properties:['dealstage'],inputs:[{id:'1'}]}],['/crm/v3/objects/contacts/search',{filterGroups:[]}],['/crm/v3/objects/deals/batch/update',{inputs:[]}]] as const)
    await expect(req('hubspot',path,body as any)).rejects.toThrow('only permit');
  await req('hubspot','/crm/v3/objects/deals/search',{filterGroups:[],properties:['dealstage'],sorts:[],limit:100,after:'1'});
  expect(calls[1].url).toBe('https://api.hubapi.com/crm/v3/objects/deals/search');expect(calls[1].init.method).toBe('POST');
});
test('discovery searches only the selected open stages and fails clearly above the cap',async()=>{
  const searches:any[]=[];await run(request([deal()],{searches}));
  expect(searches[0].filterGroups).toEqual([{filters:[{propertyName:'dealstage',operator:'IN',values:['open']}]}]);
  expect(searches[0].properties).toEqual(['dealname','dealstage','last_activity']);
  const drafts:any[]=[];
  await expect(run(request([deal()],{drafts,searchTotal:SALES_DEAL_LIMIT+1}))).rejects.toThrow(`More than ${SALES_DEAL_LIMIT} deals are in the selected open stages`);
  const many=Array.from({length:SALES_DEAL_LIMIT+1},(_,i)=>deal(i+1)),base=request(many,{drafts});
  // Pages that keep coming past the cap stop discovery even when the reported total is low.
  await expect(run(async(p,path,body)=>path.endsWith('/search')?{total:1,results:many.slice(0,100),paging:{next:{after:String(body?.after ? Number(body.after)+1 : 1)}}}:base(p,path,body))).rejects.toThrow(`More than ${SALES_DEAL_LIMIT}`);
  expect(drafts).toHaveLength(0);
});
test('setup rejects credentials, missing CRM, invalid windows and injection',()=>{
  for(const v of [{crmProvider:''},{replyLookbackDays:0},{inactivityProperty:'x?inject'},{gmailConnection:'{{connections.secret}}'},{ownerEmail:'x@example.com\r\nBcc:x@y.com'}])expect(()=>salesSetup({...setup,...v})).toThrow();
});

test('cancellation stops the batch even when one draft already completed',async()=>{
  const drafts:any[]=[];
  await expect(processSalesFollowups(setup,request([deal(),deal(2)],{drafts}),salesLedger('run'),'fixture',()=>now,()=>{if(drafts.length)throw Error('Run canceled');})).rejects.toThrow('Run canceled | Drafts saved before stop: Deal 1 draft draft-1');
  expect(drafts).toHaveLength(1);
  // Deal 1's draft receipt is durable; deal 2 was never claimed, so its contact is free for the next run.
  const rows=getWorkflowDb().query('select identity,state,result from workflow_sales_followup').all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].identity).toBe(salesIdentity('fixture',setup,'person1@example.net',salesDay(now,setup.timezone).date));
  expect(rows[0].state).toBe('drafted');expect(JSON.parse(rows[0].result)).toMatchObject({dealId:'1',status:'drafted',draftId:'draft-1'});
});
/** Deals 1 and 2 share contact 1, so they share one daily claim. */
const shared=(base:ReturnType<typeof request>,override?:(path:string)=>any):ReturnType<typeof request>=>async(p,path,body)=>{
  const o=override?.(path);if(o!==undefined)return typeof o==='function'?o():o;
  return path.includes('/deals/2/associations/')?{results:[{toObjectId:'1'}]}:base(p,path,body);
};
const states=()=>(getWorkflowDb().query('select state from workflow_sales_followup').all() as any[]).map(r=>r.state);
test('a deal-specific failure does not consume the contact for its other deals',async()=>{
  const drafts:any[]=[];const r=await run(shared(request([deal(1,{dealname:''}),deal(2)],{drafts})));
  expect(r.results.map(x=>[x.dealId,x.status])).toEqual([['1','review'],['2','drafted']]);
  expect(r.results[0]!.detail).toContain('Deal name is missing');expect(drafts).toHaveLength(1);
  expect(Buffer.from(Buffer.from(drafts[0].message.raw,'base64url').toString().split('\r\n\r\n')[1]!,'base64').toString()).toContain('Project 2');
  expect(states()).toEqual(['drafted']);
  expect(r.summary).not.toContain('already processed.');
});
test('failures after the claim but before any draft request free the contact',async()=>{
  for(const [label,override] of [
    ['reread ineligible',(path:string)=>path.startsWith('/crm/v3/objects/deals/1?')?deal(1,{dealstage:'closedwon'}):undefined],
    ['reread missing name',(path:string)=>path.startsWith('/crm/v3/objects/deals/1?')?deal(1,{dealname:' '}):undefined],
    ['transient reread',(path:string)=>path.startsWith('/crm/v3/objects/deals/1?')?()=>{throw Error('hubspot request failed (HTTP 503)');}:undefined],
  ] as const) {
    const drafts:any[]=[];const r=await run(shared(request([deal(),deal(2)],{drafts}),override),()=>now,label);
    expect(r.results.map(x=>x.status)).toEqual([label==='reread ineligible'?'ineligible':'review','drafted']);
    expect(drafts).toHaveLength(1);
  }
  expect(states()).toEqual(['drafted','drafted','drafted']);
});
test('an uncertain draft request keeps the contact claimed for its other deals',async()=>{
  const drafts:any[]=[],base=request([deal(),deal(2)],{drafts});
  const r=await run(shared(base,path=>path==='/gmail/v1/users/me/drafts'&&!drafts.length?()=>{drafts.push('lost');throw Error('Reply lost after dispatch');}:undefined));
  expect(r.results.map(x=>x.status)).toEqual(['unknown','review']);
  expect(r.results[1]!.detail).toContain('unresolved');expect(drafts).toHaveLength(1);expect(states()).toEqual(['unknown']);
});
test('an earlier claim that drafted nothing is never reported as processed',async()=>{
  const key=salesIdentity('fixture',setup,'person1@example.net',salesDay(now,setup.timezone).date);
  for(const [state,status,text] of [['review','review','without a draft'],['ineligible','review','without a draft'],['replied','replied','replied recently'],['drafted','already_processed','follow-up draft']] as const) {
    getWorkflowDb().run('delete from workflow_sales_followup');
    getWorkflowDb().run('insert into workflow_sales_followup(identity,owner,state,created) values(?,?,?,?)',[key,'earlier',state,now]);
    const drafts:any[]=[];const r=await run(request([deal()],{drafts}));
    expect(r.results[0]).toMatchObject({status,detail:expect.stringContaining(text)});expect(drafts).toHaveLength(0);
    if(state!=='drafted')expect(r.summary).not.toContain('Contact already');
  }
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
test('a sender display name repeating the contact address is still a recent reply',async()=>{
  const drafts:any[]=[],base=request([deal()],{drafts,replied:['person1@example.net']});
  const r=await run(async(p,path,body)=>{const result=await base(p,path,body);if(path.includes('/threads/abc?'))result.messages[0].payload={headers:[{name:'From',value:'"Person1@Example.net" <person1@example.net>'}]};return result;});
  expect(r.counts.replied).toBe(1);expect(drafts).toHaveLength(0);
});
test('empty timezone uses the timezone configured for Jarvis, explicit zones stay',()=>{
  const previous=getCronTimezone();
  try {
    setCronTimezone('America/New_York');
    for(const timezone of [undefined,null,'',' '])expect(salesSetup({...setup,timezone}).timezone).toBe('America/New_York');
    expect(salesSetup({...setup,timezone:'Asia/Tokyo'}).timezone).toBe('Asia/Tokyo');
    setCronTimezone(null);
    expect(salesSetup({...setup,timezone:''}).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally { setCronTimezone(previous); }
});
test('every check treats a short sales piece name as the sales step; readiness refuses it',()=>{
  const graph=(pieceName:string)=>({name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'schedule',input:{cron_expression:'0 9 * * 1-5'}},
    nextAction:{name:'prepare',type:'PIECE',settings:{pieceName,actionName:SALES_ACTION,input:{...setup}}}});
  for(const name of [SALES_PIECE,'jarvis-sales']) {
    const g=graph(name),node=g.nextAction as any;
    expect(isSalesStep(node.settings)).toBe(true);
    expect(nodeConnectionReferences(node).map(([id])=>id)).toEqual(['fixture-hubspot','fixture-gmail']);
    expect(workflowSafeguards(g).safeguards.map(x=>x.kind)).toContain('sales-draft-only');
    const refused=compileWorkflow(g,{connection:()=>null}).issues.filter(i=>i.code==='PIECE'&&i.message.includes('full piece name'));
    expect(refused).toHaveLength(name===SALES_PIECE?0:1);
  }
  expect(isSalesStep({pieceName:'@evil/piece-jarvis-sales',actionName:SALES_ACTION})).toBe(false);
});

/** The real transport over a fetch that serves the fixture, so HTTP status handling is exercised. */
const overFetch=(base:SalesRequest,respond:(path:string)=>Response|undefined,checkpoint:()=>void=()=>{})=>salesTransport({hubspot:'synthetic',gmail:'synthetic'},checkpoint,(async(url:any,init:any)=>{
  const u=new URL(String(url)),path=u.pathname+u.search,custom=respond(path);if(custom)return custom;
  return Response.json(await base(u.hostname==='gmail.googleapis.com'?'gmail':'hubspot',path,init.body?JSON.parse(init.body):undefined));
}) as typeof fetch);
test('a definite Gmail rejection of a draft frees the contact for its other deals',async()=>{
  for(const status of [400,401,403,404,422,429]) {
    getWorkflowDb().run('delete from workflow_sales_followup');
    const drafts:any[]=[];let rejected=0;
    const req=overFetch(shared(request([deal(),deal(2)],{drafts})),path=>path==='/gmail/v1/users/me/drafts'&&!rejected++?new Response('{}',{status}):undefined);
    const r=await run(req);
    expect(r.results.map(x=>[x.dealId,x.status])).toEqual([['1','review'],['2','drafted']]);
    expect(r.results[0]!.detail).toContain(`Gmail rejected the draft (HTTP ${status})`);
    expect(drafts).toHaveLength(1);expect(states()).toEqual(['drafted']);
  }
});
test('ambiguous draft failures keep the contact claimed',async()=>{
  for(const status of [408,409,500,503]) {
    getWorkflowDb().run('delete from workflow_sales_followup');
    const drafts:any[]=[];let failed=0;
    const req=overFetch(shared(request([deal(),deal(2)],{drafts})),path=>path==='/gmail/v1/users/me/drafts'&&!failed++?new Response('{}',{status}):undefined);
    const r=await run(req);
    expect(r.results.map(x=>x.status)).toEqual(['unknown','review']);expect(drafts).toHaveLength(0);expect(states()).toEqual(['unknown']);
  }
});
test('a stop at the transport checkpoint before the draft request frees the claim and stops the run',async()=>{
  const drafts:any[]=[];let armed=false;
  const check=()=>{if(armed)throw Error('Account binding changed');};
  const transport=overFetch(request([deal()],{drafts}),()=>undefined,check);
  const req:SalesRequest=(p,path,body)=>{if(path==='/gmail/v1/users/me/drafts')armed=true;return transport(p,path,body);};
  await expect(processSalesFollowups(setup,req,salesLedger('run'),'fixture',()=>now,check)).rejects.toThrow('Account binding changed');
  expect(drafts).toHaveLength(0);expect(states()).toEqual([]);
});
