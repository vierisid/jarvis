/** Qualified HubSpot reads and Gmail draft creation. No sending or browser surface. */
import { createHash } from 'node:crypto';
import { getCronTimezone } from '../../lib/cron-scheduler';
import { SALES_ACCOUNTS } from '../sales-accounts';
export { SALES_PIECE, SALES_ACTION, SALES_ACCOUNTS, isSalesStep } from '../sales-accounts';
export const SALES_REQUIRED = ['crmProvider','hubspotConnection','gmailConnection','ownerEmail','senderName','openStageIds','inactivityProperty','replyLookbackDays'] as const;
export interface SalesSetup {
  crmProvider: 'hubspot'; hubspotConnection: string; gmailConnection: string; ownerEmail: string; senderName: string;
  openStageIds: string[]; inactivityProperty: string; replyLookbackDays: number; inactivityDays: number; timezone: string;
}
type Obj = Record<string, any>;
export type SalesRequest = (provider: 'hubspot'|'gmail', path: string, body?: Obj) => Promise<Obj>;
export interface SalesResult { dealId: string; status: 'drafted'|'replied'|'already_processed'|'ineligible'|'review'|'unknown'; detail: string; draftId?: string }
export interface SalesLedger {
  /** Reserves once, atomically. An unfinished/uncertain claim is never released.
   * Otherwise reports what the earlier claim recorded today: a draft, a reply veto, or no draft. */
  claim(key: string): 'claimed'|'drafted'|'replied'|'no_draft'|'unresolved';
  finish(key: string, result: SalesResult): void;
  /** Frees a claim that ended in a definite failure: no draft request was sent, or Gmail definitely rejected it. */
  release(key: string): void;
}
const PRIOR: Record<string, Pick<SalesResult,'status'|'detail'>> = {
  drafted: {status:'already_processed',detail:'Contact already has a follow-up draft from today.'},
  replied: {status:'replied',detail:'Contact replied recently (checked earlier today); no draft created.'},
  no_draft: {status:'review',detail:'Contact was reviewed earlier today without a draft; not retried until tomorrow.'},
  unresolved: {status:'review',detail:'Earlier claim is unresolved; no duplicate draft dispatched.'},
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Proof that a request created nothing: refused before it left this process, or definitely rejected by the provider.
 * Any other failure of a draft request is uncertain, because Gmail may have saved the draft. */
export class SalesRequestNotApplied extends Error {}
/** A stop (governance, cancellation, binding) raised before a request left this process keeps its own error type and is only marked. */
const stoppedBeforeSend=new WeakSet<object>();
const notApplied=(error: unknown)=>error instanceof SalesRequestNotApplied||(typeof error==='object'&&error!==null&&stoppedBeforeSend.has(error));
/** 4xx answers that mean Gmail did not create the draft. 408 and 409 are excluded: the request may have been applied. */
const DEFINITE_DRAFT_REJECTIONS=new Set([400,401,403,404,422,429]);
/** HubSpot search returns at most 10,000 rows per query; this cap keeps discovery well inside it. */
export const SALES_DEAL_LIMIT=5000;
function required(v: unknown, label: string, max=512): string {
  if (typeof v !== 'string' || !v.trim() || v.length>max || /[\x00-\x1f\x7f]/.test(v)) throw Error(`Configure ${label}`);
  return v.trim();
}
function email(v: unknown): string {
  const s=required(v,'email address',254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s)) throw Error('Invalid email address');
  return s;
}
const id=(v: unknown)=> { const s=String(v ?? ''); if(!/^\d+$/.test(s)) throw Error('Missing or invalid CRM record identity');return s; };
export function salesSetup(v: Obj): SalesSetup {
  if(v.crmProvider!=='hubspot') throw Error('Select the supported CRM: HubSpot. Other CRMs are not configured by this action.');
  const account=(key: keyof typeof SALES_ACCOUNTS)=>{const s=required(v[key],key);if(!/^[\w:-]+$/.test(s))throw Error('Select a saved account reference, not credentials or an expression');return s;};
  const stages=typeof v.openStageIds==='string'?v.openStageIds.split(','):v.openStageIds;
  if(!Array.isArray(stages)||!stages.length||stages.length>100)throw Error('Select the open deal stage IDs');
  const openStageIds=[...new Set(stages.map(s=>required(s,'open stage ID')))];
  if(openStageIds.some(s=>!/^\w+$/.test(s)))throw Error('Invalid stage ID');
  const inactivityProperty=required(v.inactivityProperty,'inactivity timestamp property');
  if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(inactivityProperty))throw Error('Invalid property name');
  const replyLookbackDays=v.replyLookbackDays, inactivityDays=v.inactivityDays ?? 7;
  for(const [label,n] of [['Reply lookback',replyLookbackDays],['Inactivity',inactivityDays]] as const)
    if(!Number.isInteger(n)||n<1||n>365)throw Error(`${label} must be 1-365 days`);
  // Empty means the day Jarvis's own schedules use: the configured timezone, else this machine's zone.
  const configured=v.timezone==null||(typeof v.timezone==='string'&&!v.timezone.trim());
  const timezone=required(configured?getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone:v.timezone,'timezone');new Intl.DateTimeFormat('en',{timeZone:timezone}).format();
  return {crmProvider:'hubspot',hubspotConnection:account('hubspotConnection'),gmailConnection:account('gmailConnection'),ownerEmail:email(v.ownerEmail),
    senderName:required(v.senderName,'sender name',120),openStageIds,inactivityProperty,replyLookbackDays,inactivityDays,timezone};
}
export function salesDay(now: number, timezone: string): {date: string;weekday: boolean} {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now);
  const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,weekday:!['Sat','Sun'].includes(p.weekday!)};
}
export const salesIdentity=(scope: string,setup: SalesSetup,address: string,date: string)=>hash(['sales-followup-v1',scope,setup.gmailConnection,email(address),date]);
const query=(v: Record<string,string>)=>new URLSearchParams(v).toString();
const safeText=(v: unknown,max=300)=>String(v ?? '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max).trim();
const time=(v: unknown)=>{
  if(typeof v!=='string'||!v.trim())throw Error('Missing inactivity timestamp');
  const n=/^\d{13}$/.test(v)?Number(v):/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)?Date.parse(v):NaN;
  if(!Number.isFinite(n))throw Error('Inactivity timestamp must be ISO with timezone or epoch milliseconds');return n;
};
async function pages(request: SalesRequest,provider: 'hubspot'|'gmail',path: string,field: string): Promise<Obj[]> {
  const rows: Obj[]=[],seen=new Set<string>();let cursor: string|undefined;
  for(let n=0;n<100;n++) {
    const url=path+(cursor?`${path.includes('?')?'&':'?'}${query({[provider==='hubspot'?'after':'pageToken']:cursor})}`:'');
    const data=await request(provider,url),items=data[field] ?? (provider==='gmail'?[]:null);
    if(!Array.isArray(items)||items.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('Invalid provider result page');
    rows.push(...items);if(rows.length>5000)throw Error('Result limit exceeded; discovery is incomplete');
    const next=provider==='hubspot'?data.paging?.next?.after:data.nextPageToken;
    if(next==null||next==='')return rows;
    if(!['string','number'].includes(typeof next)||seen.has(String(next)))throw Error('Invalid or repeated page cursor');
    cursor=String(next);seen.add(cursor);
  }
  throw Error('Page limit exceeded; discovery is incomplete');
}
/** Open-stage deals via HubSpot CRM search, filtered server-side, with complete bounded pagination. */
async function openDeals(request: SalesRequest,s: SalesSetup,properties: string[]): Promise<Obj[]> {
  const rows: Obj[]=[],seen=new Set<string>();let after: string|undefined;
  const tooMany=()=>Error(`More than ${SALES_DEAL_LIMIT} deals are in the selected open stages; discovery is incomplete. Narrow the selected stages.`);
  for(let n=0;n<100;n++) {
    const data=await request('hubspot','/crm/v3/objects/deals/search',{filterGroups:[{filters:[{propertyName:'dealstage',operator:'IN',values:[...new Set(s.openStageIds.flatMap(v=>[v,v.toLowerCase()]))]}]}],
      properties,sorts:[{propertyName:'hs_object_id',direction:'ASCENDING'}],limit:100,...(after?{after}:{})});
    // Each stage ID is sent as configured and lowercased, so it matches whether HubSpot compares enumeration values exactly or requires lowercase IN values.
    // eligible() still compares the deal's actual stage exactly with the configured IDs.
    const items=data.results;
    if(!Array.isArray(items)||items.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('Invalid provider result page');
    if(typeof data.total==='number'&&data.total>SALES_DEAL_LIMIT)throw tooMany();
    rows.push(...items);if(rows.length>SALES_DEAL_LIMIT)throw tooMany();
    const next=data.paging?.next?.after;
    if(next==null||next==='')return rows;
    if(!['string','number'].includes(typeof next)||seen.has(String(next)))throw Error('Invalid or repeated page cursor');
    after=String(next);seen.add(after);
  }
  throw Error('Page limit exceeded; discovery is incomplete');
}
function eligible(deal: Obj,s: SalesSetup,now: number): boolean {
  if(deal.archived===true)return false;
  const p=deal.properties;
  if(!p||typeof p.dealstage!=='string')throw Error('Deal stage is unavailable');
  if(!s.openStageIds.includes(p.dealstage))return false;
  return time(p[s.inactivityProperty]) <= now-s.inactivityDays*86400_000;
}
async function contactFor(dealId: string,s: SalesSetup,request: SalesRequest): Promise<Obj> {
  const linked=await pages(request,'hubspot',`/crm/v4/objects/deals/${dealId}/associations/contacts?limit=500`,'results');
  const ids=[...new Set(linked.map(a=>id(a.toObjectId)))];
  if(ids.length!==1)throw Error('Needs review: select a single associated contact; no recipient was guessed');
  const contact=await request('hubspot',`/crm/v3/objects/contacts/${ids[0]}?properties=email,firstname,lastname,company`);
  if(id(contact.id)!==ids[0]||contact.archived===true)throw Error('Associated contact is unavailable');
  const address=email(contact.properties?.email);
  if(address===s.ownerEmail)throw Error('Associated contact is the mailbox owner');
  return {...contact,address};
}
/** Any recent inbound from the exact contact is a conservative reply veto, including other threads. */
async function recentReply(address: string,s: SalesSetup,request: SalesRequest,now: number): Promise<boolean> {
  const since=now-s.replyLookbackDays*86400_000;
  const threads=await pages(request,'gmail','/gmail/v1/users/me/threads?'+query({q:`from:"${address}" after:${Math.floor(since/1000)-1} before:${Math.ceil(now/1000)+1}`,maxResults:'100',includeSpamTrash:'true'}),'threads');
  let replied=false;
  for(const threadId of [...new Set(threads.map(t=>required(t.id,'Gmail thread ID')))]) {
    if(!/^[a-f0-9]+$/i.test(threadId))throw Error('Invalid Gmail thread ID');
    const thread=await request('gmail',`/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`);
    if(thread.id!==threadId||!Array.isArray(thread.messages))throw Error('Incomplete Gmail thread');
    for(const message of thread.messages) {
      const date=Number(message.internalDate);
      if(!Number.isFinite(date)||!Array.isArray(message.labelIds)||!Array.isArray(message.payload?.headers))throw Error('Incomplete Gmail message');
      if(date<since||date>now||message.labelIds.includes('DRAFT')||message.labelIds.includes('SENT'))continue;
      const from=message.payload.headers.find((h: Obj)=>String(h.name).toLowerCase()==='from')?.value;
      if(typeof from!=='string')throw Error('Missing message sender');
      const matches=from.toLowerCase().match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
      // A display name repeating the address ("a@x.com" <a@x.com>) is one sender, not an ambiguity.
      if(new Set(matches).size!==1)throw Error('Ambiguous message sender');
      if(matches[0]===address)replied=true;
    }
  }
  return replied;
}
function dealName(deal: Obj): string {
  const name=safeText(deal.properties?.dealname);
  if(!name)throw Error('Deal name is missing; cannot personalize the draft');
  return name;
}
function rawDraft(deal: Obj,contact: Obj,s: SalesSetup,key: string): string {
  const name=dealName(deal);
  const firstName=safeText(contact.properties?.firstname,120)||'there';
  const company=safeText(contact.properties?.company,200);
  const subject=`Following up: ${name}`;
  const body=`Hi ${firstName},\n\nI'm following up on ${name}${company?` for ${company}`:''}. Would you like to discuss the next steps?\n\nBest,\n${s.senderName}`;
  // Only fixed headers, encoded subject/body and validated addresses. CRM text cannot inject headers.
  const words:string[]=[];let chunk='';
  for(const ch of subject){if(Buffer.byteLength(chunk+ch)>42){words.push(chunk);chunk='';}chunk+=ch;}if(chunk)words.push(chunk);
  const encodedSubject=words.map(w=>`=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
  const encodedBody=Buffer.from(body).toString('base64').match(/.{1,76}/g)!.join('\r\n');
  const mime=[`From: ${s.ownerEmail}`,`To: ${contact.address}`,`Subject: ${encodedSubject}`,
    `Message-ID: <jarvis-followup-${key}@jarvis.invalid>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encodedBody].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}
export async function processSalesFollowups(s: SalesSetup,request: SalesRequest,ledger: SalesLedger,scope: string,
  clock: ()=>number=Date.now, checkpoint: ()=>void=()=>{}) {
  const now=clock(),day=salesDay(now,s.timezone),results: SalesResult[]=[];
  const finish=()=>{
    const counts=Object.fromEntries(['drafted','replied','already_processed','ineligible','review','unknown'].map(k=>[k,results.filter(r=>r.status===k).length]));
    const lines=[`Sales follow-ups | ${day.date} (${s.timezone})`,`${counts.drafted} drafts saved; ${counts.replied} skipped for replies; ${counts.already_processed} already processed; ${counts.ineligible} no longer eligible; ${counts.review} need review; ${counts.unknown} uncertain. Nothing sent.`,
      ...results.slice(0,150).map(r=>`Deal ${r.dealId}: ${r.status}. ${r.detail}`)];
    if(results.length>150)lines.push('First 150 results shown. All results are recorded in this workflow step.');
    if(!day.weekday)lines.push('Weekend: no source access or drafts.');
    return {complete:true,day:day.date,results,counts,summary:lines.join('\n')};
  };
  if(!day.weekday)return finish();
  checkpoint();
  const profile=await request('gmail','/gmail/v1/users/me/profile');
  if(email(profile.emailAddress)!==s.ownerEmail)throw Error('Selected Gmail account does not match your configured email');
  const property=await request('hubspot',`/crm/v3/properties/deals/${s.inactivityProperty}`);
  if(property.name!==s.inactivityProperty||property.type!=='datetime')throw Error('Select a HubSpot datetime property for the inactivity boundary');
  const pipelines=await request('hubspot','/crm/v3/pipelines/deals');
  if(!Array.isArray(pipelines.results))throw Error('Deal stages are unavailable');
  const stages=pipelines.results.flatMap((p: Obj)=>Array.isArray(p.stages)?p.stages:[]);
  for(const selected of s.openStageIds)if(!stages.some((stage: Obj)=>stage.id===selected&&[false,'false'].includes(stage.metadata?.isClosed)))throw Error('Selected stage is missing or not confirmed open');
  const fields=['dealname','dealstage',s.inactivityProperty];
  const deals=await openDeals(request,s,fields);
  const seen=new Set<string>();
  try { await batch(); } catch(error) {
    // A stopped batch keeps its already-saved drafts visible in the run error and its audit record.
    const done=results.filter(r=>r.status==='drafted').map(r=>`Deal ${r.dealId} draft ${safeText(r.draftId,100)}`);
    if(done.length&&error instanceof Error)error.message=safeText(`${error.message} | Drafts saved before stop: ${done.slice(0,50).join(', ')}${done.length>50?` and ${done.length-50} more`:''}`,4000);
    throw error;
  }
  return finish();
  async function batch() {
    for(const deal of deals) {
      checkpoint(); // Governance and cancellation always stop the batch, never become a per-deal failure.
      let dealId=safeText(deal.id,80)||'unknown',key: string|undefined,claimed=false,dispatched=false;
      try {
        dealId=id(deal.id);if(seen.has(dealId))continue;seen.add(dealId);
        if(!eligible(deal,s,now))continue;
        const contact=await contactFor(dealId,s,request);
        const currentDay=salesDay(clock(),s.timezone);
        if(currentDay.date!==day.date)throw Error('Date changed during batch; retry on the next scheduled run');
        key=salesIdentity(scope,s,contact.address,day.date);
        const claim=ledger.claim(key);
        if(claim!=='claimed') {results.push({dealId,...PRIOR[claim]!});continue;}
        claimed=true;
        const reread=await request('hubspot',`/crm/v3/objects/deals/${dealId}?${query({properties:fields.join(',')})}`);
        if(id(reread.id)!==dealId)throw Error('Deal identity changed');
        if(!eligible(reread,s,clock())) {
          // Nothing was sent for this deal, so the contact stays free for its other deals.
          claimed=false;ledger.release(key);results.push({dealId,status:'ineligible',detail:'Deal closed or activity changed before drafting.'});continue;
        }
        const latestContact=await contactFor(dealId,s,request);
        if(latestContact.address!==contact.address)throw Error('Contact association or address changed; review before drafting');
        if(await recentReply(contact.address,s,request,clock())) {
          const result: SalesResult={dealId,status:'replied',detail:'Recent inbound message found; no draft created.'};ledger.finish(key,result);results.push(result);continue;
        }
        const raw=rawDraft(reread,latestContact,s,key);
        checkpoint();
        if(salesDay(clock(),s.timezone).date!==day.date)throw Error('Date changed before draft dispatch');
        dispatched=true;
        const draft=await request('gmail','/gmail/v1/users/me/drafts',{message:{raw}});
        if(typeof draft.id!=='string'||!draft.id||!draft.message?.id)throw Error('Draft response did not confirm its identity');
        const result: SalesResult={dealId,status:'drafted',draftId:draft.id,detail:`Unsent Gmail draft ${safeText(draft.id,100)} saved.`};
        ledger.finish(key,result);results.push(result);
      } catch(error) {
        // Refused before any draft request, or definitely rejected by Gmail: the claim is freed, so it does not consume the contact for today.
        // An uncertain draft request keeps its claim and never unlocks automatically.
        if(notApplied(error))dispatched=false;
        if(claimed&&key&&!dispatched){claimed=false;ledger.release(key);}
        checkpoint(); // Propagate emergency/authority/account changes instead of swallowing them.
        const result: SalesResult={dealId,status:dispatched?'unknown':'review',detail:dispatched?'Draft creation may have succeeded. Inspect Gmail before any manual retry.':safeText((error as Error).message,300)};
        if(claimed&&key)ledger.finish(key,result);
        results.push(result);
      }
    }
  }
}

/** Credentials cannot be used outside this fixed endpoint/method allowlist, including fixture transports. */
export function salesTransport(tokens: {hubspot:string;gmail:string},checkpoint: ()=>void,fetchImpl: typeof fetch=fetch): SalesRequest {
  return async(provider,path,body)=>{
    const read=provider==='hubspot'
      ? /^\/crm\/v3\/objects\/(deals|contacts)\/\d+\?[^#]*$/.test(path)||/^\/crm\/v4\/objects\/deals\/\d+\/associations\/contacts\?[^#]*$/.test(path)||/^\/crm\/v3\/properties\/deals\/[a-zA-Z][a-zA-Z0-9_]*$/.test(path)||path==='/crm/v3/pipelines/deals'
      : path==='/gmail/v1/users/me/profile'||/^\/gmail\/v1\/users\/me\/threads(?:\/[a-f0-9]+)?\?[^#]*$/i.test(path);
    const draft=provider==='gmail'&&path==='/gmail/v1/users/me/drafts'&&body&&Object.keys(body).join()==='message'&&Object.keys(body.message ?? {}).join()==='raw'&&typeof body.message.raw==='string';
    // The deal search is a read sent as POST; only search fields are accepted.
    const search=provider==='hubspot'&&path==='/crm/v3/objects/deals/search'&&body&&Object.keys(body).every(k=>['filterGroups','properties','sorts','limit','after'].includes(k));
    if(!(read&&!body)&&!draft&&!search)throw new SalesRequestNotApplied('Sales follow-ups only permit declared reads and creation of unsent drafts');
    // A governance or account-binding stop here means nothing was sent.
    try{checkpoint();}catch(error){if(typeof error==='object'&&error!==null)stoppedBeforeSend.add(error);throw error;}
    const response=await fetchImpl((provider==='gmail'?'https://gmail.googleapis.com':'https://api.hubapi.com')+path,{
      method:body?'POST':'GET',headers:{Authorization:`Bearer ${tokens[provider]}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){
      await response.body?.cancel();const message=`${provider} request failed (HTTP ${response.status})`;
      throw draft&&DEFINITE_DRAFT_REJECTIONS.has(response.status)?new SalesRequestNotApplied(`Gmail rejected the draft (HTTP ${response.status}); nothing was saved`):Error(message);
    }
    const reader=response.body?.getReader();if(!reader)throw Error('Empty provider response');const chunks:Uint8Array[]=[];let size=0;
    for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>2_000_000){await reader.cancel();throw Error('Provider response exceeds limit');}chunks.push(next.value);}
    checkpoint();const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!data||typeof data!=='object'||Array.isArray(data)||data.error)throw Error('Invalid provider response');return data;
  };
}
