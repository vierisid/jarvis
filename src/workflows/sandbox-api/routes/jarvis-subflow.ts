import {json,err,parseJsonObject,type RouteHandler} from './shared';
import {workflowEffectContext} from './effect-context';
import type {WorkflowEffectContext} from '../../runtime/effect-context';
export type SubflowFn=(input:Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createSubflowRoute(deps:{subflowCall?:SubflowFn;subflowResult?:SubflowFn},operation:'call'|'result'):RouteHandler {
 return async ctx=>{const service=operation==='call'?deps.subflowCall:deps.subflowResult;if(!service)return err('Reusable workflows unavailable',503);
 const input=await parseJsonObject(ctx);if(input instanceof Response)return input;
 const result=await service(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval||result?.waitpointId?202:200);};
}
