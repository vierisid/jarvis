import {BATCH_PIECE,BATCH_ACTION,BATCH_REQUIRED,batchGraphError,batchSetup,batchInput,batchSlice,batchTransport,finalizeBatch,type BatchProgress,type BatchStore,type BatchSetup,type BatchResult} from './lead-batch';
import {digest} from './effect-context';
import {evaluateWorkflowExpression} from './safe-expression';
export const batchFixtureSetup={hubspotConnection:'fixture-hubspot',hubspotPortalId:'12345',submissionIdPath:'submission_id',leadsPath:'leads',contactKeyType:'id',contactKeyPath:'contact_id',propertyMapping:{firstname:'name'}};
export function memoryBatchStore(initial:BatchProgress):BatchStore {
 let value=structuredClone(initial);return {check(){},load:()=>structuredClone(value),save:p=>{value=structuredClone(p);}};
}
export function batchFixtureProvider(){
 const calls:string[]=[],writes:string[]=[];const modes:Record<string,'ok'|'fail'|'unknown'|'malformed'>={};
 const fetchImpl=(async(url:any,init:any)=>{
  const u=new URL(String(url));if(u.origin!=='https://api.hubapi.com'||!u.pathname.startsWith('/crm/v3/objects/contacts/')||init.method!=='PATCH'||init.redirect!=='error')throw Error('Fixture refused unexpected provider action');
  const key=decodeURIComponent(u.pathname.split('/').at(-1)!);calls.push(key);const mode=modes[key]??'ok';
  if(mode==='fail')return Response.json({}, {status:404});writes.push(key);
  if(mode==='unknown')throw Error('Synthetic response lost after update');if(mode==='malformed')return Response.json({});
  return Response.json({id:key.includes('@')?String(100+calls.length):key,properties:JSON.parse(init.body).properties,archived:false});
 }) as typeof fetch;
 return {calls,writes,modes,fetchImpl};
}
function put(object:any,path:string,value:unknown){const parts=path.split('.');for(const p of parts.slice(0,-1))object=object[p]??={};object[parts.at(-1)!]=value;}
export function batchFixturePayload(setup:BatchSetup,count=5,id='fixture-submission') {
 const payload:any={},leads:any[]=[];
 for(let i=0;i<count;i++){const lead:any={};put(lead,setup.contactKeyPath,setup.contactKeyType==='email'?`lead${i+1}@example.invalid`:String(i+1));for(const p of Object.values(setup.propertyMapping))put(lead,p,'Example '+i);leads.push(lead);}
 put(payload,setup.submissionIdPath,id);put(payload,setup.leadsPath,leads);return payload;
}
export async function validateBatchFixtures(trigger:any){
 const action=trigger?.nextAction,notify=action?.nextAction,finalize=notify?.nextAction;
 if(trigger?.type!=='PIECE_TRIGGER'||trigger.settings?.pieceName!=='webhook'||Object.values(trigger.settings.input??{}).some(v=>v!==''&&v!==null&&v!==undefined)
   ||action?.type!=='PIECE'||action.settings?.pieceName!==BATCH_PIECE||action.settings.actionName!==BATCH_ACTION||action.settings.input?.submission!=='{{trigger}}'||batchGraphError(action))throw Error('Batch fixtures require webhook -> update_leads(submission={{trigger}}) -> dashboard summary/key -> finalize_batch. Additional graph behavior is not covered.');
 const input=structuredClone(action.settings.input);for(const k of BATCH_REQUIRED)if(input[k]===''||input[k]==null)input[k]=batchFixtureSetup[k];
 const setup=batchSetup(input),cases:Array<{name:string;passed:boolean;counts:BatchResult['counts'];finalStatus:string}>=[];
 const assert=(ok:unknown,text:string)=>{if(!ok)throw Error('Batch fixture: '+text);};
 for(const scenario of ['mixed batch','empty batch','all records failing','interruption after successful updates','invalid provider receipt'] as const){
  const payload=batchFixturePayload(setup,scenario==='empty batch'?0:5),batch=batchInput(setup,payload),provider=batchFixtureProvider();
  const key=(i:number)=>setup.contactKeyType==='email'?`lead${i}@example.invalid`:String(i);
  if(scenario==='mixed batch'){batch.leads[1]={};provider.modes[key(3)]='fail';provider.modes[key(4)]='unknown';}
  if(scenario==='all records failing')for(let i=1;i<=5;i++)provider.modes[key(i)]='fail';
  if(scenario==='invalid provider receipt')provider.modes[key(1)]='malformed';
  const store=memoryBatchStore({input:batch,outcomes:{}}),write=batchTransport(setup,'synthetic',()=>{},provider.fetchImpl);
  if(scenario==='interruption after successful updates'){
   let calls=0;try{await batchSlice(setup,store,async lead=>{if(++calls===2)throw Error('Synthetic worker interruption');return write(lead);},'fixture');}catch(e){assert(String(e).includes('Synthetic worker'),'expected interruption');}
   assert(provider.calls.length===1,'successful update before interruption');
  }
  let result:any;for(let i=0;i<10;i++){result=await batchSlice(setup,store,write,'fixture');if(result.complete)break;}
  assert(result?.complete,'final report only after all outcomes');
  const expected=scenario==='mixed batch'?{updated:2,rejected:1,failed:1,uncertain:1}:scenario==='all records failing'?{updated:0,rejected:0,failed:5,uncertain:0}:scenario==='empty batch'?{updated:0,rejected:0,failed:0,uncertain:0}:{updated:4,rejected:0,failed:0,uncertain:1};
  assert(JSON.stringify(result.counts)===JSON.stringify(expected),scenario+' counts');
  const scope={[action.name]:result};
  const message=evaluateWorkflowExpression(notify.settings.input.message.slice(2,-2),scope),notificationKey=evaluateWorkflowExpression(notify.settings.input.idempotencyKey.slice(2,-2),scope);
  assert(typeof message==='string'&&message.includes('Updated: '+expected.updated)&&message.includes('uncertain: '+expected.uncertain),'summary counts');
  for(const record of result.records)assert(typeof message==='string'&&message.includes(record.reference),'all record references');
  const report=evaluateWorkflowExpression(finalize.settings.input.result.slice(2,-2),scope);let finalStatus='SUCCEEDED';
  try{finalizeBatch(report);}catch{finalStatus='FAILED';}
  assert(finalStatus===(scenario==='empty batch'?'SUCCEEDED':'FAILED'),'truthful final run status');
  const n=provider.calls.length,replay=await batchSlice(setup,store,write,'fixture');assert(provider.calls.length===n,'replay never repeats terminal updates');
  assert(replay.complete&&replay.notificationKey===notificationKey,'one summary key across replay');
  cases.push({name:scenario+' and repeated delivery',passed:true,counts:result.counts,finalStatus});
 }
 return {passed:true,definitionDigest:digest(trigger),cases,externalActions:0,scope:'Component-only saved graph fixtures: real coordinator, PATCH request shapes, expression evaluation, finalizer and in-memory receipts. No durable SQLite, worker, Authority, account binding, dashboard transport or live HubSpot; repository integration tests exercise storage/worker separately.',configuration:'Synthetic missing setup substituted only in memory; no credentials resolved; saved draft unchanged'};
}
