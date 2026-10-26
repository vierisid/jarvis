import {json,err,parseJsonObject,type RouteHandler} from './shared';
import {workflowEffectContext} from './effect-context';
import type {WorkflowEffectContext} from '../../runtime/effect-context';
export type ContactImportFn=(input:Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createContactImportRoute(deps:{contactImport?:ContactImportFn}):RouteHandler {
  return async ctx=>{if(!deps.contactImport)return err('Contact importer unavailable',503);const input=await parseJsonObject(ctx);if(input instanceof Response)return input;const result=await deps.contactImport(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval||result?.waitpointId?202:200);};
}
