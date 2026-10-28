import {json,err,parseJsonObject,type RouteHandler} from './shared';
import {workflowEffectContext} from './effect-context';
import type {WorkflowEffectContext} from '../../runtime/effect-context';
export type LeadBatchFn=(input:Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createLeadBatchRoute(deps:{leadBatch?:LeadBatchFn}):RouteHandler {
 return async ctx=>{if(!deps.leadBatch)return err('Lead batch unavailable',503);const input=await parseJsonObject(ctx);if(input instanceof Response)return input;
 const result=await deps.leadBatch(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval||result?.waitpointId?202:200);};
}
