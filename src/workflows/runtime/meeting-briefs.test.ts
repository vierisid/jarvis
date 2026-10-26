import { expect, test } from 'bun:test';
import { getCronTimezone, setCronTimezone } from '../../lib/cron-scheduler';
import { meetingSetup, prepareMeetingBriefs, meetingStillCurrent, meetingNotificationKey, meetingTransport, type MeetingRequest } from './meeting-briefs';
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
test('an oversized brief fails only its own meeting, visibly, and leaves its key for a later poll',async()=>{
  const result=await prepareMeetingBriefs(fixtureSetup,fixtureRequest(twoMeetings(),{oversized:'big@external.test'}),fixtureNow);
  expect(result.meetings.map(m=>m.eventId)).toEqual(['occurrence-1']);expect(result.meetings[0]!.brief).toContain('Discuss pilot timing');
  expect(result.failed).toHaveLength(1);const failure=result.failed[0]!;
  expect(failure).toMatchObject({eventId:'occurrence-2',start:'2026-10-23T09:20:00.000Z',title:'Long history'});expect(failure.reason).toContain('24,000');
  const later=await prepareMeetingBriefs(fixtureSetup,fixtureRequest(twoMeetings()),fixtureNow);
  expect(later.failed).toEqual([]);expect(later.meetings.find(m=>m.eventId==='occurrence-2')!.notificationKey).toBe(failure.notificationKey);
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
test('addresses that could break the Gmail OR group are rejected',async()=>{
  for(const bad of ['a}b@external.test','{x@external.test','x{@external.test'])
    await expect(prepareMeetingBriefs(fixtureSetup,fixtureRequest([fixtureEvent({attendees:[{email:bad}]})]),fixtureNow)).rejects.toThrow('Invalid email');
  expect(()=>meetingSetup({...fixtureSetup,internalDomains:'example.com',ownerEmail:'o}@example.com'})).toThrow('Invalid email');
  const paths:string[]=[];const base=fixtureRequest();
  await prepareMeetingBriefs(fixtureSetup,async(provider,path,body)=>{paths.push(path);return base(provider,path,body);},fixtureNow);
  const q=new URL('https://x'+paths.find(p=>p.startsWith('/gmail/v1/users/me/threads?'))!).searchParams.get('q')!;
  expect(q).toMatch(/^\{from:"customer@external\.test" to:"customer@external\.test"\} after:\d+ before:\d+$/);
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
