import {refundSetup,refundTicket,proposeRefund,dispatchApprovedRefund,refundDecision,REFUND_PIECE,REFUND_ACTION,type RefundState,type RefundStore} from './refund';
import {refundTransport} from './refund-transport';
import {digest} from './effect-context';
export const refundFixtureSetup={stripeConnection:'fixture-stripe',stripeAccountId:'acct_fixture',stripeMode:'test',ticketSource:'fixture-tickets',ticketIdPath:'id',paymentIdPath:'payment',refundRequestedPath:'kind',refundRequestedValue:'refund',amountMinorPath:'amount'};
export const refundFixtureTicket={id:'ticket-1',payment:'pi_fixture',kind:'refund',amount:1200};
export function refundFixtureProvider(){
 const calls:Array<{method:string;path:string;body:string}>=[],refunds:any[]=[];
 const payment={id:'ch_fixture',currency:'eur',amount:3000,amount_captured:3000,amount_refunded:0,paid:true,captured:true,disputed:false,livemode:false};
 const options={loseReply:false,rejectWrite:false,status:'succeeded',pageSize:100,answerWrite:null as null|{status:number;body:unknown}};
 const fetchImpl=(async(url:any,init:any={})=>{
  const u=new URL(String(url)),method=init.method??'GET';calls.push({method,path:u.pathname+u.search,body:String(init.body??'')});
  if(u.origin!=='https://api.stripe.com')throw Error('Fixture denied unexpected network target');
  const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
  if(method==='GET'&&u.pathname==='/v1/account')return json({id:'acct_fixture'});
  if(method==='GET'&&u.pathname==='/v1/payment_intents/pi_fixture')return json({id:'pi_fixture',status:'succeeded',latest_charge:payment.id});
  if(method==='GET'&&u.pathname==='/v1/charges/ch_fixture')return json(payment);
  if(method==='GET'&&u.pathname==='/v1/refunds'){const after=u.searchParams.get('starting_after');const start=after?refunds.findIndex(r=>r.id===after)+1:0;return json({data:refunds.slice(start,start+options.pageSize),has_more:start+options.pageSize<refunds.length});}
  if(method==='POST'&&u.pathname==='/v1/refunds'){
   const body=new URLSearchParams(init.body),key=new Headers(init.headers).get('Idempotency-Key');
   if(!key||body.get('metadata[jarvis_refund_key]')!==key)throw Error('Missing refund idempotency identity');
   if(options.rejectWrite)throw Error('Synthetic disconnected write');
   if(options.answerWrite)return json(options.answerWrite.body,options.answerWrite.status);
   const old=refunds.find(r=>r.metadata.jarvis_refund_key===key);if(old)return json(old);
   const r={id:'re_fixture'+(refunds.length+1),charge:body.get('charge'),amount:Number(body.get('amount')),currency:payment.currency,status:options.status,metadata:{jarvis_refund_key:key}};
   refunds.push(r);payment.amount_refunded+=r.amount;if(options.loseReply)throw Error('Synthetic reply loss after provider commit');return json(r);
  }
  throw Error('Fixture refused unexpected operation '+method+' '+u.pathname);
 }) as typeof fetch;
 return {fetchImpl,calls,payment,refunds,options};
}
/** Local deterministic component fixtures. No connections, credentials, queues or fetch
 * are read. Unsupported graph shapes fail, rather than claiming unrelated steps tested. */
export async function validateRefundFixtures(trigger:any){
 const action=trigger?.nextAction;
 if(trigger?.type!=='PIECE_TRIGGER'||trigger?.settings?.pieceName!=='webhook'||action?.type!=='PIECE'||action.settings?.pieceName!==REFUND_PIECE||action.settings.actionName!==REFUND_ACTION||action.nextAction||trigger.firstLoopAction||action.firstLoopAction||action.children||action.settings.input?.ticket!=='{{trigger}}')throw Error('Fixture suite supports webhook -> approval_refund with ticket={{trigger}} only; additional graph behavior is untested');
 const cases:Array<{name:string;passed:boolean}>=[];
 const assert=(value:unknown,label:string)=>{if(!value)throw Error('Refund fixture failed: '+label);};
 const run=async(name:string,change:(f:ReturnType<typeof refundFixtureProvider>)=>void,expected:string)=>{
  const f=refundFixtureProvider(),s=refundSetup(refundFixtureSetup),t=refundTicket(s,refundFixtureTicket)!;
  const provider=refundTransport(s,'synthetic-fixture-token',()=>{},f.fetchImpl);
  let state:RefundState={originRun:'fixture',state:'approval',proposal:await proposeRefund(s,t,provider,1000)};
  const store:RefundStore={load:()=>structuredClone(state),save:s=>{state=structuredClone(s);},check:()=>{}};
  change(f);const first=await dispatchApprovedRefund(store,provider,'fixture-key',2000,()=>{});assert(first.state===expected,name);
  if(first.attemptedAt!==undefined){await dispatchApprovedRefund(store,provider,'fixture-key',3*86400000,()=>{});assert(f.calls.filter(c=>c.method==='POST').length===1,'no replay after idempotency expiry');}
  cases.push({name,passed:true});
 };
 await run('approved exact amount and persistent receipt',()=>{},'refunded');
 await run('lost reply reconciles without another POST',f=>{f.options.loseReply=true;},'refunded');
 await run('unknown delivery stays for review',f=>{f.options.rejectWrite=true;},'needs_review');
 await run('changed balance stops refund',f=>{f.payment.amount_refunded=1;},'needs_review');
 await run('provider pending is not reported refunded',f=>{f.options.status='pending';},'pending_provider');
 const s=refundSetup(refundFixtureSetup);assert(refundTicket(s,{...refundFixtureTicket,kind:'support'})===null,'non-refund ticket skipped');
 cases.push({name:'non-refund tickets skipped',passed:true});
 for(const amount of [0,-1,1.5,'1200',Number.MAX_SAFE_INTEGER+1]){let rejected=false;try{refundTicket(s,{...refundFixtureTicket,amount});}catch{rejected=true;}assert(rejected,'invalid amount');}
 cases.push({name:'invalid amounts rejected',passed:true});
 for(const [name,decision,now,expected] of [
  ['no refund before approval',null,99,'pending'],
  ['rejection ends request',{status:'denied',decided_at:50},99,'rejected'],
  ['deadline boundary expires pending request',null,100,'expired'],
  ['late approval is refused',{status:'approved',decided_at:100},101,'expired'],
  ['on-time approval remains bound after restart',{status:'approved',decided_at:99},101,'approved'],
 ] as const){assert(refundDecision(100,decision,now)===expected,name);cases.push({name,passed:true});}
 return {passed:true,definitionDigest:digest(trigger),cases,externalActions:0,scope:'Synthetic component fixtures for the installed refund action and supported graph shape. Approval UI, durable database wait/resume, real account access and ticket integration are not exercised by this tool suite; tested separately by repository engine integration tests.',configuration:'Synthetic setup substituted in memory only; saved workflow unchanged'};
}
