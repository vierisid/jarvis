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
