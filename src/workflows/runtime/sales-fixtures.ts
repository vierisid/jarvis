import type { SalesRequest, SalesSetup } from './sales-followups';
export const salesFixtureNow=Date.parse('2026-10-23T09:00:00Z');
export const salesFixtureSetup:SalesSetup={crmProvider:'hubspot',hubspotConnection:'fixture-hubspot',gmailConnection:'fixture-gmail',ownerEmail:'owner@example.com',senderName:'Alex',openStageIds:['open'],inactivityProperty:'last_activity',replyLookbackDays:7,inactivityDays:7,timezone:'Europe/Rome'};
export const salesFixtureDeal=(n=1,properties:Record<string,unknown>={})=>({id:String(n),archived:false,properties:{dealname:`Project ${n}`,dealstage:'open',last_activity:new Date(salesFixtureNow-8*86400_000).toISOString(),...properties}});
export interface SalesFixtureOptions {
  drafts?:any[];calls?:string[];replied?:string[];failContact?:string;unknownDraft?:boolean;cycle?:boolean;
  multipleContacts?:boolean;changedDeal?:any;owner?:string;pageTwoReply?:boolean;badSender?:boolean;
}
export function salesFixtureRequest(deals:any[]=[salesFixtureDeal()],options:SalesFixtureOptions={}):SalesRequest {
  return async(provider,path,body)=>{
    options.calls?.push(`${provider} ${body?'POST':'GET'} ${path}`);
    const u=new URL('https://fixture.invalid'+path),cursor=u.searchParams.get('after');
    if(path==='/gmail/v1/users/me/profile')return {emailAddress:options.owner ?? 'owner@example.com'};
    if(path==='/crm/v3/properties/deals/last_activity')return {name:'last_activity',type:'datetime'};
    if(path==='/crm/v3/pipelines/deals')return {results:[{stages:[{id:'open',metadata:{isClosed:'false'}},{id:'closedwon',metadata:{isClosed:'true'}}]}]};
    if(u.pathname==='/crm/v3/objects/deals') {
      if(options.cycle)return {results:[],paging:{next:{after:'same'}}};
      return !cursor ? {results:deals.slice(0,1),...(deals.length>1?{paging:{next:{after:'next'}}}:{})}:{results:deals.slice(1)};
    }
    const assoc=/^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/contacts$/.exec(u.pathname);
    if(assoc)return options.multipleContacts?{results:[{toObjectId:assoc[1]},{toObjectId:'999'}]}:{results:[{toObjectId:assoc[1]}]};
    const deal=/^\/crm\/v3\/objects\/deals\/(\d+)$/.exec(u.pathname);
    if(deal)return options.changedDeal ?? deals.find(d=>d.id===deal[1])!;
    const contact=/^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(u.pathname);
    if(contact){if(options.failContact===contact[1])throw Error('Contact read unavailable');return {id:contact[1],properties:{email:`person${contact[1]}@example.net`,firstname:`Person ${contact[1]}`,company:`Company ${contact[1]}`}};}
    if(u.pathname==='/gmail/v1/users/me/threads') {
      const address=/from:"([^"]+)"/.exec(u.searchParams.get('q') ?? '')?.[1];
      if(options.pageTwoReply&&!u.searchParams.get('pageToken'))return {threads:[],nextPageToken:'next'};
      return {threads:options.replied?.includes(address!)?[{id:'abc'}]:[]};
    }
    if(u.pathname==='/gmail/v1/users/me/threads/abc')return {id:'abc',messages:[{id:'abcd',internalDate:String(salesFixtureNow-60_000),labelIds:['INBOX'],payload:{headers:[{name:'From',value:options.badSender?'Malformed':options.replied?.[0]}]}}]};
    if(path==='/gmail/v1/users/me/drafts'&&body) {
      options.drafts?.push(body);if(options.unknownDraft)throw Error('Reply lost after dispatch');return {id:'draft-'+(options.drafts?.length ?? 1),message:{id:'123abc'}};
    }
    throw Error('Unexpected fixture request '+provider+' '+path);
  };
}
