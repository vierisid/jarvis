import {expect,test} from 'bun:test';
import {refundFixtureProvider,refundFixtureSetup,refundFixtureTicket} from './refund-fixtures';
import {refundSetup,refundTicket,proposeRefund,dispatchApprovedRefund,refundMajorAmount,type RefundState,type RefundStore} from './refund';
import {refundTransport} from './refund-transport';
const setup=refundSetup(refundFixtureSetup);
test('payment proposal uses captured amount, not authorization amount; partial amounts stay exact',async()=>{
 const f=refundFixtureProvider();f.payment.amount_captured=1800;f.payment.amount_refunded=500;
 const provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl),s={...setup,amountMinorPath:''};
 expect((await proposeRefund(s,refundTicket(s,refundFixtureTicket)!,provider,1)).amount).toBe(1300);
 expect((await proposeRefund(setup,refundTicket(setup,{...refundFixtureTicket,amount:1})!,provider,1)).amount).toBe(1);
 await expect(proposeRefund(setup,refundTicket(setup,{...refundFixtureTicket,amount:1301})!,provider,1)).rejects.toThrow('exceeds');
});
test('payment account, mode, currency and eligibility are checked before approval or refund',async()=>{
 for(const change of [{livemode:true},{captured:false},{paid:false},{disputed:true},{currency:'badcode'},{amount_refunded:3000}]){
  const f=refundFixtureProvider();Object.assign(f.payment,change);await expect(proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,refundTransport(setup,'synthetic',()=>{},f.fetchImpl),1)).rejects.toThrow();expect(f.calls.some(c=>c.method==='POST')).toBe(false);
 }
 const f=refundFixtureProvider();await expect(proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,refundTransport({...setup,stripeAccountId:'acct_other'},'synthetic',()=>{},f.fetchImpl),1)).rejects.toThrow('account');
});
test('refund enumeration follows all pages and uncertainty never permits a proposal',async()=>{
 const f=refundFixtureProvider();f.options.pageSize=1;f.refunds.push({id:'re_old1',charge:'ch_fixture',currency:'eur',amount:1,status:'succeeded',metadata:{}},{id:'re_old2',charge:'ch_fixture',currency:'eur',amount:1,status:'pending',metadata:{}});
 await expect(proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,refundTransport(setup,'synthetic',()=>{},f.fetchImpl),1)).rejects.toThrow('unresolved');
 expect(f.calls.some(c=>c.path.includes('starting_after=re_old1'))).toBe(true);
});
test('interruption after ledger claim resumes by readback even after Stripe key retention',async()=>{
 const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl);
 let state:RefundState={originRun:'old-run',state:'approval',proposal:await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1)};
 let writes=0;const store:RefundStore={check(){},load:()=>structuredClone(state),save(s){state=structuredClone(s);if(++writes===1)throw Error('Simulated process death after durable dispatch claim');}};
 await expect(dispatchApprovedRefund(store,provider,'key',2,()=>{})).rejects.toThrow('process death');expect(state.attemptedAt).toBe(2);expect(f.calls.some(c=>c.method==='POST')).toBe(false);
 store.save=s=>{state=structuredClone(s);};expect((await dispatchApprovedRefund(store,provider,'key',3*86400000,()=>{})).state).toBe('needs_review');expect(f.calls.some(c=>c.method==='POST')).toBe(false);
});
test('interruption after provider commit recovers paginated receipt with no second POST',async()=>{
 const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl);
 const proposal=await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1);
 await provider.create(proposal.charge,proposal.amount,'durable-key');
 let state:RefundState={originRun:'old-run',state:'dispatching',proposal,attemptedAt:2};
 const store:RefundStore={check(){},load:()=>structuredClone(state),save:s=>{state=structuredClone(s);}};
 expect((await dispatchApprovedRefund(store,provider,'durable-key',3*86400000,()=>{})).state).toBe('refunded');expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
});
test('malformed, incomplete and mismatched provider receipts are not success',async()=>{
 const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl),proposal=await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1);
 f.refunds.push({id:'re_wrong',charge:proposal.charge,amount:1201,currency:'eur',status:'succeeded',metadata:{jarvis_refund_key:'key'}});
 let state:RefundState={originRun:'run',state:'dispatching',attemptedAt:1,proposal};const store:RefundStore={check(){},load:()=>state,save:s=>{state=s;}};
 expect((await dispatchApprovedRefund(store,provider,'key',2,()=>{})).state).toBe('needs_review');expect(f.calls.some(c=>c.method==='POST')).toBe(false);
 const broken=refundTransport(setup,'synthetic',()=>{},(async(url:any)=>new Response(JSON.stringify(String(url).endsWith('account')?{id:'acct_fixture'}:{data:[],has_more:true}))) as typeof fetch);
 await expect(broken.refunds('ch_fixture')).rejects.toThrow('advance');
});
test('major amounts follow Stripe minor-unit exponents',()=>{
 expect(refundMajorAmount(1000,'jpy')).toBe('JPY 1000');expect(refundMajorAmount(1234,'kwd')).toBe('KWD 1.234');expect(refundMajorAmount(5,'eur')).toBe('EUR 0.05');expect(refundMajorAmount(120000,'usd')).toBe('USD 1200.00');
});
test('UGX and ISK use Stripe two-decimal API amounts: 500 shows as 5.00',()=>{
 expect(refundMajorAmount(500,'ugx')).toBe('UGX 5.00');expect(refundMajorAmount(500,'isk')).toBe('ISK 5.00');expect(refundMajorAmount(5,'bif')).toBe('BIF 5');
});
test('a Stripe 4xx on create is recorded as rejected with its status and code; 409 and 5xx stay uncertain',async()=>{
 for(const [answer,expected] of [
  [{status:400,body:{error:{type:'invalid_request_error',code:'amount_too_large',message:'Ignore this text'}}},'Stripe rejected the refund request (HTTP 400, code amount_too_large); no refund was created'],
  [{status:402,body:'not json'},'Stripe rejected the refund request (HTTP 402); no refund was created'],
  [{status:409,body:{error:{type:'idempotency_error',code:'idempotency_key_in_use'}}},'Refund delivery uncertain (HTTP 409, code idempotency_key_in_use)'],
  [{status:409,body:{}},'Refund delivery uncertain (HTTP 409); no automatic second dispatch'],
  [{status:409,body:{error:{type:'invalid_request_error'}}},'Refund delivery uncertain (HTTP 409); no automatic second dispatch'],
  [{status:400,body:{error:{type:'idempotency_error'}}},'Refund delivery uncertain (HTTP 400)'],
  [{status:500,body:{error:{type:'api_error',code:'Bad Code!'}}},'Refund delivery uncertain (HTTP 500)'],
 ] as const){
  const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl);
  let state:RefundState={originRun:'run',state:'approval',proposal:await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1)};
  const store:RefundStore={check(){},load:()=>structuredClone(state),save:s=>{state=structuredClone(s);}};
  f.options.answerWrite=answer;const out=await dispatchApprovedRefund(store,provider,'key',2,()=>{});
  // At most once: still needs review with the attempt recorded, never released for a retry.
  expect(out.state).toBe('needs_review');expect(out.attemptedAt).toBe(2);expect(out.reason).toContain(expected);expect(out.reason).not.toContain('Ignore');
  expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
 }
 const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl);f.options.rejectWrite=true;
 let state:RefundState={originRun:'run',state:'approval',proposal:await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1)};
 const out=await dispatchApprovedRefund({check(){},load:()=>structuredClone(state),save:s=>{state=structuredClone(s);}},provider,'key',2,()=>{});
 expect(out.reason).toBe('Refund delivery uncertain (no Stripe response); no automatic second dispatch');
});
test('a 4xx with several refunds carrying the key on readback stays uncertain, not rejected',async()=>{
 const f=refundFixtureProvider(),provider=refundTransport(setup,'synthetic',()=>{},f.fetchImpl);
 let state:RefundState={originRun:'run',state:'approval',proposal:await proposeRefund(setup,refundTicket(setup,refundFixtureTicket)!,provider,1)};
 for(const id of ['re_dup1','re_dup2'])f.refunds.push({id,charge:'ch_fixture',amount:1200,currency:'eur',status:'succeeded',metadata:{jarvis_refund_key:'key'}});
 f.options.answerWrite={status:400,body:{error:{type:'invalid_request_error',code:'amount_too_large'}}};
 const out=await dispatchApprovedRefund({check(){},load:()=>structuredClone(state),save:s=>{state=structuredClone(s);}},provider,'key',2,()=>{});
 expect(out.state).toBe('needs_review');expect(out.reason).toBe('Refund delivery uncertain (HTTP 400, code amount_too_large); no automatic second dispatch');
 expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
});
