import {createHash} from 'node:crypto';
import {hubspotContactInput} from './hubspot-contact';

export const IMPORT_PIECE='@jarvispieces/piece-jarvis-import';
export const IMPORT_ACTION='resumable_contact_import';
export const IMPORT_ACCOUNTS={hubspotConnection:'@activepieces/piece-hubspot',sourceConnection:'@activepieces/piece-http-oauth2'} as const;
export const IMPORT_REQUIRED=['importId','sourceUrl','sourceAuth','hubspotConnection','hubspotPortalId','itemsPath','nextCursorPath','cursorParameter','idPath','emailPath','propertyMapping'] as const;
export interface ImportSetup extends Record<string,unknown> {
  importId:string;sourceUrl:string;sourceAuth:'none'|'oauth2';sourceConnection:string;hubspotConnection:string;hubspotPortalId:string;
  itemsPath:string;nextCursorPath:string;cursorParameter:string;idPath:string;emailPath:string;propertyMapping:Record<string,string>;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const pathPattern=/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*$/;
const forbidden=new Set(['__proto__','constructor','prototype']);
function path(v:unknown,label:string){if(typeof v!=='string'||v.length>200||!pathPattern.test(v)||v.split('.').some(k=>forbidden.has(k)))throw Error('Configure '+label+' as a field path');return v;}
function field(v:unknown,label:string,pattern:RegExp){if(typeof v!=='string'||!v.trim()||v.length>300||!pattern.test(v))throw Error('Configure '+label);return v;}
export function importSetup(raw:Record<string,unknown>):ImportSetup {
  const sourceUrl=field(raw.sourceUrl,'source URL',/^https:\/\//);const u=new URL(sourceUrl);
  if(u.username||u.password||u.hash||u.port&&u.port!=='443')throw Error('Use an HTTPS source URL without credentials, fragment or a custom port');
  if([...u.searchParams.keys()].some(k=>/token|secret|password|api.?key|authorization/i.test(k)))throw Error('Put source credentials in a saved connection, never the URL');
  if(!['none','oauth2'].includes(String(raw.sourceAuth)))throw Error('Choose anonymous or OAuth2 source authentication');
  const sourceAuth=raw.sourceAuth as ImportSetup['sourceAuth'];
  const sourceConnection=sourceAuth==='oauth2'?field(raw.sourceConnection,'source account',/^[\w:-]+$/):'';
  let mapping=raw.propertyMapping;if(typeof mapping==='string'){try{mapping=JSON.parse(mapping);}catch{throw Error('Configure property mapping as a JSON object');}}
  if(!object(mapping)||Object.keys(mapping).length>100)throw Error('Configure property mapping as an object; use {} for email only');
  const propertyMapping:Record<string,string>={};
  for(const [key,value] of Object.entries(mapping)){
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key)||['email','hs_additional_emails',...forbidden].includes(key))throw Error('Invalid HubSpot property mapping');
    propertyMapping[key]=path(value,'source property');
  }
  return {importId:field(raw.importId,'stable import ID',/^[\w.-]+$/),sourceUrl:u.toString(),sourceAuth,sourceConnection,
    hubspotConnection:field(raw.hubspotConnection,'HubSpot account',/^[\w:-]+$/),hubspotPortalId:field(raw.hubspotPortalId,'HubSpot portal ID',/^\d+$/),
    itemsPath:path(raw.itemsPath,'items path'),nextCursorPath:path(raw.nextCursorPath,'next cursor path'),cursorParameter:field(raw.cursorParameter,'cursor query parameter',/^[a-zA-Z_][\w]*$/),
    idPath:path(raw.idPath,'record ID path'),emailPath:path(raw.emailPath,'email path'),propertyMapping};
}
export function atPath(v:unknown,p:string):unknown {for(const k of p.split('.')){if(!object(v)||!Object.hasOwn(v,k))return undefined;v=v[k];}return v;}
export const importDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface ImportContact {id:string;email:string;properties:Record<string,string>;hash:string}
export interface ImportProgress {
  cursor:string|null;page:ImportContact[]|null;next:string|null;index:number;pages:number;contacts:number;complete:boolean;
  phase:'account'|'page'|'lookup'|'write'|'reconcile';method:'POST'|'PATCH';retries:number;notBefore:number;inFlight:boolean;error?:string;stoppedRun?:string;
}
export const initialImportProgress=():ImportProgress=>({cursor:null,page:null,next:null,index:0,pages:0,contacts:0,complete:false,phase:'account',method:'POST',retries:0,notBefore:0,inFlight:false});
export interface ImportStore {
  load():ImportProgress;save(state:ImportProgress):void;check():void;
  seenCursor(cursor:string|null):boolean;savePage(state:ImportProgress):void;
  record(id:string):{hash:string;contactId:string}|null;
  finishContact(state:ImportProgress,contact:ImportContact,contactId:string):void;
}
export interface ImportResponse {status:number;retryAfter?:string|null;body:unknown}
export type ImportRequest=(provider:'source'|'hubspot',url:string,method:'GET'|'POST'|'PATCH',body?:unknown)=>Promise<ImportResponse>;
export class ImportTransportError extends Error {constructor(){super('Provider transport interrupted');}}
export function retryDeadline(value:string|null|undefined,now:number,retries:number):number {
  const fallback=now+1000*2**Math.min(retries,3);
  if(!value)return fallback;
  if(/^\d+$/.test(value.trim())){const seconds=Number(value);if(Number.isSafeInteger(seconds)&&seconds>=0&&now+seconds*1000<8.64e15)return Math.max(fallback,now+seconds*1000);throw Error('Invalid Retry-After delay');}
  // HTTP-date is always GMT (RFC 9110 5.6.7). Date.parse reads a zone-less
  // string in the machine zone, so accept only IMF-fixdate/RFC 850 (explicit
  // GMT) and asctime (implicitly GMT, so pinned to it here).
  const v=value.trim(),asctime=/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(v);
  const date=asctime?Date.parse(v+' GMT'):/^[A-Z][a-z]+, [\d -]+[A-Z][a-z]{2}[\d -]+ \d{2}:\d{2}:\d{2} GMT$/.test(v)?Date.parse(v):NaN;
  if(!Number.isFinite(date))throw Error('Invalid Retry-After date');return Math.max(fallback,date);
}
function pageData(body:unknown,s:ImportSetup){
  const items=atPath(body,s.itemsPath),next=atPath(body,s.nextCursorPath);
  if(!Array.isArray(items)||items.length>1000)throw Error('Source page must contain at most 1000 records');
  if(next!==null&&(typeof next!=='string'||next.length>4096))throw Error('Source must explicitly return next_cursor as a string or null');
  const page=items.map(row=>{
    const id=atPath(row,s.idPath);if(!['string','number'].includes(typeof id)||typeof id==='number'&&!Number.isSafeInteger(id)||!String(id).trim()||String(id).length>300)throw Error('Source record is missing a stable ID');
    const properties:Record<string,unknown>={};for(const[k,p]of Object.entries(s.propertyMapping)){const v=atPath(row,p);if(v===undefined||v===null)throw Error('Mapped source property is missing');properties[k]=v;}
    const contact=hubspotContactInput({email:atPath(row,s.emailPath),objectProperties:properties});
    return {id:String(id),email:contact.email,properties:contact.objectProperties,hash:importDigest(contact)};
  });
  const identities=new Map<string,string>();for(const r of page){if(identities.has(r.id)&&identities.get(r.id)!==r.hash)throw Error('Conflicting source identity in page');identities.set(r.id,r.hash);}
  return {page,next:next===''?null:next as string|null};
}
/** One bounded provider operation per slice. Progress, retry reservation and page
 * snapshot live in SQLite; timer waitpoints release the engine between slices. */
export async function importSlice(s:ImportSetup,store:ImportStore,request:ImportRequest,now:number,clock:()=>number=()=>now,run?:string):Promise<{complete:boolean;pages:number;contacts:number;resumeAt?:number}> {
  const p=store.load();store.check();
  const result=(resumeAt?:number)=>({complete:p.complete,pages:p.pages,contacts:p.contacts,...(!p.complete?{resumeAt:resumeAt??now+1}: {})});
  const fail=(message:string):never=>{p.error=message;p.stoppedRun=run;p.inFlight=false;store.save(p);throw Error(message);};
  // A stop is final for the run that hit it. A new run (a fresh start, and
  // fresh approval when governed) resumes from the checkpoint with a fresh
  // budget, reconciling a possibly committed write by lookup before any repeat.
  // Deterministic stops (cycles, changed identities) are detected again.
  if(p.error){
    if(run===undefined||p.stoppedRun===run)throw Error(p.error);
    delete p.error;delete p.stoppedRun;p.retries=0;p.notBefore=0;if(p.phase==='write')p.phase='reconcile';store.save(p);
  }
  if(p.complete)return result();
  if(p.notBefore>now)return result(p.notBefore);
  // A process died after reserving a request. Count that attempt, and reconcile
  // a potentially committed write before any repeat. Do not reset the budget.
  if(p.inFlight){p.inFlight=false;p.retries++;if(p.phase==='write')p.phase='reconcile';else if(p.retries>3)return fail('Import retry budget exhausted after interruption');store.save(p);}
  if(p.page&&p.index>=p.page.length){p.cursor=p.next;p.page=null;p.index=0;p.pages++;p.complete=p.next===null;p.phase='page';p.retries=0;p.notBefore=0;store.save(p);return result();}
  let contact=p.page?.[p.index];
  if(contact){const receipt=store.record(contact.id);if(receipt){if(receipt.hash!==contact.hash)return fail('Source identity changed since its confirmed import');p.index++;p.phase='lookup';p.retries=0;store.save(p);return result();}}
  let url:string,method:'GET'|'POST'|'PATCH'='GET',body:unknown,provider:'source'|'hubspot';
  if(p.phase==='account'){provider='hubspot';url='https://api.hubapi.com/account-info/v3/details';}
  else if(!p.page){
    if(store.seenCursor(p.cursor))return fail('Source cursor cycle detected');
    const u=new URL(s.sourceUrl);if(p.cursor!==null)u.searchParams.set(s.cursorParameter,p.cursor);url=u.toString();provider='source';
  }else{
    if(!contact)return fail('Import page position invalid');provider='hubspot';
    const base='https://api.hubapi.com/crm/v3/objects/contacts';
    url=base+'/'+encodeURIComponent(contact.email)+'?idProperty=email&properties='+encodeURIComponent(['email',...Object.keys(contact.properties)].join(','));
    if(p.phase==='write'){
      if(p.retries>3)return fail('Import retry budget exhausted; inspect contact before continuing');
      method=p.method;url=method==='POST'?base:base+'/'+encodeURIComponent(contact.email)+'?idProperty=email';
      body={properties:{...contact.properties,...(method==='POST'?{email:contact.email}:{})}};
    }
  }
  // Reserving before dispatch means even a crash cannot erase an attempted retry.
  p.inFlight=true;p.notBefore=now+30_000;store.save(p);store.check();
  let r:ImportResponse;
  try{r=await request(provider,url,method,body);}catch(e){
    store.check();if(!(e instanceof ImportTransportError))throw e;
    p.inFlight=false;p.retries++;if(method!=='GET')p.phase='reconcile';
    if(p.retries>3&&(method==='GET'||p.phase!=='reconcile'))return fail('Import retry budget exhausted');
    p.notBefore=retryDeadline(undefined,clock(),p.retries);store.save(p);return result(p.notBefore);
  }
  store.check();p.inFlight=false;p.notBefore=0;
  if([408,425,429,500,502,503,504].includes(r.status)){
    p.retries++;if(method!=='GET'&&r.status!==429)p.phase='reconcile';
    if(p.retries>3&&(method==='GET'||p.phase!=='reconcile'))return fail('Import retry budget exhausted');
    try{p.notBefore=retryDeadline(r.retryAfter,clock(),p.retries);}catch{return fail('Invalid Retry-After; import stopped without ignoring the provider delay');}
    store.save(p);return result(p.notBefore);
  }
  if(p.phase==='account'){
    if(r.status!==200||!object(r.body)||String(r.body.portalId)!==s.hubspotPortalId)return fail('HubSpot portal verification failed');
    p.phase='page';p.retries=0;store.save(p);return result();
  }
  if(provider==='source'){
    if(r.status!==200)return fail('Source refused page: HTTP '+r.status);
    try{const data=pageData(r.body,s);p.page=data.page;p.next=data.next;p.index=0;p.phase='lookup';p.retries=0;store.savePage(p);}catch(e){return fail((e as Error).message);}return result();
  }
  contact=contact!;
  const receipt=object(r.body)?r.body:null;
  const matches=receipt&&typeof receipt.id==='string'&&/^\d+$/.test(receipt.id)&&object(receipt.properties)&&String(receipt.properties.email??'').toLowerCase()===contact.email&&Object.entries(contact.properties).every(([k,v])=>String((receipt.properties as Record<string,unknown>)[k])===v);
  if(r.status>=200&&r.status<300){
    if(matches){const id=String(receipt!.id);p.index++;p.contacts++;p.phase='lookup';p.retries=0;store.finishContact(p,contact,id);return result();}
    if(method==='GET'&&receipt&&typeof receipt.id==='string'&&/^\d+$/.test(receipt.id)&&object(receipt.properties)&&String(receipt.properties.email??'').toLowerCase()===contact.email){p.phase='write';p.method='PATCH';}
    else if(method!=='GET'){p.phase='reconcile';p.retries++;}
    else return fail('HubSpot returned an invalid or mismatched contact');
  }else if(method==='GET'&&r.status===404){p.phase='write';p.method='POST';}
  else if(method==='POST'&&r.status===409){p.phase='lookup';p.retries++;}
  else return fail('HubSpot refused contact: HTTP '+r.status);
  if(p.retries>3)return fail('Import retry budget exhausted; contact not confirmed');
  store.save(p);return result();
}
