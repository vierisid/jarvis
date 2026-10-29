import type {ReportRequest,ReportSetup} from './weekly-report';
export const reportFixtureNow=Date.parse('2026-10-26T09:00:00Z');
export const reportFixtureSetup:ReportSetup={stripeConnection:'fixture-stripe',hubspotConnection:'fixture-hubspot',googleConnection:'fixture-google',stripeAccountId:'acct_fixture',stripeMode:'test',stripeDateBasis:'balance_posted',hubspotPortalId:'42',dealDateProperty:'closedate',dealStageIds:['won'],googleEmail:'owner@example.com',folderId:'folder',timezone:'Europe/Rome'};
export interface ReportFixtureOptions {calls?:string[];writes?:any[];failStripe?:boolean;failHubspot?:boolean;cycle?:boolean;unknownCreate?:boolean;badContent?:boolean;modeMismatch?:boolean;overlap?:boolean;missingAmount?:boolean;companyCurrency?:string;empty?:boolean;refundStatus?:(n:number)=>string;deals?:any[];searches?:any[];mutate?: (provider:string,path:string,result:any)=>any}
export function reportFixtureRequest(options:ReportFixtureOptions={}):ReportRequest {
  const docs=new Map<string,any>();let created=0;
  const base:ReportRequest=async(provider,path,body)=>{
    options.calls?.push(`${provider} ${body?'POST':'GET'} ${path}`);const u=new URL('https://fixture.invalid'+path);
    if(provider==='stripe'){
      if(options.failStripe)throw Error('Fixture Stripe unavailable');
      if(u.pathname==='/v1/account')return {id:'acct_fixture'};
      if(u.pathname==='/v1/balance')return {livemode:!!options.modeMismatch};
      if(u.pathname==='/v1/balance_transactions'){
        const type=u.searchParams.get('type'),start=Number(u.searchParams.get('created[gte]')),cursor=u.searchParams.get('starting_after');
        if(options.empty||['payment','payment_refund'].includes(type!))return {data:[],has_more:false};
        const row=(n:number)=>({id:`txn_${type}_${start}_${n}`,type,created:start+n,currency:n===3?'jpy':'eur',amount:(type==='refund'?-1:1)*(n===3?5:n*100),source:type==='refund'?{id:'re_'+n,object:'refund',status:options.refundStatus?options.refundStatus(n):'succeeded'}:{id:'ch_'+n,object:'charge',status:'succeeded',captured:true,paid:true}});
        if(options.cycle)return {data:[row(1)],has_more:true};
        return cursor?{data:options.overlap?[row(1),row(2),row(3)]:[row(2),row(3)],has_more:false}:{data:[row(1)],has_more:true};
      }
    }
    if(provider==='hubspot'){
      if(options.failHubspot)throw Error('Fixture HubSpot unavailable');
      if(u.pathname==='/account-info/v3/details')return {portalId:42,...options.companyCurrency?{companyCurrency:options.companyCurrency}:{}};
      if(u.pathname==='/crm/v3/properties/deals/closedate')return {name:'closedate',type:'datetime'};
      if(u.pathname==='/crm/v3/pipelines/deals')return {results:[{stages:[{id:'won'}]}]};
      // CRM search: stage IN, date GTE/LT, ascending hs_object_id, offset paging capped at 10,000 results.
      if(u.pathname==='/crm/v3/objects/deals/search'&&body){
        options.searches?.push(body);const [stage,from,to]=body.filterGroups[0].filters,offset=Number(body.after??0);
        if(offset+body.limit>10000)throw Error('Fixture HubSpot search cap exceeded (HTTP 400)');
        const row=(id:string,date:string,amount:string,dealstage='won')=>({id,properties:{dealstage,closedate:date,amount:options.missingAmount?null:amount,deal_currency_code:'EUR'}});
        const deals=options.empty?[]:options.deals??[row('1','2026-10-22T10:00:00Z','123.456789'),row('2','2026-10-15T10:00:00Z','0'),row('3','2026-10-22T11:00:00Z','999','lost'),row('4','2026-10-26T10:00:00Z','999')];
        const all=deals.filter(d=>{const t=Date.parse(d.properties[from.propertyName]);return stage.values.includes(d.properties.dealstage)&&t>=Number(from.value)&&t<Number(to.value);}).sort((a,b)=>Number(a.id)-Number(b.id));
        const results=all.slice(offset,offset+body.limit);
        return {total:all.length,results,...offset+results.length<all.length?{paging:{next:{after:String(offset+results.length)}}}:{}};
      }
    }
    if(provider==='google'){
      if(u.pathname==='/drive/v3/about')return {user:{emailAddress:'owner@example.com'}};
      if(u.pathname==='/drive/v3/files/folder')return {id:'folder',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};
      // The recovery search: Docs carrying the report key the create stored on them.
      if(u.pathname==='/drive/v3/files'&&!body){const key=/value='([^']+)'/.exec(u.searchParams.get('q')??'')?.[1];return {files:[...docs.values()].filter(d=>d.meta.appProperties?.jarvisReport===key).map(d=>d.meta)};}
      if(u.pathname==='/drive/v3/files'&&body){const id='doc'+ ++created,meta={id,...body};docs.set(id,{meta,text:''});options.writes?.push({path,body});if(options.unknownCreate)throw Error('Lost creation reply');return meta;}
      const update=/^\/v1\/documents\/(doc\d+):batchUpdate$/.exec(u.pathname);
      if(update&&body){const doc=docs.get(update[1]!);if(!doc)throw Error('Unknown fixture doc');doc.text+=body.requests[0].insertText.text;options.writes?.push({path,body});return {documentId:update[1]};}
      const read=/^\/(?:v1\/documents|drive\/v3\/files)\/(doc\d+)$/.exec(u.pathname);
      if(read){const doc=docs.get(read[1]!);if(!doc)throw Error('Missing fixture doc');return u.pathname.startsWith('/v1')?{documentId:read[1],title:doc.meta.name,body:{content:[{paragraph:{elements:[{textRun:{content:options.badContent?'wrong':doc.text+'\n'}}]}}]}}:doc.meta;}
    }
    throw Error('Unexpected fixture endpoint '+provider+' '+path);
  };
  return async(p,path,body)=>{const result=await base(p,path,body);return options.mutate?options.mutate(p,path,result):result;};
}
