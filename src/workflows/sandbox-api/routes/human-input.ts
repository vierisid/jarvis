import { json, err, parseJsonObject, type RouteHandler } from './shared';
import { workflowEffectContext } from './effect-context';
import type { SubflowFn } from './jarvis-subflow';
export function createHumanInputRoute(deps: { humanInput?: SubflowFn }): RouteHandler {
  return async ctx => {
    if (!deps.humanInput) return err('Human input unavailable', 503);
    const input = await parseJsonObject(ctx); if (input instanceof Response) return input;
    const result = await deps.humanInput(input, workflowEffectContext(ctx)) as { waitpointId?: string };
    return json(result, result.waitpointId ? 202 : 200);
  };
}
