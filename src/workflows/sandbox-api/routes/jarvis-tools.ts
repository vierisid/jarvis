/**
 * `/v1/jarvis/tools/invoke` -- backs the `jarvis-tool` piece's `invoke` action.
 *
 * The piece-side action posts `{ toolName, params }` and expects back
 * `{ result, toolName }`. Implementation here is a thin wrapper around a
 * `ToolsInvokeFn` injected via `SandboxApiServices.toolsInvoke`. Tool
 * discovery / execution lives in the daemon's `ToolRegistry`; if no fn is
 * configured the route returns 503.
 */

import { json, err, type RouteContext, type RouteHandler } from "./shared";

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
  return async (req: RouteContext) => {
    if (!deps.toolsInvoke) {
      return err("jarvis tools.invoke not configured", 503);
    }
    let body: ToolsInvokeRequest;
    try {
      body = (await req.json()) as ToolsInvokeRequest;
    } catch {
      return err("invalid JSON body", 400);
    }
    if (typeof body.toolName !== "string" || body.toolName.length === 0) {
      return err("toolName must be a non-empty string", 400);
    }
    let params: Record<string, unknown> = {};
    if (body.params !== undefined) {
      if (
        typeof body.params !== "object" ||
        body.params === null ||
        Array.isArray(body.params)
      ) {
        return err("params must be an object", 400);
      }
      params = body.params;
    }
    const reply = await deps.toolsInvoke(
      { toolName: body.toolName, params },
      { runId: req.claims.runId, projectId: req.claims.projectId },
    );
    return json(reply);
  };
}
