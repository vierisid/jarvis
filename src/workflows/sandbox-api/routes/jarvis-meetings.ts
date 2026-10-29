import { json, err, parseJsonObject, type RouteHandler } from './shared';
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext } from '../../runtime/effect-context';
export type MeetingBriefsFn = (input: Record<string, unknown>, context: WorkflowEffectContext) => Promise<unknown>;
export function createMeetingBriefsRoute(deps: { meetingBriefs?: MeetingBriefsFn }): RouteHandler {
  return async ctx => {
    if (!deps.meetingBriefs) return err('Meeting preparation unavailable', 503);
    const input = await parseJsonObject(ctx); if (input instanceof Response) return input;
    const result = await deps.meetingBriefs(input, workflowEffectContext(ctx)) as any;
    return json(result, result?.approval ? 202 : 200);
  };
}
