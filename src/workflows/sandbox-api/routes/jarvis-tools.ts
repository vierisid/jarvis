/**
 * `/v1/jarvis/tools/invoke` -- backs the `jarvis-tool` piece's `invoke` action.
 *
 * The piece posts `{ toolName, params, requireSuccess? }` (the last a
 * reply-handling flag read only here) and receives
 * `{ result, toolName, outcome }` or a pending approval. This wraps a
 * `ToolsInvokeFn` injected via `SandboxApiServices.toolsInvoke`. Tool
 * discovery / execution lives in the daemon's `ToolRegistry`; if no fn is
 * configured the route returns 503.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { ActionOutcomeError, type ActionOutcome } from '../../../actions/action-outcome';
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext, WorkflowApprovalPending } from '../../runtime/effect-context';

export interface ToolsInvokeRequest {
  toolName: string;
  params: Record<string, unknown>;
}

export interface ToolsInvokeResponse {
  result: unknown;
  toolName: string;
  approval?: WorkflowApprovalPending;
  outcome?: ActionOutcome;
}

export type ToolsInvokeFn = (
  req: ToolsInvokeRequest,
  ctx: WorkflowEffectContext,
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
    if (raw.requireSuccess !== undefined && typeof raw.requireSuccess !== 'boolean') {
      return err('requireSuccess must be a boolean', 400);
    }
    let reply: ToolsInvokeResponse;
    try {
      reply = await cancellableWorkflowService(deps.toolsInvoke)(
        // `requireSuccess` stays on this side of the boundary on purpose: it
        // decides how the reply is reported, never what is dispatched, so it
        // must not reach the effect record or its request digest.
        { toolName: raw.toolName, params },
        workflowEffectContext(ctx),
      );
    } catch (error) {
      if (!(error instanceof ActionOutcomeError)) throw error;
      reply = { toolName: raw.toolName, result: null, outcome: error.outcome };
    }
    if (reply.approval) return json(reply, 202);
    const outcome = reply.outcome ?? { status: 'succeeded' as const };
    // HTTP success for a probe acknowledges that its outcome was returned; it
    // does not claim the requested desktop action succeeded.
    const status = outcome.status === 'succeeded' || raw.requireSuccess === false ? 200
      : outcome.status === 'blocked' ? 409 : outcome.status === 'error' ? 422 : 502;
    return json({ ...reply, outcome }, status);
  };
}
