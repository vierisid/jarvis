import {json,err,parseJsonObject,type RouteHandler} from './shared';
import {workflowEffectContext} from './effect-context';
import type {WorkflowEffectContext} from '../../runtime/effect-context';
export type WeeklyReportFn=(input:Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createWeeklyReportRoute(deps:{weeklyReport?:WeeklyReportFn}):RouteHandler {
  return async ctx=>{if(!deps.weeklyReport)return err('Weekly reporting unavailable',503);const input=await parseJsonObject(ctx);if(input instanceof Response)return input;const result=await deps.weeklyReport(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval?202:200);};
}

export function createQuarterlyReportRoute(deps:{quarterlyReport?:WeeklyReportFn}):RouteHandler {
  return async ctx=>{if(!deps.quarterlyReport)return err('Quarterly reporting unavailable',503);const input=await parseJsonObject(ctx);if(input instanceof Response)return input;const result=await deps.quarterlyReport(input,workflowEffectContext(ctx)) as any;return json(result,result?.approval?202:200);};
}
