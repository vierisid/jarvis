import {atPath} from './contact-import';
export const REFUND_PIECE='@jarvispieces/piece-jarvis-refund';
export const REFUND_ACTION='approval_refund';
export const REFUND_REQUIRED=['stripeConnection','stripeAccountId','stripeMode','ticketSource','ticketIdPath','paymentIdPath','refundRequestedPath','refundRequestedValue','ticket'] as const;
export const REFUND_TTL=48*60*60_000;
export interface RefundSetup {stripeConnection:string;stripeAccountId:string;stripeMode:'test'|'live';ticketSource:string;ticketIdPath:string;paymentIdPath:string;refundRequestedPath:string;refundRequestedValue:string;amountMinorPath:string}
export function refundSetup(v:Record<string,unknown>):RefundSetup {
  const text=(k:string,re:RegExp)=>{const x=v[k];if(typeof x!=='string'||x.length>200||!re.test(x))throw Error('Configure '+k);return x;};
  const path=(k:string)=>{const x=text(k,/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*$/);if(x.split('.').some(p=>['__proto__','prototype','constructor'].includes(p)))throw Error('Invalid field path');return x;};
  return {stripeConnection:text('stripeConnection',/^[\w:-]+$/),stripeAccountId:text('stripeAccountId',/^acct_[a-zA-Z0-9]+$/),stripeMode:text('stripeMode',/^(test|live)$/) as 'test'|'live',ticketSource:text('ticketSource',/\S/),ticketIdPath:path('ticketIdPath'),paymentIdPath:path('paymentIdPath'),refundRequestedPath:path('refundRequestedPath'),refundRequestedValue:text('refundRequestedValue',/\S/),amountMinorPath:v.amountMinorPath?path('amountMinorPath'):''};
}
export function refundTicket(s:RefundSetup,ticket:unknown){
  const flag=atPath(ticket,s.refundRequestedPath);
  if(!['string','boolean','number'].includes(typeof flag)||String(flag)!==s.refundRequestedValue)return null;
  const id=atPath(ticket,s.ticketIdPath),payment=atPath(ticket,s.paymentIdPath),amount=s.amountMinorPath?atPath(ticket,s.amountMinorPath):undefined;
  if(typeof id!=='string'||!id.trim()||id.length>300)throw Error('Ticket must have a stable ID');
  if(typeof payment!=='string'||!/^(ch|pi)_[a-zA-Z0-9]+$/.test(payment))throw Error('Ticket must identify one exact Stripe charge or PaymentIntent');
  if(s.amountMinorPath&&(!Number.isSafeInteger(amount)||Number(amount)<=0))throw Error('Requested refund amount must be a positive integer in minor units');
  return {ticketId:id.trim(),paymentId:payment,amount:amount as number|undefined};
}
export interface RefundPayment {id:string;currency:string;amount:number;refunded:number;paid:boolean;captured:boolean;disputed:boolean;live:boolean}
export interface RefundReceipt {id:string;charge:string;currency:string;amount:number;status:string;key:string}
export interface RefundProvider {payment(id:string):Promise<RefundPayment>;refunds(charge:string):Promise<RefundReceipt[]>;create(charge:string,amount:number,key:string):Promise<RefundReceipt>}
export interface RefundProposal {ticketId:string;ticketSource:string;account:string;mode:'test'|'live';charge:string;currency:string;amount:number;refunded:number;expiresAt:number}
export interface RefundState {proposal?:RefundProposal;approvalId?:string;originRun:string;state:'new'|'approval'|'dispatching'|'refunded'|'pending_provider'|'rejected'|'expired'|'needs_review';attemptedAt?:number;receipt?:RefundReceipt;reason?:string;retiredRuns?:string[]}
export interface RefundStore {load():RefundState;save(state:RefundState):void;check():void}
// Stripe minor-unit exponents that differ from 2 (docs.stripe.com/currencies).
const ZERO_DECIMAL=new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf']);
const THREE_DECIMAL=new Set(['bhd','jod','kwd','omr','tnd']);
/** The amount an approver reads in major units, beside the exact minor-unit value sent to Stripe. */
export function refundMajorAmount(amount:number,currency:string){
  const exp=ZERO_DECIMAL.has(currency)?0:THREE_DECIMAL.has(currency)?3:2,scale=10**exp;
  const whole=Math.floor(amount/scale),frac=String(amount%scale).padStart(exp,'0');
  return currency.toUpperCase()+' '+whole+(exp?'.'+frac:'');
}
/** Ticket ID and source come from the event and setup: quoted, so they cannot rewrite the sentence. */
const quoted=(v:string)=>JSON.stringify(v).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export function refundIntent(p:RefundProposal){
  return `Refund ${refundMajorAmount(p.amount,p.currency)} (${p.amount} minor units ${p.currency.toUpperCase()}) from ${p.charge}, account ${p.account} (${p.mode}), for ${quoted(p.ticketSource)} ticket ${quoted(p.ticketId)}. Approve before ${new Date(p.expiresAt).toISOString()}.`;
}
export function refundDecision(expiresAt:number,decision:{status:string;decided_at:number|null}|null,now:number):'approved'|'pending'|'rejected'|'expired' {
  if(decision?.status==='denied')return 'rejected';
  if(decision?.status==='expired')return 'expired';
  if(decision?.status==='approved')return decision.decided_at!==null&&decision.decided_at<expiresAt?'approved':'expired';
  return now>=expiresAt?'expired':'pending';
}
function assertPayment(p:RefundPayment,mode:'test'|'live'){
  if(!/^ch_[a-zA-Z0-9]+$/.test(p.id)||!/^[a-z]{3}$/.test(p.currency)||!Number.isSafeInteger(p.amount)||!Number.isSafeInteger(p.refunded)||p.refunded<0||p.amount<=p.refunded||!p.paid||!p.captured||p.disputed||p.live!==(mode==='live'))throw Error('Payment is not a captured, undisputed, refundable payment in the selected mode');
}
export async function proposeRefund(s:RefundSetup,t:NonNullable<ReturnType<typeof refundTicket>>,provider:RefundProvider,now:number):Promise<RefundProposal>{
  const p=await provider.payment(t.paymentId);assertPayment(p,s.stripeMode);
  const existing=await provider.refunds(p.id);
  if(existing.some(r=>!['succeeded','failed','canceled'].includes(r.status)))throw Error('Payment has an unresolved refund; review it before proposing another');
  const amount=t.amount??p.amount-p.refunded;
  if(!Number.isSafeInteger(amount)||amount<=0||amount>p.amount-p.refunded)throw Error('Requested amount exceeds the refundable balance');
  return {ticketId:t.ticketId,ticketSource:s.ticketSource,account:s.stripeAccountId,mode:s.stripeMode,charge:p.id,currency:p.currency,amount,refunded:p.refunded,expiresAt:now+REFUND_TTL};
}
function receiptMatches(r:RefundReceipt,p:RefundProposal,key:string){return /^re_[a-zA-Z0-9]+$/.test(r.id)&&r.key===key&&r.charge===p.charge&&r.currency===p.currency&&r.amount===p.amount;}
/** No automatic second POST, even beyond Stripe's idempotency retention window.
 * A lost response is reconciled by our persistent metadata key, across all pages. */
export async function dispatchApprovedRefund(store:RefundStore,provider:RefundProvider,key:string,now:number,checkpoint:()=>void){
  const state=store.load(),p=state.proposal;if(!p)throw Error('Missing immutable refund proposal');
  const save=(next:RefundState)=>{store.check();store.save(next);return next;};
  const finish=(r:RefundReceipt)=>{
    if(!receiptMatches(r,p,key))return save({...state,state:'needs_review',reason:'Provider refund receipt does not match the approved proposal'});
    return save({...state,receipt:r,state:r.status==='succeeded'?'refunded':['pending','requires_action'].includes(r.status)?'pending_provider':'needs_review',reason:r.status==='succeeded'?undefined:'Provider refund status: '+r.status});
  };
  checkpoint();store.check();
  if(state.attemptedAt!==undefined){
    const matches=(await provider.refunds(p.charge)).filter(r=>r.key===key);checkpoint();
    return matches.length===1?finish(matches[0]!):save({...state,state:'needs_review',reason:'Previous refund dispatch remains uncertain; no second refund was sent'});
  }
  const fresh=await provider.payment(p.charge);assertPayment(fresh,p.mode);
  const existing=await provider.refunds(p.charge);checkpoint();store.check();
  if(fresh.id!==p.charge||fresh.currency!==p.currency||fresh.refunded!==p.refunded||p.amount>fresh.amount-fresh.refunded||existing.some(r=>!['succeeded','failed','canceled'].includes(r.status)))return save({...state,state:'needs_review',reason:'Payment changed after approval; no refund sent'});
  // This durable transition precedes the only mutating provider operation.
  state.attemptedAt=now;state.state='dispatching';save(state);checkpoint();
  try {return finish(await provider.create(p.charge,p.amount,key));}
  catch {const matches=(await provider.refunds(p.charge)).filter(r=>r.key===key);checkpoint();return matches.length===1?finish(matches[0]!):save({...state,state:'needs_review',reason:'Refund delivery uncertain; no automatic second dispatch'});}
}
