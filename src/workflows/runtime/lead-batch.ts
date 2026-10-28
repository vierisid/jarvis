/** Bounded update-only lead batches. No provider SDK retries or contact creation. */
import { hubspotContactInput } from './hubspot-contact';
export const BATCH_PIECE = '@jarvispieces/piece-jarvis-batch';
export const BATCH_ACTION = 'update_leads';
export const BATCH_FINALIZE = 'finalize_batch';
export const BATCH_ACCOUNTS = { hubspotConnection: '@activepieces/piece-hubspot' };
export const BATCH_REQUIRED = ['hubspotConnection','hubspotPortalId','submissionIdPath','leadsPath','contactKeyType','contactKeyPath','propertyMapping'] as const;
export interface BatchSetup extends Record<string,unknown> {
  hubspotConnection:string; hubspotPortalId:string; submissionIdPath:string; leadsPath:string;
  contactKeyType:'id'|'email'; contactKeyPath:string; propertyMapping:Record<string,string>;
}
const object = (x:unknown):x is Record<string,unknown> => !!x && typeof x==='object' && !Array.isArray(x);
const path = (x:unknown) => typeof x==='string' && x.length<=200 && x.split('.').every(p=>/^[A-Za-z_][\w-]*$/.test(p) && !['__proto__','constructor','prototype'].includes(p));
export function batchField(value:unknown, field:string):unknown {
  for(const part of field.split('.')) { if(!object(value)||!Object.hasOwn(value,part))return undefined; value=value[part]; }
  return value;
}
export function batchSetup(input:Record<string,unknown>):BatchSetup {
  for(const k of ['hubspotConnection','hubspotPortalId'] as const) if(typeof input[k]!=='string'||!(k==='hubspotPortalId'?/^\d{1,30}$/:/^[\w:-]{1,200}$/).test(input[k]))throw Error('Select '+k);
  for(const k of ['submissionIdPath','leadsPath','contactKeyPath'])if(!path(input[k]))throw Error('Configure a safe '+k);
  if(!['id','email'].includes(String(input.contactKeyType)))throw Error('Select existing contact ID or primary email');
  if(!object(input.propertyMapping)||!Object.keys(input.propertyMapping).length||Object.keys(input.propertyMapping).length>100)throw Error('Map 1 to 100 allowed HubSpot properties to required lead fields');
  const mapping:Record<string,string>={};
  for(const [key,value]of Object.entries(input.propertyMapping)) {
    if(!path(value))throw Error('Invalid lead property field path');
    hubspotContactInput({email:'validation@example.invalid',objectProperties:{[key]:''}});
    mapping[key]=value as string;
  }
  return {...Object.fromEntries(BATCH_REQUIRED.filter(k=>k!=='propertyMapping').map(k=>[k,input[k]])),propertyMapping:mapping} as BatchSetup;
}
export interface BatchInput { id:string; leads:unknown[] }
export function batchInput(setup:BatchSetup,payload:unknown):BatchInput {
  const id=batchField(payload,setup.submissionIdPath),leads=batchField(payload,setup.leadsPath);
  if(typeof id!=='string'||!id.trim()||id.length>200||/[\x00-\x1f\x7f]/.test(id))throw Error('A stable nonempty submission ID is required');
  if(!Array.isArray(leads)||leads.length>1000||JSON.stringify(leads).length>1_000_000)throw Error('Lead list must contain at most 1000 records and 1 MB of JSON');
  return {id:id.trim(),leads:structuredClone(leads)};
}
export interface LeadUpdate { key:string; properties:Record<string,string> }
export function leadUpdate(setup:BatchSetup,lead:unknown):LeadUpdate {
  const raw=batchField(lead,setup.contactKeyPath);
  if(typeof raw!=='string')throw Error('Missing contact identifier');
  const key=setup.contactKeyType==='email'?raw.trim().toLowerCase():raw.trim();
  if(setup.contactKeyType==='id'&&!/^\d{1,30}$/.test(key))throw Error('Invalid contact ID');
  const properties=Object.fromEntries(Object.entries(setup.propertyMapping).map(([k,p])=>[k,batchField(lead,p)]));
  const validated=hubspotContactInput({email:setup.contactKeyType==='email'?key:'validation@example.invalid',objectProperties:properties});
  return {key,properties:validated.objectProperties};
}
export type RecordStatus = 'updated'|'rejected'|'failed'|'uncertain';
export interface BatchRecord { index:number; reference:string; status:RecordStatus|'dispatching'; reason?:string; contactId?:string; url?:string }
export interface BatchProgress { input:BatchInput; outcomes:Record<string,BatchRecord> }
export interface BatchStore { check():void; load():BatchProgress; save(progress:BatchProgress):void }
export type BatchWrite = (lead:LeadUpdate)=>Promise<Omit<BatchRecord,'index'|'reference'>>;
export interface BatchResult { complete:true; total:number; counts:Record<RecordStatus,number>; records:BatchRecord[]; fullySuccessful:boolean; empty:boolean; summary:string; notificationKey:string }
export function batchResult(progress:BatchProgress,identity:string):BatchResult {
  const records=Object.values(progress.outcomes).sort((a,b)=>a.index-b.index),counts={updated:0,rejected:0,failed:0,uncertain:0};
  if(records.length!==progress.input.leads.length||records.some(r=>r.status==='dispatching'))throw Error('Batch has unfinished records');
  for(const r of records)counts[r.status as RecordStatus]++;
  const fullySuccessful=counts.rejected+counts.failed+counts.uncertain===0,empty=records.length===0;
  const summary=[`Lead batch ${progress.input.id}: ${empty?'empty, no updates':fullySuccessful?'completed':'completed with issues'}.`,
    `Updated: ${counts.updated}; rejected: ${counts.rejected}; failed: ${counts.failed}; uncertain: ${counts.uncertain}.`,
    ...records.map(r=>`${r.reference}: ${r.status}${r.url?' '+r.url:''}${r.reason?' ('+r.reason+')':''}`)].join('\n');
  return {complete:true,total:records.length,counts,records,fullySuccessful,empty,summary,notificationKey:'lead-batch:'+identity};
}
/** At most three requests per slice (each <=10s). Checkpoint before and after each
 * dispatch. An abandoned dispatch is uncertain, never a license to resend. */
export async function batchSlice(setup:BatchSetup,store:BatchStore,write:BatchWrite,identity:string,now=Date.now):Promise<BatchResult|{complete:false;resumeAt:number}> {
  const progress=store.load();let processed=0;
  for(let index=0;index<progress.input.leads.length;index++) {
    store.check();const old=progress.outcomes[index];
    if(old?.status==='dispatching') { progress.outcomes[index]={...old,status:'uncertain',reason:'Interrupted dispatch; inspect contact before further writes'};store.save(progress);continue; }
    if(old)continue;
    if(processed++===3)return {complete:false,resumeAt:now()+1000};
    const base={index,reference:`${progress.input.id}/records/${index}`};let lead:LeadUpdate;
    try { lead=leadUpdate(setup,progress.input.leads[index]); }
    catch { progress.outcomes[index]={...base,status:'rejected',reason:'Invalid contact identifier or required mapped property value'};store.save(progress);continue; }
    progress.outcomes[index]={...base,status:'dispatching'};store.save(progress);
    const result=await write(lead); // Governance/lease failures propagate, leaving a conservative uncertain receipt.
    store.check();progress.outcomes[index]={...base,...result};store.save(progress);
  }
  return batchResult(progress,identity);
}
/** Official update endpoint, never create/upsert:
 * https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide */
export function batchTransport(setup:BatchSetup,token:string,check:()=>void,fetchImpl:typeof fetch=fetch):BatchWrite {
  return async lead=>{
    check(); // Outside catch: Authority/cancellation stops the batch.
    let response:Response;
    try { response=await fetchImpl('https://api.hubapi.com/crm/v3/objects/contacts/'+encodeURIComponent(lead.key)+(setup.contactKeyType==='email'?'?idProperty=email':''),{
      method:'PATCH',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({properties:lead.properties}),redirect:'error',signal:AbortSignal.timeout(10_000)}); }
    catch { return {status:'uncertain',reason:'No confirmed response; automatic resend blocked'}; }
    if(!response.ok) { const status=response.status;await response.body?.cancel();
      return {status:[400,401,403,404,409,422,429].includes(status)?'failed':'uncertain',reason:`HubSpot HTTP ${status}; no automatic resend`}; }
    try {
      const reader=response.body?.getReader();if(!reader)throw Error();let text='',bytes=0;const decoder=new TextDecoder();
      while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>131072){await reader.cancel();throw Error();}text+=decoder.decode(r.value,{stream:true});}
      const data=JSON.parse(text+decoder.decode());
      if(typeof data.id!=='string'||!/^\d{1,30}$/.test(data.id)||!object(data.properties)||data.archived===true||setup.contactKeyType==='id'&&data.id!==lead.key||!Object.entries(lead.properties).every(([k,v])=>String(data.properties[k])===v))throw Error();
      return {status:'updated',contactId:data.id,url:`https://app.hubspot.com/contacts/${setup.hubspotPortalId}/contact/${data.id}`};
    } catch { return {status:'uncertain',reason:'Invalid or incomplete update receipt; inspect contact'}; }
  };
}
/** Required after the summary. A partial batch must not produce a green run. */
export function finalizeBatch(result:unknown) {
  const r=result as BatchResult;
  if(!r||r.complete!==true||!Array.isArray(r.records)||!r.counts||!Number.isInteger(r.total)||r.total!==r.records.length)throw Error('Invalid final batch report');
  const counts={updated:0,rejected:0,failed:0,uncertain:0};
  for(const row of r.records){if(!Object.hasOwn(counts,row.status))throw Error('Unfinished batch report');counts[row.status as RecordStatus]++;}
  if(Object.keys(counts).some(k=>counts[k as RecordStatus]!==r.counts[k as RecordStatus]))throw Error('Inconsistent batch counts');
  if(counts.rejected+counts.failed+counts.uncertain>0)throw Error(`Batch completed with issues: ${counts.updated} updated, ${counts.rejected} rejected, ${counts.failed} failed, ${counts.uncertain} uncertain. See the final summary; completed updates were retained.`);
  return {status:r.total?'completed':'empty',counts};
}

/** Keep the truthful final status coupled to the reporting graph. */
export function batchGraphError(action:any):string|null {
  const notify=action?.nextAction,finalize=notify?.nextAction;
  if(!notify||notify.type!=='PIECE'||notify.settings?.pieceName!=='@jarvispieces/piece-jarvis-notify'||notify.settings.actionName!=='notify'
    ||notify.settings.input?.message!==`{{${action.name}.summary}}`||notify.settings.input?.idempotencyKey!==`{{${action.name}.notificationKey}}`
    ||JSON.stringify(notify.settings.input?.channels)!=='["dashboard"]'||!finalize||finalize.type!=='PIECE'||finalize.settings?.pieceName!==BATCH_PIECE||finalize.settings.actionName!==BATCH_FINALIZE
    ||finalize.settings.input?.result!==`{{${action.name}}}`||finalize.nextAction
    ||[action,notify,finalize].some(n=>n.firstLoopAction||n.children||n.onErrorAction||n.settings?.errorHandlingOptions?.continueOnFailure?.value===true||n.settings?.errorHandlingOptions?.retryOnFailure?.value===true))
    return 'Lead batch requires update_leads -> dashboard summary/message and notificationKey -> finalize_batch(result=the batch output), without swallowed errors or engine retries';
  return null;
}
