import { json, err, parseJsonObject, type RouteHandler } from './shared';
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext } from '../../runtime/effect-context';
export type OnboardingFn = (input: Record<string,unknown>,context:WorkflowEffectContext)=>Promise<unknown>;
export function createOnboardingRoute(deps:{customerOnboarding?:OnboardingFn}):RouteHandler {
  return async ctx=>{
    if(!deps.customerOnboarding)return err('Customer onboarding unavailable',503);
    const input=await parseJsonObject(ctx);if(input instanceof Response)return input;
    const result=await deps.customerOnboarding(input,workflowEffectContext(ctx)) as any;
    return json(result,result?.approval?202:200);
  };
}
