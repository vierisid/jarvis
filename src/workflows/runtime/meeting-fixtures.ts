import { meetingSetup, type MeetingRequest } from './meeting-briefs';
export const fixtureNow = Date.parse('2026-10-23T09:00:00Z');
export const fixtureSetup = meetingSetup({calendarConnection:'fixture-calendar',gmailConnection:'fixture-gmail',hubspotConnection:'fixture-hubspot',calendarId:'team@example.com',ownerEmail:'owner@example.com',internalDomains:'example.com',hubspotPortalId:'123',recentDays:30,timezone:'Europe/Rome'});
export function fixtureEvent(extra: any = {}) { return {id:'occurrence-1',summary:'Customer planning',htmlLink:'https://calendar.google.com/calendar/event?eid=fixture',updated:'2026-10-23T08:00:00Z',start:{dateTime:'2026-10-23T11:15:00+02:00'},attendees:[{email:'owner@example.com',self:true},{email:'customer@external.test'}],...extra}; }
export function fixtureRequest(events = [fixtureEvent()], hooks: { changed?: any; fail?: string; cycle?: boolean } = {}): MeetingRequest {
  return async(provider,path,body)=>{
    if(hooks.fail === provider) throw Error('Unavailable '+provider);
    if(provider === 'calendar') {
      if(!path.includes('?')) return hooks.changed ?? events[0]!;
      const cursor=new URL('https://fixture'+path).searchParams.get('pageToken');
      return cursor ? {items:events,...(hooks.cycle?{nextPageToken:'two'}:{})} : {items:[],nextPageToken:'two'};
    }
    if(provider === 'hubspot') return body?.after ? {results:[{id:'42',properties:{email:'customer@external.test',firstname:'Customer',company:'Example'}}]} : {results:[],paging:{next:{after:'1'}}};
    if(path.includes('/threads/abc?'))return{id:'abc',messages:[{internalDate:String(fixtureNow-1000),snippet:'Discuss pilot timing',payload:{headers:[{name:'From',value:'Customer <customer@external.test>'},{name:'To',value:'owner@example.com'},{name:'Subject',value:'Pilot'}]}}]};
    return path.includes('pageToken') ? {threads:[{id:'abc'}]} : {threads:[],nextPageToken:'two'};
  };
}
