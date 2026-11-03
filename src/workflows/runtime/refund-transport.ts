import {RefundProviderError,type RefundProvider,type RefundReceipt,type RefundSetup} from './refund';
const RESPONSE_LIMIT=2*1024*1024;
/** The body as text, read with a running byte cap: null (and the stream cancelled) once it passes `max` bytes,
 * so an oversized reply is never buffered whole. */
async function readCapped(r:Response,max:number):Promise<string|null>{
  const reader=r.body?.getReader();if(!reader)return '';let size=0;const chunks:Uint8Array[]=[];
  for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>max){await reader.cancel();return null;}chunks.push(n.value);}
  return Buffer.concat(chunks).toString('utf8');
}
/** Fixed Stripe endpoints only. All amounts are integer minor units. */
export function refundTransport(s:RefundSetup,token:string,checkpoint:()=>void,fetchImpl:typeof fetch=fetch):RefundProvider {
  const request=async(path:string,body?:URLSearchParams,key?:string)=>{
    checkpoint();const r=await fetchImpl('https://api.stripe.com/v1/'+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Stripe-Version':'2024-06-20',...(body?{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':key!}:{})},body:body?.toString()});
    if(!r.ok){
      // Only short identifier-shaped code/type values are kept; the message text is never stored.
      let code:string|undefined,type:string|undefined;
      try{const t=await readCapped(r,64*1024);if(t!==null){const e=JSON.parse(t)?.error;const id=(v:unknown)=>typeof v==='string'&&/^[a-z0-9_]{1,64}$/.test(v)?v:undefined;code=id(e?.code);type=id(e?.type);}}catch{}
      throw new RefundProviderError(r.status,code,type);
    }
    const text=await readCapped(r,RESPONSE_LIMIT);if(text===null)throw Error('Stripe response exceeds 2 MiB');const value=JSON.parse(text);checkpoint();return value;
  };
  const account=async()=>{const a=await request('account');if(a.id!==s.stripeAccountId)throw Error('Stripe account does not match setup');};
  const receipt=(r:any):RefundReceipt=>({id:r.id,charge:r.charge,currency:r.currency,amount:r.amount,status:r.status,key:r.metadata?.jarvis_refund_key});
  return {
    async payment(id){await account();let charge=id;if(id.startsWith('pi_')){const p=await request('payment_intents/'+encodeURIComponent(id));if(p.id!==id||p.status!=='succeeded'||typeof p.latest_charge!=='string')throw Error('PaymentIntent is not settled');charge=p.latest_charge;}
      if(!/^ch_[a-zA-Z0-9]+$/.test(charge))throw Error('Invalid charge');const p=await request('charges/'+encodeURIComponent(charge));if(p.id!==charge||['paid','captured','disputed','livemode'].some(k=>typeof p[k]!=='boolean'))throw Error('Charge identity or status is incomplete');return {id:p.id,currency:p.currency,amount:p.amount_captured,refunded:p.amount_refunded,paid:p.paid,captured:p.captured,disputed:p.disputed,live:p.livemode};},
    async refunds(charge){await account();const all:RefundReceipt[]=[],seen=new Set<string>();let cursor='';for(let page=0;page<200;page++){const q=new URLSearchParams({charge,limit:'100',...(cursor?{starting_after:cursor}:{})});const r=await request('refunds?'+q);if(!Array.isArray(r.data)||typeof r.has_more!=='boolean')throw Error('Malformed refund page');for(const row of r.data){if(typeof row.id!=='string'||seen.has(row.id)||row.charge!==charge)throw Error('Invalid or repeated refund record');seen.add(row.id);all.push(receipt(row));}if(!r.has_more)return all;const last=r.data.at(-1)?.id;if(!last||last===cursor)throw Error('Refund pagination did not advance');cursor=last;}throw Error('Refund enumeration incomplete; review required');},
    // No account read here: dispatchApprovedRefund checks the account (through payment()) before it saves
    // attemptedAt, so nothing but the POST itself runs after the claim and a revoked token cannot strand the ticket.
    async create(charge,amount,key){const body=new URLSearchParams({charge,amount:String(amount),'metadata[jarvis_refund_key]':key});return receipt(await request('refunds',body,key));},
  };
}
