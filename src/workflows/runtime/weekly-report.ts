/** Deterministic weekly reporting. Provider data is never interpreted as instructions. */
import { getCronTimezone } from '../../lib/cron-scheduler';
import { REPORT_ACCOUNTS } from '../report-accounts';
export { REPORT_PIECE, REPORT_ACTION, REPORT_ACCOUNTS, isReportStep } from '../report-accounts';
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
export interface Dataset {coverage:Coverage;totals:Record<string,{count:number;amount:string}>;excluded?:Record<string,Record<string,{count:number;amount:string}>>;
  /** HubSpot deals with no amount: kept out of totals and disclosed by count. */
  noAmount?:number}
/** Refund statuses that are reported but kept out of totals. Any other non-succeeded status makes refunds Unavailable. */
export const EXCLUDED_REFUND_STATUSES=['pending','requires_action','failed','canceled'] as const;
/** How each excluded status reads in the report: "1 pending refund", "2 refunds requiring customer action". */
const excludedLabel=(status:string,count:number)=>{const noun=`refund${count===1?'':'s'}`;return status==='requires_action'?`${count} ${noun} requiring customer action`:`${count} ${status} ${noun}`;};
/** All source reads together stop after this long, well inside the 600-second flow timeout, leaving time to save the Doc.
 * A dataset not complete by then is Unavailable with this reason instead of the run timing out without a report. */
export const SOURCE_READ_BUDGET_MS=300_000;
export const sourceBudgetText=`${SOURCE_READ_BUDGET_MS/60000}-minute source read time budget`;
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
  const items=EXCLUDED_REFUND_STATUSES.flatMap(status=>Object.entries(x[status]??{}).sort(([a],[b])=>a<b?-1:1).map(([c,t])=>`${excludedLabel(status,t.count)} (${stripeMoney(c,t.amount)})`));
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
function unavailable(d:Dataset,e:unknown){d.coverage.status='Unavailable';d.coverage.reason=errText(e);d.coverage.terminal=false;d.totals={};delete d.excluded;delete d.noAmount;}
export async function collectWeeklyReport(s:ReportSetup,source:ReportRequest,now:number,checkpoint:()=>void=()=>{},clock:()=>number=Date.now){
  const weeks=reportWeeks(now,s.timezone),datasets:Dataset[]=[],deadline=clock()+SOURCE_READ_BUDGET_MS;
  // No source request starts after the budget; whatever is still being read is Unavailable, never partial.
  const request:ReportRequest=(provider,path,body)=>{if(clock()>=deadline)throw Error(`The ${sourceBudgetText} ran out before this dataset was complete; partial totals discarded`);return source(provider,path,body);};
  const wrap=async(source:string,week:typeof weeks[number],url:string,fn:(d:Dataset)=>Promise<void>)=>{
    const d:Dataset={coverage:{source,period:week.name,status:'Complete',pages:0,unique:0,terminal:false,url},totals:{}};
    try{checkpoint();await fn(d);}catch(e){checkpoint();unavailable(d,e);}datasets.push(d);
  };
  let stripeError:unknown,hubspotError:unknown,companyCurrency:string|undefined;
  try{const a=await request('stripe','/v1/account'),b=await request('stripe','/v1/balance');if(a.id!==s.stripeAccountId||b.livemode!==(s.stripeMode==='live'))throw Error('Stripe account or live/test mode mismatch');}catch(e){checkpoint();stripeError=e;}
  try{
    const account=await request('hubspot','/account-info/v3/details');if(String(account.portalId)!==s.hubspotPortalId)throw Error('HubSpot portal mismatch');
    // A single-currency portal often leaves deal_currency_code empty: its deals are in the company currency.
    companyCurrency=typeof account.companyCurrency==='string'&&/^[a-zA-Z]{3}$/.test(account.companyCurrency)?account.companyCurrency.toUpperCase():undefined;
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
          // Only succeeded refunds count; pending, requires_action, failed and canceled ones are disclosed per currency instead.
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
      for(const r of rows.values()){
        const code=r.properties.deal_currency_code,amount=r.properties.amount;
        // Never assumed: with neither a deal currency nor a known portal company currency the week is Unavailable.
        const c=code==null||code===''?companyCurrency??(()=>{throw Error('Deal currency missing and the HubSpot company currency is unknown');})():currency(code);
        // A deal with no amount is not zero: it is kept out of totals and disclosed by count.
        if(amount==null||amount===''){d.noAmount=(d.noAmount??0)+1;continue;}
        add(d.totals,c,decimal(amount));
      }
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
    `Stripe account ${s.stripeAccountId}, mode ${s.stripeMode}. Basis: balance transaction posting date, NOT PaymentIntent creation, capture timestamp or payout availability. Successful captured charge/payment and succeeded refund/payment_refund ledger entries only; pending, requiring customer action (requires_action), failed and canceled refunds are excluded from totals and listed per currency, and any other refund status makes refunds Unavailable; gross before Stripe fees, in Stripe BALANCE currency. Conversion may already have occurred in Stripe. Disputes, transfers, fees, refund reversals and other ledger types excluded.`,
    `HubSpot portal ${s.hubspotPortalId}: current nonarchived deals in selected stages ${s.dealStageIds.join(',')}, dated by ${s.dealDateProperty}. This is current record state, not a historical pipeline snapshot. Amounts use original deal_currency_code, or the portal company currency for a deal with none; deals with no amount are excluded from totals and counted. Deals come from HubSpot CRM search filtered to each week and read twice; a window that could reach the ${HUBSPOT_SEARCH_CAP}-result search cap is split, and more than ${HUBSPOT_DEAL_LIMIT} matching deals or ${HUBSPOT_SEARCH_REQUESTS} search requests per read marks the week Unavailable.`,
    `All Stripe and HubSpot reads together stop at a ${sourceBudgetText}; any dataset not complete by then is Unavailable. On a large account this budget is reached before the per-read page and request limits.`,
    'No FX or cross-source totals. Currency amounts are decimal strings, computed with exact scaled integers. Missing data is never zero. Complete empty datasets establish zero activity. Percentage N/A for zero/negative baselines as labelled.',
    '\nSOURCE COVERAGE',...datasets.map(({coverage:c})=>`${c.source} | ${c.period} | ${c.status}${c.reason?': '+c.reason:''} | pages ${c.pages}, unique records ${c.unique}, end confirmed ${c.terminal}. Source: ${c.url}`),
    '\nTOTALS BY SOURCE, PERIOD AND CURRENCY',...datasets.flatMap(d=>d.coverage.status==='Unavailable'?[`${d.coverage.source} | ${d.coverage.period} | Unavailable: ${d.coverage.reason}`]:[...Object.keys(d.totals).length?Object.entries(d.totals).map(([c,t])=>`${d.coverage.source} | ${d.coverage.period} | ${c} | count ${t.count} | amount ${t.amount}`):[`${d.coverage.source} | ${d.coverage.period} | 0 records; no currency inferred`],
      ...d.excluded?[`${d.coverage.source} | ${d.coverage.period} | Excluded from totals: ${excludedRefundsText(d.excluded)}`]:[],
      ...d.noAmount?[`${d.coverage.source} | ${d.coverage.period} | Excluded from totals: ${d.noAmount} deal${d.noAmount===1?'':'s'} with no amount not included`]:[]]),
    '\nWEEK-OVER-WEEK COMPARISONS',...comparisons.map(c=>c.reason?`${c.source}: ${c.reason}`:c.note?`${c.source}: ${c.note}`:`${c.source} | ${c.currency} | current ${c.current.amount} (${c.current.count} records) | prior ${c.prior.amount} (${c.prior.count} records) | amount delta ${c.amountChange.delta} | ${c.amountChange.percentage===null?c.amountChange.label:c.amountChange.percentage+'%'} | count delta ${c.countChange.delta} | ${c.countChange.percentage===null?c.countChange.label:c.countChange.percentage+'%'}`)].join('\n');
  if(content.length>150000)throw Error('Report exceeds document limit');
  return {title,content,weeks,datasets,comparisons,partial:datasets.some(d=>d.coverage.status==='Unavailable')};
}
/** One weekly receipt slot as stored: a claim, the Doc it created when known, and the saved result once verified. */
export interface ReceiptRow {state:'none'|'pending'|'complete';documentId?:string;result?:Obj}
export interface ReportReceipt {
  /** Read-only. */
  peek(key:string):ReceiptRow;
  claim(key:string):{state:'new'|'pending'|'complete';documentId?:string;result?:Obj};
  created(key:string,id:string):void;
  /** Takes over a pending claim whose create reply was lost, recording the Doc that Drive shows it created. */
  adopt(key:string,id:string):void;
  finish(key:string,result:Obj):void;
  release(key:string):void;
}
export const reportDocUrl=(id:string)=>`https://docs.google.com/document/d/${id}/edit`;
/** The one replacement a partial report allows in its week. */
export const replacementKey=(key:string)=>`${key}:replacement`;
export type WeekPlan={state:'closed';result:Obj}|{state:'pending';key:string;documentId?:string}|{state:'open';key:string};
/**
 * Read-only: what the week's receipts allow, before any source is read. A
 * complete report closes the week. A partial one leaves room for exactly one
 * replacement, which closes the week whether or not it is itself complete.
 */
export function weekPlan(receipt:Pick<ReportReceipt,'peek'>,key:string):WeekPlan {
  const second=receipt.peek(replacementKey(key));
  if(second.state==='complete')return {state:'closed',result:second.result!};
  if(second.state==='pending')return {state:'pending',key:replacementKey(key),documentId:second.documentId};
  const first=receipt.peek(key);
  if(first.state==='pending')return {state:'pending',key,documentId:first.documentId};
  if(first.state==='none')return {state:'open',key};
  return first.result?.partial===true?{state:'open',key:replacementKey(key)}:{state:'closed',result:first.result!};
}
/** The fenced-attempt error, naming the Doc whenever it is known. */
export function unresolvedReportError(documentId?:string,found?:string[]):Error {
  const where=documentId?` (Doc ${documentId}, ${reportDocUrl(documentId)})`:found?.length?` (Drive shows ${found.length} documents carrying this report's key: ${found.join(', ')})`:' (Drive shows no document carrying this report\'s key yet)';
  return Error(`Report creation is unresolved. Review the recorded attempt${where}; no duplicate document was created.`);
}
/** The one Drive search the report may run: the Doc a lost create reply made, by the key it stored on it. */
export function reportRecoveryPath(key:string):string {
  if(!/^[\w:-]{1,200}$/.test(key))throw Error('Invalid report key');
  return '/drive/v3/files?'+query({q:`appProperties has { key='jarvisReport' and value='${key}' } and trashed=false`,fields:'files(id,name,mimeType,parents,trashed,appProperties)',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
}
/** Failures known to have happened before a request reached the provider, or that the provider rejected outright. */
const notSent=new WeakSet<object>();
const markNotSent=(e:unknown)=>{const error=e instanceof Error?e:Error(String(e));notSent.add(error);return error;};
export const reportRequestNotSent=(e:unknown)=>typeof e==='object'&&e!==null&&notSent.has(e);
const textOf=(doc:Obj)=>(doc.body?.content??[]).flatMap((p:Obj)=>p.paragraph?.elements??[]).map((e:Obj)=>e.textRun?.content??'').join('');
type Report=Awaited<ReturnType<typeof collectWeeklyReport>>;
/** The title and content one slot writes: a replacement names the partial report it replaces, and every partial report says what it leaves open. */
function slotReport(report:Report,replaces?:{documentId:string;documentUrl:string}):Report {
  const title=replaces?`${report.title} (replacement)`:report.title;
  const notes=replaces?[`This report replaces the earlier partial report for this week: ${replaces.documentUrl} (Doc ${replaces.documentId}).`,
      ...report.partial?['This replacement is also partial. The week is now closed: Jarvis will not create another report for it.']:[]]
    :report.partial?['This report is partial. A later run this week may create one replacement report; this document is not changed.']:[];
  const content=[title,...notes,report.content.slice(report.content.indexOf('\n')+1)].join('\n');
  if(content.length>150000)throw Error('Report exceeds document limit');
  return {...report,title,content};
}
/** A pending claim with no recorded Doc: the Doc its lost create reply made, adopted when Drive shows exactly one, still empty. */
async function recoverDocument(s:ReportSetup,request:ReportRequest,receipt:ReportReceipt,key:string,title:string):Promise<string> {
  const found=await request('google',reportRecoveryPath(key));
  if(!Array.isArray(found.files))throw Error('Malformed Drive search result');
  const files=found.files.filter((f:Obj)=>f?.appProperties?.jarvisReport===key);
  if(files.length!==1)throw unresolvedReportError(undefined,files.map((f:Obj)=>String(f.id)));
  const f=files[0];if(typeof f.id!=='string'||!/^[\w-]+$/.test(f.id))throw Error('Drive returned an invalid document ID');
  receipt.adopt(key,f.id);
  const doc=await request('google',`/v1/documents/${f.id}`);
  if(f.trashed||f.mimeType!=='application/vnd.google-apps.document'||!f.parents?.includes(s.folderId)||f.name!==title||doc.documentId!==f.id||!['','\n'].includes(textOf(doc)))throw unresolvedReportError(f.id);
  return f.id;
}
/**
 * Creates and verifies the week's report Doc in the slot `weekPlan` allows
 * (`key` is the week's key), or returns the result that closed the week.
 */
export async function saveWeeklyReport(s:ReportSetup,report:Report,request:ReportRequest,receipt:ReportReceipt,key:string){
  const profile=await request('google','/drive/v3/about?fields=user(emailAddress)');if(profile.user?.emailAddress?.toLowerCase()!==s.googleEmail)throw Error('Selected Google account does not match configured email');
  const folder=await request('google',`/drive/v3/files/${s.folderId}?fields=id,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
  if(folder.id!==s.folderId||folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder'||folder.capabilities?.canAddChildren!==true)throw Error('Selected report folder is unavailable or not writable');
  const plan=weekPlan(receipt,key);if(plan.state==='closed')return plan.result;
  const slot=plan.key,first=slot===key?undefined:receipt.peek(key).result;
  const replaces=first?{documentId:String(first.documentId),documentUrl:String(first.documentUrl)}:undefined,final=slotReport(report,replaces);
  let id:string;
  if(plan.state==='pending'){
    if(plan.documentId)throw unresolvedReportError(plan.documentId);
    id=await recoverDocument(s,request,receipt,slot,final.title);
  }else{
    const claim=receipt.claim(slot);
    if(claim.state==='complete')return claim.result!;
    if(claim.state==='pending')throw unresolvedReportError(claim.documentId);
    let file:Obj;
    try{file=await request('google','/drive/v3/files?fields=id,name,mimeType,parents&supportsAllDrives=true',{name:final.title,mimeType:'application/vnd.google-apps.document',parents:[s.folderId],appProperties:{jarvisReport:slot}});}
    // A create that certainly never happened must not fence the week; an uncertain one stays fenced for review.
    catch(e){if(reportRequestNotSent(e))receipt.release(slot);throw e;}
    if(typeof file.id!=='string'||! /^[\w-]+$/.test(file.id))throw Error('Document creation did not confirm its ID');receipt.created(slot,file.id);id=file.id;
  }
  await request('google',`/v1/documents/${id}:batchUpdate`,{requests:[{insertText:{location:{index:1},text:final.content}}]});
  const doc=await request('google',`/v1/documents/${id}`),meta=await request('google',`/drive/v3/files/${id}?fields=id,name,mimeType,parents,trashed&supportsAllDrives=true`);
  const text=textOf(doc);
  if(doc.documentId!==id||doc.title!==final.title||meta.name!==final.title||meta.trashed||meta.mimeType!=='application/vnd.google-apps.document'||!meta.parents?.includes(s.folderId)||(text!==final.content&&text!==final.content+'\n'))throw Error('Saved Google Doc content/title/destination could not be verified');
  // documentVerified: the Doc was saved and read back. partial: some dataset was Unavailable. weekClosed: no later run this week creates another Doc.
  const result={documentVerified:true,weekClosed:!final.partial||replaces!==undefined,...replaces?{replaces}:{},documentId:id,documentUrl:reportDocUrl(id),folderId:s.folderId,...final};
  receipt.finish(slot,result);return result;
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
/** HubSpot limits search per account, so another run can take the shared allowance. A 429 is retried this many times,
 * waiting Retry-After (or 1 second) when that is at most the maximum wait; a longer wait fails the request. */
export const HUBSPOT_429_RETRIES=2,HUBSPOT_RETRY_MAX_WAIT_MS=5000,HUBSPOT_RETRY_DEFAULT_WAIT_MS=1000;
export function retryAfterMs(header:string|null,now:number=Date.now()):number|null {
  if(header==null||!header.trim())return HUBSPOT_RETRY_DEFAULT_WAIT_MS;
  const v=header.trim(),ms=/^\d{1,6}$/.test(v)?Number(v)*1000:Number.isFinite(Date.parse(v))?Math.max(0,Date.parse(v)-now):NaN;
  return Number.isFinite(ms)&&ms<=HUBSPOT_RETRY_MAX_WAIT_MS?ms:null;
}
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export function reportTransport(tokens:Record<ReportProvider,string>,checkpoint:()=>void,fetchImpl:typeof fetch=fetch,searchIntervalMs=250,sleep:(ms:number)=>Promise<void>=delay):ReportRequest {
  const created=new Set<string>(),written=new Set<string>();let lastSearch=0;
  return async(provider,path,body)=>{
    const u=new URL('https://placeholder.invalid'+path);if(!path.startsWith('/')||path.startsWith('//')||u.hash)throw Error('Invalid report endpoint');
    const read=provider==='stripe'?['/v1/account','/v1/balance','/v1/balance_transactions'].includes(u.pathname):provider==='hubspot'?u.pathname==='/account-info/v3/details'||u.pathname==='/crm/v3/pipelines/deals'||/^\/crm\/v3\/properties\/deals\/\w+$/.test(u.pathname):u.pathname==='/drive/v3/about'||/^\/drive\/v3\/files\/[\w-]+$/.test(u.pathname)||/^\/v1\/documents\/[\w-]+$/.test(u.pathname);
    const create=provider==='google'&&u.pathname==='/drive/v3/files'&&body&&Object.keys(body).sort().join()==='appProperties,mimeType,name,parents'&&body.mimeType==='application/vnd.google-apps.document'&&typeof body.name==='string'&&Array.isArray(body.parents)&&body.parents.length===1;
    const update=/^\/v1\/documents\/([\w-]+):batchUpdate$/.exec(u.pathname),id=update?.[1];
    const insert=provider==='google'&&id&&created.has(id)&&!written.has(id)&&body&&Object.keys(body).join()==='requests'&&body.requests?.length===1&&Object.keys(body.requests[0]).join()==='insertText'&&Object.keys(body.requests[0].insertText).sort().join()==='location,text'&&JSON.stringify(body.requests[0].insertText.location)==='{"index":1}'&&typeof body.requests[0].insertText.text==='string';
    const search=provider==='hubspot'&&u.pathname===HUBSPOT_SEARCH_PATH&&!u.search&&validSearchBody(body);
    // Exactly the Drive search for the Doc a lost create reply made, by the key the report stored on it.
    const recoverKey=/^appProperties has \{ key='jarvisReport' and value='([\w:-]{1,200})' \} and trashed=false$/.exec(u.searchParams.get('q')??'')?.[1];
    const recover=provider==='google'&&!body&&u.pathname==='/drive/v3/files'&&recoverKey!==undefined&&path===reportRecoveryPath(recoverKey);
    if(!(read&&!body)&&!create&&!insert&&!search&&!recover)throw markNotSent(Error('Report operation is outside the read/create-new-document scope'));
    try{checkpoint();}catch(e){throw markNotSent(e);}if(insert)written.add(id!);
    // HubSpot limits search to a few requests per second per token.
    const pace=async()=>{if(!search)return;const wait=lastSearch+searchIntervalMs-Date.now();if(wait>0){await sleep(wait);try{checkpoint();}catch(e){throw markNotSent(e);}}lastSearch=Date.now();};
    const host=provider==='stripe'?'https://api.stripe.com':provider==='hubspot'?'https://api.hubapi.com':u.pathname.startsWith('/v1/documents')?'https://docs.googleapis.com':'https://www.googleapis.com';
    let response:Response;
    for(let attempt=0;;attempt++){
      await pace();
      response=await fetchImpl(host+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${tokens[provider]}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
      // HubSpot reads and searches change nothing, so a rate-limited one is safe to repeat after a short wait.
      const wait=provider==='hubspot'&&response.status===429&&attempt<HUBSPOT_429_RETRIES?retryAfterMs(response.headers.get('retry-after')):null;
      if(wait===null)break;
      await response.body?.cancel();await sleep(wait);try{checkpoint();}catch(e){throw markNotSent(e);}
    }
    if(!response.ok){await response.body?.cancel();const e=Error(`${provider} request failed (HTTP ${response.status})`);throw response.status>=400&&response.status<500?markNotSent(e):e;}
    const reader=response.body?.getReader();if(!reader)throw Error('Empty source response');let size=0;const chunks:Uint8Array[]=[];
    for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>4_000_000){await reader.cancel();throw Error('Source response exceeds completeness limit');}chunks.push(n.value);}
    checkpoint();const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data)||data.error)throw Error('Malformed provider response');
    if(create&&typeof data.id==='string')created.add(data.id);
    // A recovered Doc may take the single insert a new one would, once.
    if(recover&&Array.isArray(data.files))for(const f of data.files)if(f?.appProperties?.jarvisReport===recoverKey&&typeof f.id==='string'&&f.mimeType==='application/vnd.google-apps.document')created.add(f.id);
    return data;
  };
}
