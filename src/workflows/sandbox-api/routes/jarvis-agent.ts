/**
 * `/v1/jarvis/agent/delegate` -- backs the `jarvis-agent` piece's `delegate`
 * action. The piece posts `{ goal, role?, maxIterations? }`; the route
 * returns the agent's `{ finalMessage, toolCalls, status, error? }`.
 *
 * Sub-agent execution (M7) lives entirely in the daemon. The handler here
 * only validates the envelope and dispatches to an injected `AgentDelegateFn`.
 */

import { json, err, type RouteContext, type RouteHandler } from "./shared";

export interface AgentDelegateRequest {
  goal: string;
  role?: string;
  maxIterations?: number;
}

export interface AgentDelegateResponse {
  finalMessage: string;
  toolCalls: Array<{
    name: string;
    args?: string;
    result?: string;
    error?: string;
  }>;
  status: "completed" | "max_iterations" | "error" | "canceled";
  error?: string;
}

export type AgentDelegateFn = (
  req: AgentDelegateRequest,
  ctx: { runId: string; projectId: string },
) => Promise<AgentDelegateResponse>;

export interface JarvisAgentRouteDeps {
  agentDelegate?: AgentDelegateFn;
}

export function createJarvisAgentDelegateRoute(
  deps: JarvisAgentRouteDeps,
): RouteHandler {
  return async (req: RouteContext) => {
    if (!deps.agentDelegate) {
      return err("jarvis agent.delegate not configured", 503);
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("invalid JSON body", 400);
    }
    if (typeof raw.goal !== "string" || raw.goal.length === 0) {
      return err("goal must be a non-empty string", 400);
    }
    const out: AgentDelegateRequest = { goal: raw.goal };
    if (raw.role !== undefined) {
      if (typeof raw.role !== "string" || raw.role.length === 0) {
        return err("role must be a non-empty string if provided", 400);
      }
      out.role = raw.role;
    }
    if (raw.maxIterations !== undefined) {
      const n = raw.maxIterations;
      if (
        typeof n !== "number" ||
        !Number.isFinite(n) ||
        n <= 0 ||
        Math.floor(n) !== n
      ) {
        return err("maxIterations must be a positive integer", 400);
      }
      out.maxIterations = n;
    }
    const reply = await deps.agentDelegate(out, {
      runId: req.claims.runId,
      projectId: req.claims.projectId,
    });
    return json(reply);
  };
}
