import { expect, test } from 'bun:test';
import { getCronTimezone, setCronTimezone } from '../../lib/cron-scheduler';
import { fitBrief, meetingSetup, meetingSetupMatches, parseMeetingGuard, prepareMeetingBriefs, meetingStillCurrent, meetingNotificationKey, meetingTransport, MEETING_BRIEF_LIMIT, type MeetingRequest } from './meeting-briefs';
import { fixtureNow, fixtureSetup, fixtureEvent, fixtureRequest } from './meeting-fixtures';
test('all pages and source links, timezone and stable occurrence/start identity',async()=>{
  const result=await prepareMeetingBriefs(fixtureSetup,fixtureRequest(),fixtureNow);
  expect(result.meetings).toHaveLength(1); const m=result.meetings[0]!;
  expect(m.start).toBe('2026-10-23T09:15:00.000Z');expect(m.brief).toContain('11:15');expect(m.brief).toContain('/contacts/123/contact/42');expect(m.brief).toContain('#all/abc');expect(m.brief).toContain('Discuss pilot timing');
  expect(await meetingStillCurrent(m.guard,fixtureRequest(),fixtureNow)).toBe(true);
  const moved={...m.guard,start:'2026-10-23T09:20:00Z'};expect(meetingNotificationKey(moved)).not.toBe(m.notificationKey);
  expect(meetingNotificationKey({...m.guard,start:'2026-10-23T11:15:00+02:00'})).toBe(m.notificationKey);
});
for(const [name,extra] of Object.entries({cancelled:{status:'cancelled'},allDay:{start:{date:'2026-10-23'}},started:{start:{dateTime:'2026-10-23T09:00:00Z'}},late:{start:{dateTime:'2026-10-23T09:30:00.001Z'}},internal:{attendees:[{email:'staff@example.com'}]},resource:{attendees:[{email:'room@external.test',resource:true}]},declined:{attendees:[{self:true,email:'owner@example.com',responseStatus:'declined'},{email:'customer@external.test'}]}}))
  test('exclude '+name,async()=>expect((await prepareMeetingBriefs(fixtureSetup,fixtureRequest([fixtureEvent(extra)]),fixtureNow)).meetings).toEqual([]));
test('inclusive 30 minute boundary and expanded recurring occurrence identity',async()=>{
  const events=[fixtureEvent({id:'series_20261023',recurringEventId:'series',start:{dateTime:'2026-10-23T09:30:00Z'}})];
  expect((await prepareMeetingBriefs(fixtureSetup,fixtureRequest(events),fixtureNow)).meetings[0]!.eventId).toBe('series_20261023');
});
test('a calendar or event ID of . or .. is refused, so no Calendar URL normalises to another path',async()=>{
  for(const id of ['.','..',' .. ']){
    expect(()=>meetingSetup({...fixtureSetup,internalDomains:'example.com',calendarId:id})).toThrow('calendar ID');
    expect(()=>parseMeetingGuard({setup:{...fixtureSetup,internalDomains:'example.com'},eventId:id,start:'2026-01-01T00:00:00Z',fingerprint:'a'.repeat(64)})).toThrow('event ID');
    await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest([fixtureEvent({id})]),fixtureNow)).rejects.toThrow('event ID');
  }
  expect(parseMeetingGuard({setup:{...fixtureSetup,internalDomains:'example.com'},eventId:'..x',start:'2026-01-01T00:00:00Z',fingerprint:'a'.repeat(64)}).eventId).toBe('..x');
});
test('unknown attendees, pagination cycles and unavailable source fail, not empty success',async()=>{
  await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest([fixtureEvent({attendeesOmitted:true})]),fixtureNow)).rejects.toThrow('omitted');
  await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest(undefined,{cycle:true}),fixtureNow)).rejects.toThrow('cursor');
  for(const fail of ['calendar','gmail','hubspot'])await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest(undefined,{fail}),fixtureNow)).rejects.toThrow('Unavailable');
});
test('freshness rejects reschedules, cancellation, attendee changes and window expiry',async()=>{
  const m=(await prepareMeetingBriefs(fixtureSetup,fixtureRequest(),fixtureNow)).meetings[0]!;
  for(const changed of [fixtureEvent({start:{dateTime:'2026-10-23T09:20:00Z'}}),fixtureEvent({status:'cancelled'}),fixtureEvent({attendees:[{email:'new@external.test'}]})])
    expect(await meetingStillCurrent(m.guard,fixtureRequest(undefined,{changed}),fixtureNow)).toBe(false);
  expect(await meetingStillCurrent(m.guard,fixtureRequest(),fixtureNow+16*60_000)).toBe(false);
});
test('transport cannot contact attendees even with injection in provider content',async()=>{
  let count=0;const request=meetingTransport({calendar:'test',gmail:'test',hubspot:'test'},()=>{},(async()=>{count++;return Response.json({});}) as any);
  for(const path of ['/gmail/v1/users/me/messages/send','/gmail/v1/users/me/drafts?','/gmail/v1/users/me/threads/abc/modify?'])await expect(request('gmail',path,{})).rejects.toThrow('only');
  await expect(request('hubspot','/crm/v3/objects/contacts',{})).rejects.toThrow('only');
  await expect(request('calendar','/calendar/v3/calendars/primary/events',{})).rejects.toThrow('only');
  expect(count).toBe(0);
});
test('DST offset changes use UTC instants, not wall-clock comparisons',async()=>{
  const now=Date.parse('2026-10-25T01:00:00Z');
  const event=fixtureEvent({start:{dateTime:'2026-10-25T02:15:00+01:00'}});
  const m=(await prepareMeetingBriefs(fixtureSetup,fixtureRequest([event]),now)).meetings[0]!;
  expect(m.start).toBe('2026-10-25T01:15:00.000Z');expect(m.brief).toContain('02:15');
});
test('successful empty sources are explicit; deleted event is skipped',async()=>{
  const request:MeetingRequest=async(provider,path)=>provider==='calendar'?{items:[fixtureEvent()]}:provider==='hubspot'?{results:[]}:{threads:[]};
  const m=(await prepareMeetingBriefs(fixtureSetup,request,fixtureNow)).meetings[0]!;
  expect(m.brief).toContain('no matching contact');expect(m.brief).toContain('No matching recent conversations');
  const transport=meetingTransport({calendar:'test',gmail:'test',hubspot:'test'},()=>{},(async()=>new Response('',{status:404})) as any);
  expect(await meetingStillCurrent(m.guard,transport,fixtureNow)).toBe(false);
  await expect(prepareMeetingBriefs(fixtureSetup,transport,fixtureNow)).rejects.toThrow('HTTP 404');
});
test('empty timezone uses the configured Jarvis timezone, not a fixed zone',async()=>{
  const previous=getCronTimezone();
  try{
    setCronTimezone('America/New_York');
    for(const timezone of [undefined,null,''])expect(meetingSetup({...fixtureSetup,internalDomains:'example.com',timezone}).timezone).toBe('America/New_York');
    expect(meetingSetup({...fixtureSetup,internalDomains:'example.com',timezone:'Asia/Tokyo'}).timezone).toBe('Asia/Tokyo');
    const setup=meetingSetup({...fixtureSetup,internalDomains:'example.com',timezone:''});
    const m=(await prepareMeetingBriefs(setup,fixtureRequest(),fixtureNow)).meetings[0]!;
    expect(m.brief).toContain('05:15');expect(m.brief).toContain('(America/New_York)');
  }finally{setCronTimezone(previous);}
});
test('Gmail threads are read as metadata only, never full bodies',async()=>{
  const paths:string[]=[];const base=fixtureRequest();
  await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow);
  const reads=paths.filter(p=>p.startsWith('/gmail/v1/users/me/threads/'));
  expect(reads).toEqual(['/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject']);
  const request=meetingTransport({calendar:'test',gmail:'test',hubspot:'test'},()=>{},(async()=>Response.json({id:'abc',messages:[]})) as any);
  expect(await request('gmail',reads[0]!)).toEqual({id:'abc',messages:[]});
});
const twoMeetings=()=>[fixtureEvent(),fixtureEvent({id:'occurrence-2',summary:'Long history',start:{dateTime:'2026-10-23T09:20:00Z'},attendees:[{email:'owner@example.com',self:true},{email:'big@external.test'}]})];
test('an oversized brief is truncated oldest-first, never dropped, and keeps its notification key',async()=>{
  const paths:string[]=[];const base=fixtureRequest(twoMeetings(),{oversized:'big@external.test'});
  const result=await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow);
  expect(result).not.toHaveProperty('failed');
  expect(result.meetings.map(m=>m.eventId)).toEqual(['occurrence-1','occurrence-2']);expect(result.meetings[0]!.brief).toContain('Discuss pilot timing');
  const long=result.meetings[1]!;expect(long.title).toBe('Long history');expect(long.brief.length).toBeLessThanOrEqual(MEETING_BRIEF_LIMIT);
  const omitted=/(\d+) older message excerpts? from (\d+) conversations? and (\d+) older conversations not read omitted to fit the 24,000 character brief limit; open the meeting or Gmail for the full history\./.exec(long.brief);
  expect(omitted).not.toBeNull();const dropped=Number(omitted![1]),unread=Number(omitted![3]);expect(unread).toBeGreaterThan(0);
  const n=dropped+unread;expect(n).toBeLessThan(30);
  // Newest conversations survive; exactly the n oldest (b29 downwards) are gone.
  for(let i=0;i<30;i++)expect(long.brief.includes('#all/b'+i+'\n')).toBe(i<30-n);
  // Once the brief was full, the remaining (older) listed threads were counted, never read.
  const reads=paths.filter(p=>/\/threads\/b\d+\?/.test(p));expect(reads).toHaveLength(30-unread);
  for(let i=30-unread;i<30;i++)expect(reads.some(p=>p.includes('/threads/b'+i+'?'))).toBe(false);
  const again=await prepareMeetingBriefs(fixtureSetup,fixtureRequest(twoMeetings(),{oversized:'big@external.test'}),fixtureNow);
  expect(again.meetings[1]!.brief).toBe(long.brief);
  const later=await prepareMeetingBriefs(fixtureSetup,fixtureRequest(twoMeetings()),fixtureNow);
  expect(later.meetings.find(m=>m.eventId==='occurrence-2')!.notificationKey).toBe(long.notificationKey);
});
test('fixed context over the limit is cut with a notice, still delivered',async()=>{
  const attendees=[{email:'owner@example.com',self:true},...Array.from({length:8},(_,i)=>({email:`c${i}@external.test`}))];
  const base=fixtureRequest([fixtureEvent({attendees})]);
  const request:MeetingRequest=async(provider,path,body)=>provider==='hubspot'
    ?{results:[{id:'5',properties:{email:body!.filterGroups[0].filters[0].value,firstname:'y'.repeat(1000),lastname:'y'.repeat(1000),company:'y'.repeat(1000)}}]}
    :base(provider,path,body);
  const m=(await prepareMeetingBriefs(fixtureSetup,request,fixtureNow)).meetings[0]!;
  expect(m.brief.length).toBeLessThanOrEqual(MEETING_BRIEF_LIMIT);
  expect(m.brief).toEndWith('Brief cut at the 24,000 character limit; open the meeting, HubSpot or Gmail for the full context.');
  expect(m.brief).toContain('Customer planning');
});
test('HubSpot contact for a different address is never used in the brief',async()=>{
  await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest(undefined,{unrelatedContact:true}),fixtureNow)).rejects.toThrow('unrelated');
});
test('Calendar is asked through now+30min inclusive, since timeMax is exclusive on start',async()=>{
  const paths:string[]=[];const base=fixtureRequest();
  await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow);
  const list=new URL('https://x'+paths.find(p=>p.startsWith('/calendar/'))!).searchParams;
  expect(list.get('timeMin')).toBe('2026-10-23T09:00:00.000Z');expect(list.get('timeMax')).toBe('2026-10-23T09:30:00.001Z');
  // The code-side window still drops anything a provider returns past the boundary.
  const late:MeetingRequest=async(provider)=>provider==='calendar'?{items:[fixtureEvent({start:{dateTime:'2026-10-23T09:30:00.001Z'}})]}:{};
  expect((await prepareMeetingBriefs(fixtureSetup,late,fixtureNow)).meetings).toEqual([]);
});
test('attendee addresses with braces are kept out of the Gmail query without failing the poll',async()=>{
  for(const bad of ['a}b@external.test','{x@external.test','x{@external.test']){
    const paths:string[]=[];const base=fixtureRequest([fixtureEvent({attendees:[{email:'owner@example.com',self:true},{email:'customer@external.test'},{email:bad}]})]);
    const m=(await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow)).meetings[0]!;
    expect(m.brief).toContain(bad+': Gmail not searched');expect(m.brief).toContain('Discuss pilot timing');
    const q=new URL('https://x'+paths.find(p=>p.startsWith('/gmail/v1/users/me/threads?'))!).searchParams.get('q')!;
    expect(q).toMatch(/^\{from:"customer@external\.test" to:"customer@external\.test"\} after:\d+ before:\d+$/);
  }
  // Only brace attendees: no Gmail search at all, still a brief.
  const paths:string[]=[];const base=fixtureRequest([fixtureEvent({attendees:[{email:'owner@example.com',self:true},{email:'{x@external.test'}]})]);
  const only=(await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow)).meetings[0]!;
  expect(only.brief).toContain('{x@external.test: Gmail not searched');expect(paths.some(p=>p.startsWith('/gmail/'))).toBe(false);
  expect(()=>meetingSetup({...fixtureSetup,internalDomains:'example.com',ownerEmail:'o}@example.com'})).toThrow('Invalid email');
  await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest([fixtureEvent({attendees:[{email:'a@b@external.test'}]})]),fixtureNow)).rejects.toThrow('Invalid email');
});
test('transport only reads Gmail threads as metadata with the brief headers',async()=>{
  let count=0;const request=meetingTransport({calendar:'test',gmail:'test',hubspot:'test'},()=>{},(async()=>{count++;return Response.json({id:'abc',messages:[]});}) as any);
  for(const path of ['/gmail/v1/users/me/threads/abc?','/gmail/v1/users/me/threads/abc?format=full','/gmail/v1/users/me/threads/abc?format=raw&metadataHeaders=From',
    '/gmail/v1/users/me/threads/abc?format=metadata','/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=From&format=full',
    '/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=From&fields=messages','/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=Authorization',
    '/gmail/v1/users/me/threads?format=full','/gmail/v1/users/me/threads?q=x&fields=threads'])
    await expect(request('gmail',path)).rejects.toThrow('only');
  expect(count).toBe(0);
  await request('gmail','/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
  await request('gmail','/gmail/v1/users/me/threads?q=x&maxResults=100&includeSpamTrash=false&pageToken=two');
  expect(count).toBe(2);
});
const bigThreads=(count:number,messages:number,snippet:number):MeetingRequest=>async(provider,path,body)=>{
  if(provider==='calendar')return fixtureRequest()(provider,path,body);
  if(provider==='hubspot')return {results:[]};
  if(path.includes('/threads?'))return {threads:Array.from({length:count},(_,i)=>({id:'f'+i.toString(16)}))};
  const id=/threads\/([a-f0-9]+)\?/.exec(path)![1]!,age=parseInt(id.slice(1),16);
  return {id,messages:Array.from({length:messages},(_,j)=>({internalDate:String(fixtureNow-1000-age*60_000-j),snippet:'x'.repeat(snippet),
    payload:{headers:[{name:'From',value:'customer@external.test'},{name:'To',value:'owner@example.com'},{name:'Subject',value:'S'}]}}))};
};
test('an over-budget brief stops reading Gmail threads once full and stays fast (perf guard)',async()=>{
  let reads=0;const request=bigThreads(5000,1,1000);
  const started=performance.now();
  const m=(await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{if(/\/threads\/[a-f0-9]+\?/.test(path))reads++;return request(provider,path,body);},fixtureNow)).meetings[0]!;
  expect(performance.now()-started).toBeLessThan(2000);
  expect(reads).toBeLessThan(40);expect(m.brief.length).toBeLessThanOrEqual(MEETING_BRIEF_LIMIT);
  const omitted=/(\d+) older message excerpts? from (\d+) conversations? and (\d+) older conversations not read omitted/.exec(m.brief)!;
  expect(Number(omitted[3])).toBe(5000-reads);expect(Number(omitted[1])+Number(omitted[3])).toBe(5000-(m.brief.match(/#all\//g)?.length ?? 0));
});
test('fitting thousands of excerpts is linear, not one re-render per dropped excerpt (perf guard)',async()=>{
  // One thread is read whole however full the brief is, so its 5000 messages all reach the fit.
  const started=performance.now();
  const m=(await prepareMeetingBriefs(fixtureSetup,bigThreads(1,5000,200),fixtureNow)).meetings[0]!;
  expect(performance.now()-started).toBeLessThan(2000);
  expect(m.brief.length).toBeLessThanOrEqual(MEETING_BRIEF_LIMIT);
  const omitted=/(\d+) older message excerpts from 1 conversation omitted to fit/.exec(m.brief)!;
  const kept=m.brief.split('\n').filter(l=>l.endsWith('x'.repeat(200))).length;
  expect(kept).toBeGreaterThan(0);expect(Number(omitted[1])+kept).toBe(5000);
});
test('a saved step without a timezone still matches its run setup after Jarvis changes timezone',()=>{
  const previous=getCronTimezone();
  try{
    setCronTimezone('America/New_York');
    const saved={...fixtureSetup,internalDomains:'example.com',timezone:''},setup=meetingSetup(saved);
    expect(meetingSetupMatches(saved,setup)).toBe(true);
    setCronTimezone('Asia/Tokyo');
    expect(meetingSetupMatches(saved,setup)).toBe(true);
    expect(meetingSetupMatches({...saved,timezone:null},setup)).toBe(true);
    // A timezone the step names itself is part of its configuration.
    expect(meetingSetupMatches({...saved,timezone:'Asia/Tokyo'},setup)).toBe(false);
    expect(meetingSetupMatches({...saved,timezone:'America/New_York'},setup)).toBe(true);
    expect(meetingSetupMatches({...saved,calendarId:'other@example.com'},setup)).toBe(false);
    expect(meetingSetupMatches({...saved,ownerEmail:''},setup)).toBe(false);
  }finally{setCronTimezone(previous);}
});
test('a long thread whose older messages interleave with the next thread does not stop reading early',async()=>{
  // f0's newest message is the newest overall, but most of it is older than f1's only message.
  const hour=3600_000,reads:string[]=[];
  const request:MeetingRequest=async(provider,path,body)=>{
    if(provider==='calendar')return fixtureRequest()(provider,path,body);
    if(provider==='hubspot')return {results:[]};
    if(path.includes('/threads?'))return {threads:[{id:'f0'},{id:'f1'},{id:'f2'},{id:'f3'}]};
    const id=/threads\/([a-f0-9]+)\?/.exec(path)![1]!;reads.push(id);
    const msg=(age:number,snippet:string)=>({internalDate:String(fixtureNow-age),snippet,payload:{headers:[{name:'From',value:'customer@external.test'},{name:'Subject',value:'S'}]}});
    if(id==='f0')return {id,messages:Array.from({length:100},(_,i)=>msg((i+1)*hour,'a'.repeat(400)))};
    if(id==='f1')return {id,messages:[msg(1.5*hour,'NEWER-THAN-MOST-OF-F0')]};
    return {id,messages:[msg(200*hour,'OLDEST')]};
  };
  const m=(await prepareMeetingBriefs(fixtureSetup,request,fixtureNow)).meetings[0]!;
  // f1 is read and kept; f2 is read, found older than everything kept, and f3 is then counted unread.
  expect(reads).toEqual(['f0','f1','f2']);expect(m.brief).toContain('NEWER-THAN-MOST-OF-F0');expect(m.brief).toContain('#all/f1\n');
  expect(m.brief).not.toContain('OLDEST');expect(m.brief).toMatch(/older message excerpts from 2 conversations and 1 older conversation not read omitted/);
  expect(m.brief.length).toBeLessThanOrEqual(MEETING_BRIEF_LIMIT);
});
test('transport refuses a provider whose account was not resolved, before any fetch',async()=>{
  let count=0;const request=meetingTransport({calendar:'t'},()=>{},(async()=>{count++;return Response.json({id:'abc',messages:[]});}) as any);
  await expect(request('gmail','/gmail/v1/users/me/threads/abc?format=metadata&metadataHeaders=From')).rejects.toThrow('No gmail account was resolved');
  await expect(request('hubspot','/crm/v3/objects/contacts/search',{filterGroups:[]})).rejects.toThrow('No hubspot account was resolved');
  expect(count).toBe(0);
  await request('calendar','/calendar/v3/calendars/primary/events/abc');expect(count).toBe(1);
});
test('fitBrief output is exact at the limit, including the link of a conversation that lost its last excerpt',()=>{
  const ex=(date:number,text:string)=>({date,line:()=>text});
  const [A,B,C]=['a','b','c'].map(c=>c.repeat(300)) as [string,string,string];
  const conversations=[{id:'a',excerpts:[ex(1,A),ex(3,C)]},{id:'b',excerpts:[ex(2,B)]}];
  const link=(id:string)=>'https://mail.google.com/mail/u/?authuser=o%40x.io#all/'+id;
  const tail='omitted to fit the 24,000 character brief limit; open the meeting or Gmail for the full history.';
  const snippets='Email excerpts are snippets; open the source links for full conversations.';
  const full=['H',A,C,link('a'),B,link('b'),snippets].join('\n');
  expect(fitBrief(['H'],conversations,0,'o@x.io',full.length)).toBe(full);
  // Dropping only the oldest (aaaa) keeps both links.
  const one=['H',C,link('a'),B,link('b'),'1 older message excerpt from 1 conversation '+tail,snippets].join('\n');
  expect(fitBrief(['H'],conversations,0,'o@x.io',full.length-1)).toBe(one);expect(fitBrief(['H'],conversations,0,'o@x.io',one.length)).toBe(one);
  // Dropping bbbb too removes b's link; this fits exactly at its own length.
  const two=['H',C,link('a'),'2 older message excerpts from 2 conversations '+tail,snippets].join('\n');
  expect(fitBrief(['H'],conversations,0,'o@x.io',one.length-1)).toBe(two);expect(fitBrief(['H'],conversations,0,'o@x.io',two.length)).toBe(two);
  const unread=['H',C,link('a'),'2 older message excerpts from 2 conversations and 3 older conversations not read '+tail,snippets].join('\n');
  expect(fitBrief(['H'],conversations,3,'o@x.io',unread.length)).toBe(unread);
});
