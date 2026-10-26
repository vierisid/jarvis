import { meetingSetup, type MeetingRequest } from './meeting-briefs';
export const fixtureNow = Date.parse('2026-10-23T09:00:00Z');
export const fixtureSetup = meetingSetup({calendarConnection:'fixture-calendar',gmailConnection:'fixture-gmail',hubspotConnection:'fixture-hubspot',calendarId:'team@example.com',ownerEmail:'owner@example.com',internalDomains:'example.com',hubspotPortalId:'123',recentDays:30,timezone:'Europe/Rome'});
export function fixtureEvent(extra: any = {}) { return {id:'occurrence-1',summary:'Customer planning',htmlLink:'https://calendar.google.com/calendar/event?eid=fixture',updated:'2026-10-23T08:00:00Z',start:{dateTime:'2026-10-23T11:15:00+02:00'},attendees:[{email:'owner@example.com',self:true},{email:'customer@external.test'}],...extra}; }
export function fixtureRequest(events = [fixtureEvent()], hooks: { changed?: any; fail?: string; cycle?: boolean; oversized?: string } = {}): MeetingRequest {
  return async(provider,path,body)=>{
    if(hooks.fail === provider) throw Error('Unavailable '+provider);
    if(provider === 'calendar') {
      if(!path.includes('?')) return hooks.changed ?? events.find(e=>path.endsWith('/events/'+encodeURIComponent(e.id))) ?? events[0]!;
      const params=new URL('https://fixture'+path).searchParams,cursor=params.get('pageToken');
      // Like Google Calendar, timeMax is an exclusive upper bound on start time.
      const timeMax=Date.parse(params.get('timeMax') ?? ''),startOf=(e:any)=>Date.parse(e.start?.dateTime ?? e.start?.date);
      const items=Number.isFinite(timeMax) ? events.filter(e=>!(startOf(e) >= timeMax)) : events;
      return cursor ? {items,...(hooks.cycle?{nextPageToken:'two'}:{})} : {items:[],nextPageToken:'two'};
    }
    if(provider === 'hubspot') return body?.filterGroups?.[0]?.filters?.[0]?.value !== 'customer@external.test' ? {results:[]} : body?.after ? {results:[{id:'42',properties:{email:'customer@external.test',firstname:'Customer',company:'Example'}}]} : {results:[],paging:{next:{after:'1'}}};
    // hooks.oversized: that attendee has enough long recent threads to exceed the brief limit.
    const big=/\/threads\/b(\d+)\?/.exec(path);
    if(big)return{id:'b'+big[1],messages:[{internalDate:String(fixtureNow-1000),snippet:'x'.repeat(1000),payload:{headers:[{name:'From',value:hooks.oversized},{name:'To',value:'owner@example.com'},{name:'Subject',value:'Long'}]}}]};
    if(hooks.oversized && path.includes('pageToken') && new URL('https://fixture'+path).searchParams.get('q')!.includes(`"${hooks.oversized}"`))
      return {threads:Array.from({length:30},(_,i)=>({id:'b'+i}))};
    if(path.includes('/threads/abc?'))return{id:'abc',messages:[{internalDate:String(fixtureNow-1000),snippet:'Discuss pilot timing',payload:{headers:[{name:'From',value:'Customer <customer@external.test>'},{name:'To',value:'owner@example.com'},{name:'Subject',value:'Pilot'}]}}]};
    return path.includes('pageToken') ? {threads:[{id:'abc'}]} : {threads:[],nextPageToken:'two'};
  };
}
