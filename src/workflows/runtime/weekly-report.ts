/** Deterministic weekly reporting. Provider data is never interpreted as instructions. */
import { getCronTimezone } from '../../lib/cron-scheduler';
export const REPORT_PIECE = '@jarvispieces/piece-jarvis-report';
export const REPORT_ACTION = 'weekly_operating_report';
export const REPORT_ACCOUNTS = {stripeConnection:'@activepieces/piece-stripe',hubspotConnection:'@activepieces/piece-hubspot',googleConnection:'@activepieces/piece-google-docs'} as const;
export const REPORT_REQUIRED = [...Object.keys(REPORT_ACCOUNTS),'stripeAccountId','stripeMode','stripeDateBasis','hubspotPortalId','dealDateProperty','dealStageIds','googleEmail','folderId'] as const;
type Obj = Record<string,any>;
export interface ReportSetup {stripeConnection:string;hubspotConnection:string;googleConnection:string;stripeAccountId:string;stripeMode:'live'|'test';stripeDateBasis:'balance_posted';hubspotPortalId:string;dealDateProperty:string;dealStageIds:string[];googleEmail:string;folderId:string;timezone:string}
export type ReportProvider = 'stripe'|'hubspot'|'google';
export type ReportRequest = (provider:ReportProvider,path:string,body?:Obj)=>Promise<Obj>;
const required=(v:unknown,name:string,pattern:RegExp)=>{if(typeof v!=='string'||v.length>300||!pattern.test(v))throw Error(`Configure ${name}`);return v;};
export function reportSetup(v:Obj):ReportSetup {
  const accounts=Object.fromEntries(Object.keys(REPORT_ACCOUNTS).map(k=>[k,required(v[k],k,/^[\w:-]+$/)]));
  if(!['live','test'].includes(v.stripeMode))throw Error('Select Stripe live or test mode');
  if(v.stripeDateBasis!=='balance_posted')throw Error('Select Stripe balance-posted reporting basis; capture/PaymentIntent dates are not substituted');
  const stages=typeof v.dealStageIds==='string'?v.dealStageIds.split(',').map((s:string)=>s.trim()):v.dealStageIds;
  if(!Array.isArray(stages)||!stages.length||stages.length>100)throw Error('Select deal stages explicitly');
  // Empty means the zone Jarvis's own schedules use: the configured timezone, else this machine's zone.
  const configured=v.timezone==null||(typeof v.timezone==='string'&&!v.timezone.trim());
  const timezone=configured?getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone:v.timezone;
  if(typeof timezone!=='string'||timezone.length>100)throw Error('Configure timezone');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw Error('Configure a valid IANA timezone');}
  return {...accounts,stripeAccountId:required(v.stripeAccountId,'Stripe account ID',/^acct_[a-zA-Z0-9]+$/),stripeMode:v.stripeMode,stripeDateBasis:v.stripeDateBasis,
    hubspotPortalId:required(v.hubspotPortalId,'HubSpot portal ID',/^\d+$/),dealDateProperty:required(v.dealDateProperty,'deal date property',/^[a-zA-Z][a-zA-Z0-9_]*$/),dealStageIds:[...new Set(stages.map(s=>required(s,'deal stage',/^\w+$/)))],
    googleEmail:required(v.googleEmail,'Google account email',/^[^\s@]+@[^\s@]+\.[^\s@]+$/).toLowerCase(),folderId:required(v.folderId,'destination folder ID',/^[a-zA-Z0-9_-]+$/),timezone} as ReportSetup;
}
function parts(t:number,timezone:string){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(t).map(p=>[p.type,p.value]));}
/** The first instant of a local civil day: the earliest of an ambiguous midnight, or the transition when midnight is skipped by DST. */
export function localMidnight(civil:number,timezone:string):number {
  const wall=(t:number)=>{const p=parts(t,timezone);return Date.UTC(+p.year!,+p.month!-1,+p.day!,+p.hour!,+p.minute!,+p.second!);};
  const candidates=[...new Set([-36,0,36].map(h=>{const t=civil+h*3600_000;return civil-(wall(t)-t);}))].sort((a,b)=>a-b);
  const exact=candidates.find(t=>wall(t)===civil);if(exact!==undefined)return exact;
  let lo=candidates[0]!,hi=candidates.at(-1)!;
  if(wall(lo)>=civil||wall(hi)<civil)throw Error(`Cannot resolve local midnight in ${timezone}`);
  while(hi-lo>1000){const mid=lo+Math.floor((hi-lo)/2000)*1000;if(wall(mid)>=civil)hi=mid;else lo=mid;}
  return hi;
}
export function reportWeeks(now:number,timezone:string){
  const p=parts(now,timezone),day=Date.UTC(+p.year!,+p.month!-1,+p.day!),monday=day-((new Date(day).getUTCDay()+6)%7)*86400_000;
  return [1,2].map(n=>({name:n===1?'current':'prior',start:localMidnight(monday-n*7*86400_000,timezone),end:localMidnight(monday-(n-1)*7*86400_000,timezone),localStart:new Date(monday-n*7*86400_000).toISOString().slice(0,10),localEnd:new Date(monday-(n-1)*7*86400_000).toISOString().slice(0,10)}));
}
const query=(v:Record<string,string>)=>new URLSearchParams(v).toString();
export interface Coverage {source:string;period:string;status:'Complete'|'Unavailable';pages:number;unique:number;reason?:string;terminal:boolean;url:string}
export interface Dataset {coverage:Coverage;totals:Record<string,{count:number;amount:string}>;excluded?:Record<string,Record<string,{count:number;amount:string}>>}
/** Refund statuses that are reported but kept out of totals. Any other non-succeeded status makes refunds Unavailable. */
export const EXCLUDED_REFUND_STATUSES=['pending','failed','canceled'] as const;
const errText=(e:unknown)=>String((e as Error).message).replace(/[\x00-\x1f]/g,' ').slice(0,250);
const SCALE=1000000n;
export function decimal(v:unknown):bigint {
  if(typeof v!=='string'||! /^-?\d{1,18}(?:\.\d{1,6})?$/.test(v))throw Error('Missing or invalid exact decimal amount');
  const [whole,fraction='']=v.replace('-','').split('.');const n=BigInt(whole!)*SCALE+BigInt(fraction.padEnd(6,'0'));return v.startsWith('-')?-n:n;
}
export function formatAmount(v:bigint){const n=v<0n?-v:v;return (v<0n?'-':'')+(n/SCALE)+((n%SCALE)?'.'+String(n%SCALE).padStart(6,'0').replace(/0+$/,''):'');}
export function comparison(current:bigint,prior:bigint){
  const delta=formatAmount(current-prior);
  if(prior===0n)return {delta,percentage:null,label:current===0n?'No change; both zero':'New activity; percentage not defined'};
  if(prior<0n)return {delta,percentage:null,label:'Percentage N/A: negative prior baseline'};
  const bps=(current-prior)*10000n/prior;
  return {delta,percentage:formatAmount(bps*10000n),label:'Percentage rounded toward zero to two decimals'};
}
function currency(v:unknown):string {if(typeof v!=='string'||! /^[a-zA-Z]{3}$/.test(v))throw Error('Missing currency');return v.toUpperCase();}
function stripeExponent(c:string):number {
  // Stripe charge accounting units differ from ISO for ISK and UGX. Never infer an FX conversion.
  const zero=new Set('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF'.split(' '));
  const three=new Set('BHD JOD KWD OMR TND'.split(' '));
  if(!(Intl.supportedValuesOf('currency') as string[]).includes(c))throw Error('Unknown currency exponent');
  return zero.has(c)?0:three.has(c)?3:2;
}
function stripeAmount(v:unknown,c:string):bigint {
  if(!Number.isSafeInteger(v))throw Error('Invalid Stripe minor-unit integer');
  return BigInt(v as number)*10n**BigInt(6-stripeExponent(c));
}
/** A Stripe amount with its currency's minor-unit digits, e.g. EUR 40.00. */
function stripeMoney(c:string,amount:string):string {
  const e=stripeExponent(c),v=decimal(amount),n=v<0n?-v:v,unit=10n**BigInt(6-e),minor=n/unit,base=10n**BigInt(e);
  return `${c} ${v<0n?'-':''}${minor/base}${e?'.'+String(minor%base).padStart(e,'0'):''}`;
}
/** "2 pending refunds (EUR 40.00) and 1 failed refund (USD 5.00) not included" */
export function excludedRefundsText(x:NonNullable<Dataset['excluded']>):string {
  const items=EXCLUDED_REFUND_STATUSES.flatMap(status=>Object.entries(x[status]??{}).sort(([a],[b])=>a<b?-1:1).map(([c,t])=>`${t.count} ${status} refund${t.count===1?'':'s'} (${stripeMoney(c,t.amount)})`));
  return items.length?(items.length>1?items.slice(0,-1).join(', ')+' and '+items.at(-1):items[0])+' not included':'';
}
function add(t:Dataset['totals'],c:string,amount:bigint){const old=t[c]??{count:0,amount:'0'};t[c]={count:old.count+1,amount:formatAmount(decimal(old.amount)+amount)};}
async function pages(request:ReportRequest,path:string,coverage:Coverage):Promise<Obj[]> {
  const rows=new Map<string,Obj>(),cursors=new Set<string>(),previousUnique=coverage.unique;let cursor:string|undefined;
  for(let page=0;page<200;page++){
    const data=await request('stripe',path+(cursor?'&'+query({starting_after:cursor}):''));coverage.pages++;
    const batch=data.data;if(!Array.isArray(batch))throw Error('Malformed result page');
    for(const r of batch){if(!r||typeof r.id!=='string'||!r.id)throw Error('Missing stable record ID');const old=rows.get(r.id);if(old&&JSON.stringify(old)!==JSON.stringify(r))throw Error('Record changed during pagination');rows.set(r.id,r);}
    coverage.unique=previousUnique+rows.size;if(rows.size>20000)throw Error('Row limit reached; partial totals discarded');
    if(typeof data.has_more!=='boolean')throw Error('Stripe terminal-page evidence missing');
    const next=data.has_more?batch.at(-1)?.id:undefined;
    if(data.has_more&&!next)throw Error('Empty continuation page');
    if(next==null){coverage.terminal=true;return [...rows.values()];}
    if(typeof next!=='string'||cursors.has(next))throw Error('Repeated or invalid cursor');
    cursor=next;cursors.add(cursor);
  }
  throw Error('Page limit reached; partial totals discarded');
}
/** HubSpot CRM search returns at most 10,000 results per query, 200 per page. */
export const HUBSPOT_SEARCH_CAP=10000,HUBSPOT_SEARCH_PAGE=200;
/** Per week and read: at most this many matching deals and search requests; reaching either is Unavailable. */
export const HUBSPOT_DEAL_LIMIT=50000,HUBSPOT_SEARCH_REQUESTS=1000;
export const HUBSPOT_SEARCH_PATH='/crm/v3/objects/deals/search';
const HUBSPOT_SORTS=[{propertyName:'hs_object_id',direction:'ASCENDING'}];
export function hubspotSearchBody(s:ReportSetup,start:number,end:number,after?:string):Obj {
  return {filterGroups:[{filters:[{propertyName:'dealstage',operator:'IN',values:s.dealStageIds},{propertyName:s.dealDateProperty,operator:'GTE',value:String(start)},{propertyName:s.dealDateProperty,operator:'LT',value:String(end)}]}],
    properties:['dealstage','amount','deal_currency_code',s.dealDateProperty],sorts:HUBSPOT_SORTS,limit:HUBSPOT_SEARCH_PAGE,...(after===undefined?{}:{after})};
}
function dealTime(r:Obj,s:ReportSetup):number {
  const raw=r.properties?.[s.dealDateProperty],t=typeof raw==='string'&&/^\d{13}$/.test(raw)?Number(raw):typeof raw==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)?Date.parse(raw):NaN;
  if(!Number.isFinite(t))throw Error('Selected deal date missing or ambiguous');return t;
}
/** One search window, every page. Null means the window may exceed the search cap and must be split. */
async function searchWindow(request:ReportRequest,s:ReportSetup,start:number,end:number,coverage:Coverage,budget:{requests:number}):Promise<Map<string,Obj>|null> {
  const rows=new Map<string,Obj>();let after:string|undefined,total:number|undefined;
  for(;;){
    if(++budget.requests>HUBSPOT_SEARCH_REQUESTS)throw Error('HubSpot search request limit reached; partial totals discarded');
    const data=await request('hubspot',HUBSPOT_SEARCH_PATH,hubspotSearchBody(s,start,end,after));coverage.pages++;
    if(!Number.isSafeInteger(data.total)||data.total<0)throw Error('HubSpot search total missing');
    if(total===undefined){total=data.total as number;if(total>=HUBSPOT_SEARCH_CAP)return null;}
    else if(data.total!==total)throw Error('HubSpot search total changed during pagination');
    const batch=data.results;if(!Array.isArray(batch))throw Error('Malformed result page');
    for(const r of batch){
      if(!r||typeof r.id!=='string'||!r.id)throw Error('Missing stable record ID');
      // Offset pages over a stable sort never repeat a deal unless results shifted, which can also hide one.
      if(rows.has(r.id))throw Error('Deal repeated during pagination; results shifted');
      if(r.archived)throw Error('HubSpot search returned an archived deal');
      if(typeof r.properties?.dealstage!=='string')throw Error('Deal stage missing');
      if(!s.dealStageIds.includes(r.properties.dealstage))throw Error('HubSpot search returned a deal outside the selected stages');
      const t=dealTime(r,s);if(t<start||t>=end)throw Error('HubSpot search returned a deal outside the requested dates');
      rows.set(r.id,r);
    }
    const next=data.paging?.next?.after;
    if(data.paging?.next!=null&&next==null)throw Error('HubSpot continuation cursor missing');
    if(next==null){if(rows.size!==total)throw Error('HubSpot search returned a different number of deals than its total');return rows;}
    if(!/^\d{1,5}$/.test(String(next))||Number(next)!==rows.size)throw Error('Repeated or invalid cursor');
    after=String(next);
  }
}
/** Every matching deal in [start,end), splitting any window that may exceed the search cap; never truncates. */
async function searchDeals(request:ReportRequest,s:ReportSetup,start:number,end:number,coverage:Coverage):Promise<Map<string,Obj>> {
  const out=new Map<string,Obj>(),budget={requests:0};
  const range=async(a:number,b:number):Promise<void>=>{
    const rows=await searchWindow(request,s,a,b,coverage,budget);
    if(rows===null){
      if(b-a<2)throw Error(`More than ${HUBSPOT_SEARCH_CAP} matching HubSpot deals share one ${s.dealDateProperty} millisecond; the search window cannot be split`);
      const mid=a+Math.floor((b-a)/2);await range(a,mid);await range(mid,b);return;
    }
    for(const [id,r] of rows){if(out.has(id))throw Error('Deal changed date during the search');out.set(id,r);}
    if(out.size>HUBSPOT_DEAL_LIMIT)throw Error(`More than ${HUBSPOT_DEAL_LIMIT} matching deals in one week; partial totals discarded`);
  };
  await range(start,end);return out;
}
function unavailable(d:Dataset,e:unknown){d.coverage.status='Unavailable';d.coverage.reason=errText(e);d.coverage.terminal=false;d.totals={};delete d.excluded;}
export async function collectWeeklyReport(s:ReportSetup,request:ReportRequest,now:number,checkpoint:()=>void=()=>{}){
  const weeks=reportWeeks(now,s.timezone),datasets:Dataset[]=[];
  const wrap=async(source:string,week:typeof weeks[number],url:string,fn:(d:Dataset)=>Promise<void>)=>{
    const d:Dataset={coverage:{source,period:week.name,status:'Complete',pages:0,unique:0,terminal:false,url},totals:{}};
    try{checkpoint();await fn(d);}catch(e){checkpoint();unavailable(d,e);}datasets.push(d);
  };
  let stripeError:unknown,hubspotError:unknown;
  try{const a=await request('stripe','/v1/account'),b=await request('stripe','/v1/balance');if(a.id!==s.stripeAccountId||b.livemode!==(s.stripeMode==='live'))throw Error('Stripe account or live/test mode mismatch');}catch(e){checkpoint();stripeError=e;}
  try{
    const account=await request('hubspot','/account-info/v3/details');if(String(account.portalId)!==s.hubspotPortalId)throw Error('HubSpot portal mismatch');
    const property=await request('hubspot',`/crm/v3/properties/deals/${s.dealDateProperty}`);if(property.name!==s.dealDateProperty||property.type!=='datetime')throw Error('Select a HubSpot datetime date property');
    const pipelines=await request('hubspot','/crm/v3/pipelines/deals');const stages=pipelines.results?.flatMap((p:Obj)=>p.stages??[]);
    if(!Array.isArray(stages)||s.dealStageIds.some(id=>!stages.some((p:Obj)=>p.id===id)))throw Error('Selected deal stages unavailable');
  }catch(e){checkpoint();hubspotError=e;}
  for(const week of weeks){
    for(const source of ['payments','refunds'] as const)await wrap('stripe-'+source,week,`https://dashboard.stripe.com/${s.stripeMode==='test'?'test/':''}balance`,async d=>{
      if(stripeError)throw stripeError;
      for(const type of source==='payments'?['charge','payment']:['refund','payment_refund']){
        const rows=await pages(request,'/v1/balance_transactions?'+query({type,limit:'100','created[gte]':String(week.start/1000),'created[lt]':String(week.end/1000),'expand[]':'data.source'}),d.coverage);
        for(const r of rows){
          if(r.type!==type||!Number.isSafeInteger(r.created)||r.created*1000<week.start||r.created*1000>=week.end)throw Error('Unexpected Stripe transaction type or date');
          const src=r.source;
          if(!src||typeof src!=='object'||typeof src.id!=='string')throw Error('Expanded payment/refund evidence unavailable');
          if(source==='payments'&&(src.object!=='charge'||src.paid!==true||src.captured!==true||src.status!=='succeeded'))throw Error('Successful captured payment cannot be confirmed');
          if(source==='refunds'&&(src.object!=='refund'||src.status!=='succeeded'&&!(EXCLUDED_REFUND_STATUSES as readonly unknown[]).includes(src.status)))throw Error('Refund status cannot be confirmed');
          const c=currency(r.currency),n=stripeAmount(r.amount,c);if((source==='payments'&&n<0n)||(source==='refunds'&&n>0n))throw Error('Unexpected transaction sign');
          // Only succeeded refunds count; pending, failed and canceled ones are disclosed per currency instead.
          if(source==='refunds'&&src.status!=='succeeded'){d.excluded??={};add(d.excluded[src.status]??={},c,-n);continue;}
          add(d.totals,c,source==='refunds'?-n:n);
        }
      }
    });
    await wrap('hubspot-deals',week,`https://app.hubspot.com/contacts/${s.hubspotPortalId}/objects/0-3/views/all/list`,async d=>{
      if(hubspotError)throw hubspotError;
      // Search is filtered to this week. A second complete read must return the same deals, unchanged.
      const rows=await searchDeals(request,s,week.start,week.end,d.coverage),confirm=await searchDeals(request,s,week.start,week.end,d.coverage);
      if(confirm.size!==rows.size||[...rows].some(([id,r])=>JSON.stringify(confirm.get(id))!==JSON.stringify(r)))throw Error('Deals changed between the two complete reads; partial totals discarded');
      d.coverage.unique=rows.size;d.coverage.terminal=true;
      for(const r of rows.values())add(d.totals,currency(r.properties.deal_currency_code),decimal(r.properties.amount));
    });
  }
  const comparisons:Obj[]=[];
  for(const source of ['stripe-payments','stripe-refunds','hubspot-deals']){
    const current=datasets.find(d=>d.coverage.source===source&&d.coverage.period==='current')!,prior=datasets.find(d=>d.coverage.source===source&&d.coverage.period==='prior')!;
    if([current,prior].some(d=>d.coverage.status==='Unavailable')){comparisons.push({source,status:'Unavailable',reason:'At least one period unavailable; comparison N/A'});continue;}
    const currencies=[...new Set([...Object.keys(current.totals),...Object.keys(prior.totals)])].sort();
    if(!currencies.length)comparisons.push({source,status:'Complete',countCurrent:0,countPrior:0,note:'No activity in either complete period; no currency inferred'});
    for(const c of currencies){const a=current.totals[c]??{count:0,amount:'0'},b=prior.totals[c]??{count:0,amount:'0'};comparisons.push({source,currency:c,current:a,prior:b,amountChange:comparison(decimal(a.amount),decimal(b.amount)),countChange:comparison(BigInt(a.count)*SCALE,BigInt(b.count)*SCALE)});}
  }
  const title=`Weekly Stripe and HubSpot report | ${weeks[0]!.localStart} to ${weeks[0]!.localEnd} (end exclusive)`;
  const content=[title,`Observed at: ${new Date(now).toISOString()}`,`Reporting timezone: ${s.timezone}. Weeks are Monday 00:00 to next Monday 00:00 (exclusive).`,
    ...weeks.map(w=>`${w.name}: ${w.localStart} to ${w.localEnd}; UTC [${new Date(w.start).toISOString()}, ${new Date(w.end).toISOString()})`),
    `Stripe account ${s.stripeAccountId}, mode ${s.stripeMode}. Basis: balance transaction posting date, NOT PaymentIntent creation, capture timestamp or payout availability. Successful captured charge/payment and succeeded refund/payment_refund ledger entries only; pending, failed and canceled refunds are excluded from totals and listed per currency, and any other refund status makes refunds Unavailable; gross before Stripe fees, in Stripe BALANCE currency. Conversion may already have occurred in Stripe. Disputes, transfers, fees, refund reversals and other ledger types excluded.`,
    `HubSpot portal ${s.hubspotPortalId}: current nonarchived deals in selected stages ${s.dealStageIds.join(',')}, dated by ${s.dealDateProperty}. This is current record state, not a historical pipeline snapshot. Amounts use original deal_currency_code. Deals come from HubSpot CRM search filtered to each week and read twice; a window that could reach the ${HUBSPOT_SEARCH_CAP}-result search cap is split, and more than ${HUBSPOT_DEAL_LIMIT} matching deals or ${HUBSPOT_SEARCH_REQUESTS} search requests per read marks the week Unavailable.`,
    'No FX or cross-source totals. Currency amounts are decimal strings, computed with exact scaled integers. Missing data is never zero. Complete empty datasets establish zero activity. Percentage N/A for zero/negative baselines as labelled.',
    '\nSOURCE COVERAGE',...datasets.map(({coverage:c})=>`${c.source} | ${c.period} | ${c.status}${c.reason?': '+c.reason:''} | pages ${c.pages}, unique records ${c.unique}, end confirmed ${c.terminal}. Source: ${c.url}`),
    '\nTOTALS BY SOURCE, PERIOD AND CURRENCY',...datasets.flatMap(d=>d.coverage.status==='Unavailable'?[`${d.coverage.source} | ${d.coverage.period} | Unavailable: ${d.coverage.reason}`]:[...Object.keys(d.totals).length?Object.entries(d.totals).map(([c,t])=>`${d.coverage.source} | ${d.coverage.period} | ${c} | count ${t.count} | amount ${t.amount}`):[`${d.coverage.source} | ${d.coverage.period} | 0 records; no currency inferred`],
      ...d.excluded?[`${d.coverage.source} | ${d.coverage.period} | Excluded from totals: ${excludedRefundsText(d.excluded)}`]:[]]),
    '\nWEEK-OVER-WEEK COMPARISONS',...comparisons.map(c=>c.reason?`${c.source}: ${c.reason}`:c.note?`${c.source}: ${c.note}`:`${c.source} | ${c.currency} | current ${c.current.amount} (${c.current.count} records) | prior ${c.prior.amount} (${c.prior.count} records) | amount delta ${c.amountChange.delta} | ${c.amountChange.percentage===null?c.amountChange.label:c.amountChange.percentage+'%'} | count delta ${c.countChange.delta} | ${c.countChange.percentage===null?c.countChange.label:c.countChange.percentage+'%'}`)].join('\n');
  if(content.length>150000)throw Error('Report exceeds document limit');
  return {title,content,weeks,datasets,comparisons,partial:datasets.some(d=>d.coverage.status==='Unavailable')};
}
export interface ReportReceipt {claim(key:string):{state:'new'|'pending'|'complete';result?:Obj};created(key:string,id:string):void;finish(key:string,result:Obj):void;release(key:string):void}
/** Failures known to have happened before a request reached the provider, or that the provider rejected outright. */
const notSent=new WeakSet<object>();
const markNotSent=(e:unknown)=>{const error=e instanceof Error?e:Error(String(e));notSent.add(error);return error;};
export const reportRequestNotSent=(e:unknown)=>typeof e==='object'&&e!==null&&notSent.has(e);
export async function saveWeeklyReport(s:ReportSetup,report:Awaited<ReturnType<typeof collectWeeklyReport>>,request:ReportRequest,receipt:ReportReceipt,key:string){
  const profile=await request('google','/drive/v3/about?fields=user(emailAddress)');if(profile.user?.emailAddress?.toLowerCase()!==s.googleEmail)throw Error('Selected Google account does not match configured email');
  const folder=await request('google',`/drive/v3/files/${s.folderId}?fields=id,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
  if(folder.id!==s.folderId||folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder'||folder.capabilities?.canAddChildren!==true)throw Error('Selected report folder is unavailable or not writable');
  const claim=receipt.claim(key);if(claim.state==='complete')return claim.result!;if(claim.state==='pending')throw Error('Report creation is unresolved. Review the recorded attempt; no duplicate document was created.');
  let file:Obj;
  try{file=await request('google','/drive/v3/files?fields=id,name,mimeType,parents&supportsAllDrives=true',{name:report.title,mimeType:'application/vnd.google-apps.document',parents:[s.folderId],appProperties:{jarvisReport:key}});}
  // A create that certainly never happened must not fence the week; an uncertain one stays fenced for review.
  catch(e){if(reportRequestNotSent(e))receipt.release(key);throw e;}
  if(typeof file.id!=='string'||! /^[\w-]+$/.test(file.id))throw Error('Document creation did not confirm its ID');receipt.created(key,file.id);
  await request('google',`/v1/documents/${file.id}:batchUpdate`,{requests:[{insertText:{location:{index:1},text:report.content}}]});
  const doc=await request('google',`/v1/documents/${file.id}`),meta=await request('google',`/drive/v3/files/${file.id}?fields=id,name,mimeType,parents,trashed&supportsAllDrives=true`);
  const text=(doc.body?.content??[]).flatMap((p:Obj)=>p.paragraph?.elements??[]).map((e:Obj)=>e.textRun?.content??'').join('');
  if(doc.documentId!==file.id||doc.title!==report.title||meta.name!==report.title||meta.trashed||meta.mimeType!=='application/vnd.google-apps.document'||!meta.parents?.includes(s.folderId)||(text!==report.content&&text!==report.content+'\n'))throw Error('Saved Google Doc content/title/destination could not be verified');
  const result={complete:true,documentId:file.id,documentUrl:`https://docs.google.com/document/d/${file.id}/edit`,folderId:s.folderId,...report};receipt.finish(key,result);return result;
}

/** The report can read only declared sources, create a Doc, then insert text into that newly created ID. */
const keys=(o:unknown)=>o&&typeof o==='object'&&!Array.isArray(o)?Object.keys(o).sort().join():'';
const dateFilter=(f:Obj,operator:string)=>keys(f)==='operator,propertyName,value'&&f.operator===operator&&typeof f.value==='string'&&/^\d{1,15}$/.test(f.value);
/** Exactly the deal search the report builds: stage IN, a half-open date window, fixed sort, page size and offset. */
export function validSearchBody(b:unknown):boolean {
  if(!b||typeof b!=='object')return false;const o=b as Obj;
  if(!['filterGroups,limit,properties,sorts','after,filterGroups,limit,properties,sorts'].includes(keys(o)))return false;
  if(!Array.isArray(o.filterGroups)||o.filterGroups.length!==1||keys(o.filterGroups[0])!=='filters')return false;
  const f=o.filterGroups[0].filters;if(!Array.isArray(f)||f.length!==3)return false;
  const [stage,from,to]=f;
  if(keys(stage)!=='operator,propertyName,values'||stage.propertyName!=='dealstage'||stage.operator!=='IN'||!Array.isArray(stage.values)||!stage.values.length||stage.values.length>100||!stage.values.every((v:unknown)=>typeof v==='string'&&/^\w+$/.test(v)))return false;
  if(!dateFilter(from,'GTE')||!dateFilter(to,'LT')||from.propertyName!==to.propertyName||typeof from.propertyName!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(from.propertyName)||Number(from.value)>=Number(to.value))return false;
  if(!Array.isArray(o.properties)||!o.properties.length||o.properties.length>10||!o.properties.every((v:unknown)=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_]*$/.test(v)))return false;
  if(JSON.stringify(o.sorts)!==JSON.stringify(HUBSPOT_SORTS)||!Number.isSafeInteger(o.limit)||o.limit<1||o.limit>HUBSPOT_SEARCH_PAGE)return false;
  return o.after===undefined||typeof o.after==='string'&&/^\d{1,5}$/.test(o.after)&&Number(o.after)+o.limit<=HUBSPOT_SEARCH_CAP;
}
export function reportTransport(tokens:Record<ReportProvider,string>,checkpoint:()=>void,fetchImpl:typeof fetch=fetch,searchIntervalMs=250):ReportRequest {
  const created=new Set<string>(),written=new Set<string>();let lastSearch=0;
  return async(provider,path,body)=>{
    const u=new URL('https://placeholder.invalid'+path);if(!path.startsWith('/')||path.startsWith('//')||u.hash)throw Error('Invalid report endpoint');
    const read=provider==='stripe'?['/v1/account','/v1/balance','/v1/balance_transactions'].includes(u.pathname):provider==='hubspot'?u.pathname==='/account-info/v3/details'||u.pathname==='/crm/v3/pipelines/deals'||/^\/crm\/v3\/properties\/deals\/\w+$/.test(u.pathname):u.pathname==='/drive/v3/about'||/^\/drive\/v3\/files\/[\w-]+$/.test(u.pathname)||/^\/v1\/documents\/[\w-]+$/.test(u.pathname);
    const create=provider==='google'&&u.pathname==='/drive/v3/files'&&body&&Object.keys(body).sort().join()==='appProperties,mimeType,name,parents'&&body.mimeType==='application/vnd.google-apps.document'&&typeof body.name==='string'&&Array.isArray(body.parents)&&body.parents.length===1;
    const update=/^\/v1\/documents\/([\w-]+):batchUpdate$/.exec(u.pathname),id=update?.[1];
    const insert=provider==='google'&&id&&created.has(id)&&!written.has(id)&&body&&Object.keys(body).join()==='requests'&&body.requests?.length===1&&Object.keys(body.requests[0]).join()==='insertText'&&Object.keys(body.requests[0].insertText).sort().join()==='location,text'&&JSON.stringify(body.requests[0].insertText.location)==='{"index":1}'&&typeof body.requests[0].insertText.text==='string';
    const search=provider==='hubspot'&&u.pathname===HUBSPOT_SEARCH_PATH&&!u.search&&validSearchBody(body);
    if(!(read&&!body)&&!create&&!insert&&!search)throw markNotSent(Error('Report operation is outside the read/create-new-document scope'));
    try{checkpoint();}catch(e){throw markNotSent(e);}if(insert)written.add(id!);
    // HubSpot limits search to a few requests per second per token.
    if(search){const wait=lastSearch+searchIntervalMs-Date.now();if(wait>0){await new Promise(r=>setTimeout(r,wait));try{checkpoint();}catch(e){throw markNotSent(e);}}lastSearch=Date.now();}
    const host=provider==='stripe'?'https://api.stripe.com':provider==='hubspot'?'https://api.hubapi.com':u.pathname.startsWith('/v1/documents')?'https://docs.googleapis.com':'https://www.googleapis.com';
    const response=await fetchImpl(host+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${tokens[provider]}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok){await response.body?.cancel();const e=Error(`${provider} request failed (HTTP ${response.status})`);throw response.status>=400&&response.status<500?markNotSent(e):e;}
    const reader=response.body?.getReader();if(!reader)throw Error('Empty source response');let size=0;const chunks:Uint8Array[]=[];
    for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>4_000_000){await reader.cancel();throw Error('Source response exceeds completeness limit');}chunks.push(n.value);}
    checkpoint();const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data)||data.error)throw Error('Malformed provider response');
    if(create&&typeof data.id==='string')created.add(data.id);return data;
  };
}
