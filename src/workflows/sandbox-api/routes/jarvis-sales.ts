import { json, err, parseJsonObject, type RouteHandler } from './shared';
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext } from '../../runtime/effect-context';
export type SalesFollowupsFn = (input: Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createSalesFollowupsRoute(deps:{salesFollowups?:SalesFollowupsFn}):RouteHandler {
  return async ctx=>{
    if(!deps.salesFollowups)return err('Sales draft preparation unavailable',503);
    const input=await parseJsonObject(ctx);if(input instanceof Response)return input;
    const result=await deps.salesFollowups(input,workflowEffectContext(ctx)) as any;
    return json(result,result?.approval?202:200);
  };
}
