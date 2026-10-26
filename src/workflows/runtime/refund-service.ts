import {randomUUID} from 'node:crypto';
import {ApprovalManager} from '../../authority/approval';
import {REFUND_ACTION,REFUND_PIECE,refundSetup,refundTicket,proposeRefund,dispatchApprovedRefund,refundDecision,refundIntent,type RefundState} from './refund';
import {refundTransport} from './refund-transport';
import {acquireRefund,reserveRefundPayment,releaseRefundPayment} from '../db/repos/refund';
import {currentConnectionIdentity,connectionBindings,enforceRunConnectionBinding} from '../db/repos/binding-pins';
import {createWaitpoint} from '../db/repos/waitpoint';
import {walkFlowNodes} from '../db/flow-graph';
import {getWorkflowEffect,saveWorkflowEffect} from '../db/repos/workflow-effect';
import {digest,resolveEffectContext,type WorkflowEffectContext} from './effect-context';
import {workflowEffectId,type WorkflowEffectBoundary} from './effect-boundary';
import type {CredentialResolver} from '../credentials/adapter';
export function createRefundService(deps:{effects:WorkflowEffectBoundary;credentials:CredentialResolver;fetchImpl?:typeof fetch;now?:()=>number}){
 return async(input:Record<string,unknown>,ctx:WorkflowEffectContext)=>{
  const s=refundSetup(input),t=refundTicket(s,input.ticket),resolved=resolveEffectContext(ctx,REFUND_PIECE,REFUND_ACTION);
  const node=walkFlowNodes(resolved.version.trigger).find(n=>n.name===ctx.stepName)!;
  if(digest(refundSetup(node.settings?.input??{}))!==digest(s))throw Error('Refund setup must match the saved workflow');
  if(!t)return {status:'skipped',reason:'Ticket does not match the configured refund filter'};
  const clock=deps.now??Date.now,approvals=new ApprovalManager();approvals.expireDeadlines(clock());
  const binding=currentConnectionIdentity(ctx.projectId,s.stripeConnection,deps.credentials);
  const key=digest(['refund-v1',ctx.projectId,s.stripeAccountId,s.stripeMode,s.ticketSource,t.ticketId]);
  const acquired=acquireRefund(key,digest([s,t,binding]),randomUUID(),ctx.runId,clock);
  const park=(at:number)=>({waitpointId:createWaitpoint({flowRunId:ctx.runId,projectId:ctx.projectId,stepName:resolved.stepName,type:'TIMER',resumeDateTime:new Date(at).toISOString()}).id});
  if('busyUntil'in acquired)return park(acquired.busyUntil);
  try {
   const store=acquired.store;let state=store.load();
   const effectFor=(run:string)=>workflowEffectId(run,resolved.stepName,resolved.executionPath,'approved-refund');
   // A newer run or changed ticket data replaced a request that never reached dispatch: its card can no longer run.
   // The request may hold '' (an APPROVALS_WAITING hold) while its effect has the real card, so both are withdrawn.
   // A failed withdrawal is kept on the request and retried on its next invocation, including after a restart.
   const sup=acquired.superseded,stale=[...(state.withdraw??[]),...(sup?[sup.approvalId,getWorkflowEffect(effectFor(sup.originRun))?.approvalId]:[])].filter((a):a is string=>!!a);
   if(stale.length){
    const failed=[...new Set(stale)].filter(a=>{try{approvals.deny(a,'refund-superseded');return false;}catch(e){console.warn('[refund] could not withdraw superseded approval '+a+'; retrying on the next invocation:',e);return true;}});
    if(failed.length)state.withdraw=failed;else delete state.withdraw;store.save(state);
   }
   const result=(st:RefundState)=>{
    // Ended before the pre-dispatch claim: the charge is free for another request again.
    if(st.attemptedAt===undefined&&['rejected','expired','needs_review'].includes(st.state))releaseRefundPayment(key);
    return {requestId:key,status:st.state,proposal:st.proposal,refund:st.receipt,reason:st.reason};
   };
   if(['refunded','pending_provider','rejected','expired','needs_review'].includes(state.state))return result(state);
   const provider=async(checkpoint:()=>void)=>{
    const check=()=>{checkpoint();store.check();const refusal=enforceRunConnectionBinding(ctx.runId,ctx.projectId,s.stripeConnection,deps.credentials);if(refusal)throw Error(refusal);};
    check();if(s.stripeConnection.startsWith('jarvis:')||!connectionBindings(resolved.version.trigger).has(s.stripeConnection))throw Error('Select a saved Stripe account');
    const c=await deps.credentials.resolve({projectId:ctx.projectId,pieceName:'@activepieces/piece-stripe',externalId:s.stripeConnection});
    const token=c?.type==='SECRET_TEXT'?c.value.secret_text:c?.type==='OAUTH2'?c.value.access_token:null;
    if(!c||c.pieceName!=='@activepieces/piece-stripe'||c.status&&c.status!=='ACTIVE'||typeof token!=='string'||!token)throw Error('Connect the selected Stripe account securely');
    return refundTransport(s,token,check,deps.fetchImpl);
   };
   const invocation={context:ctx,piece:REFUND_PIECE,action:REFUND_ACTION,toolCategory:'refunds'};
   if(!state.proposal){
    const read=await deps.effects.invoke({...invocation,route:'refund-proposal',toolName:'workflow_refund_proposal',category:'read_data',request:{...s,...t},prepare:()=>({arguments:{...s,...t},target:{account:s.stripeAccountId,payment:t.paymentId,effect:'Read exact payment and existing refunds to propose an amount; no payment mutation'}}),execute:async(_args,check)=>proposeRefund(s,t,await provider(check),clock())});
    if(read.approval)return {approval:read.approval};
    state.proposal=read.result as RefundState['proposal'];state.state='approval';store.save(state);
    // Reserve the actual charge, so different ticket IDs/PaymentIntent aliases cannot race.
    if(!reserveRefundPayment(digest([ctx.projectId,s.stripeAccountId,s.stripeMode,state.proposal!.charge]),key)){
      state.state='needs_review';state.reason='Another refund request already owns this payment';store.save(state);return result(state);
    }
   }
   // A crash between proposal persistence and reservation must not bypass the reservation.
   if(!reserveRefundPayment(digest([ctx.projectId,s.stripeAccountId,s.stripeMode,state.proposal!.charge]),key))throw Error('Payment belongs to another refund request');
   const effectId=effectFor(state.originRun);
   // ||= so an '' saved from an APPROVALS_WAITING hold is replaced by the card the effect now holds.
   const previous=getWorkflowEffect(effectId);state.approvalId||=previous?.approvalId||undefined;store.save(state);
   const approval=state.approvalId?approvals.getRequest(state.approvalId):null;
   const decisionState=refundDecision(state.proposal!.expiresAt,approval,clock());
   if(state.attemptedAt===undefined&&(decisionState==='rejected'||decisionState==='expired')){
    state.state=decisionState;store.save(state);
    if(previous?.status==='pending'){previous.status='blocked';previous.decision='denied';previous.finishedAt=clock();previous.error='Refund request '+state.state;previous.outcome={status:'blocked',code:state.state==='expired'?'APPROVAL_EXPIRED':'APPROVAL_DENIED',message:previous.error,effect:'not_started'};saveWorkflowEffect(previous);}
    return result(state);
   }
   if(state.originRun!==ctx.runId){
    if(state.attemptedAt===undefined)return {requestId:key,status:'duplicate',reason:'The original request owns the approval; no new refund or approval created'};
    // A new run may only reconcile a prior attempt. It can never make a second POST.
    const read=await deps.effects.invoke({...invocation,route:'refund-reconcile',toolName:'workflow_refund_reconcile',category:'read_data',request:{key},prepare:()=>({arguments:{key},target:{effect:'Read prior refund receipt only'}}),execute:async(_args,check)=>dispatchApprovedRefund(store,await provider(check),key,clock(),check)});
    return read.approval?{approval:read.approval}:result(read.result as RefundState);
   }
   if(previous?.status==='dispatching'&&state.attemptedAt!==undefined){previous.status='pending';delete previous.error;delete previous.outcome;saveWorkflowEffect(previous);}
   const p=state.proposal!;
   const intent=refundIntent(p);
   const reply=await deps.effects.invoke({...invocation,route:'approved-refund',toolName:'workflow_approved_refund',category:'make_payment',categories:['read_data','make_payment'],request:{...p,key},approvalRequired:true,approvalExpiresAt:p.expiresAt,aboveLevelFloor:'write_data',
    confirmation:{confirm:'always',reason:'Explicit approval of this exact refund is required',intent},
    prepare:()=>({arguments:{...p,key},target:{...p,intent,effect:'Issue exactly one refund to the original payment method; no customer contact'}}),
    execute:async(_args,check)=>{
      const a=getWorkflowEffect(effectId)?.approvalId;const decision=a?approvals.getRequest(a):null;
      if(refundDecision(p.expiresAt,decision,clock())!=='approved')throw Error('Refund approval is absent or late');
      return dispatchApprovedRefund(store,await provider(check),key,clock(),check);
    }});
   if(reply.approval){state=store.load();state.approvalId=reply.approval.approvalId;store.save(state);return {approval:reply.approval};}
   return result(reply.result as RefundState);
  } finally {acquired.release();}
 };
}
