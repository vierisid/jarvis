/**
 * `/v1/jarvis/tools/invoke` -- backs the `jarvis-tool` piece's `invoke` action.
 *
 * The piece-side action posts `{ toolName, params }` and expects back
 * `{ result, toolName }`. Implementation here is a thin wrapper around a
 * `ToolsInvokeFn` injected via `SandboxApiServices.toolsInvoke`. Tool
 * discovery / execution lives in the daemon's `ToolRegistry`; if no fn is
 * configured the route returns 503.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";

export interface ToolsInvokeRequest {
  toolName: string;
  params: Record<string, unknown>;
}

export interface ToolsInvokeResponse {
  result: unknown;
  toolName: string;
}

export type ToolsInvokeFn = (
  req: ToolsInvokeRequest,
  ctx: { runId: string; projectId: string },
) => Promise<ToolsInvokeResponse>;

export interface JarvisToolsRouteDeps {
  toolsInvoke?: ToolsInvokeFn;
}

export function createJarvisToolsInvokeRoute(
  deps: JarvisToolsRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.toolsInvoke) {
      return err("jarvis tools.invoke not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.toolName !== "string" || raw.toolName.length === 0) {
      return err("toolName must be a non-empty string", 400);
    }
    let params: Record<string, unknown> = {};
    if (raw.params !== undefined) {
      if (
        typeof raw.params !== "object" ||
        raw.params === null ||
        Array.isArray(raw.params)
      ) {
        return err("params must be an object", 400);
      }
      params = raw.params as Record<string, unknown>;
    }
    const reply = await deps.toolsInvoke(
      { toolName: raw.toolName, params },
      { runId: ctx.claims.runId, projectId: ctx.claims.projectId },
    );
    return json(reply);
  };
}
