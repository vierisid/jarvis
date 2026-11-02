import {json,err,parseJsonObject,type RouteHandler} from './shared';
import {workflowEffectContext} from './effect-context';
import type {WorkflowEffectContext} from '../../runtime/effect-context';
export type ApprovalRefundFn=(input:Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createApprovalRefundRoute(deps:{approvalRefund?:ApprovalRefundFn}):RouteHandler {
  return async ctx=>{if(!deps.approvalRefund)return err('Refund coordinator unavailable',503);const input=await parseJsonObject(ctx);if(input instanceof Response)return input;const result=await deps.approvalRefund(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval||result?.waitpointId?202:200);};
}
