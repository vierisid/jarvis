/**
 * `/v1/jarvis/agent/delegate` -- backs the `jarvis-agent` piece's `delegate`
 * action. The piece posts `{ goal, role?, maxIterations?, requiredTools?,
 * requireSuccess? }`; the route returns the agent's `{ finalMessage,
 * toolCalls, status, outcome, error? }`, or 202 with a pending approval.
 *
 * Sub-agent execution (M7) lives entirely in the daemon. The handler here
 * only validates the envelope and dispatches to an injected `AgentDelegateFn`.
 *
 * Outcome contract: a finished conversation is not a business outcome. The
 * `outcome` says whether the delegation finished and every declared required
 * tool completed. A failed outcome answers 422 and the piece stops the step;
 * `requireSuccess: false` answers 200 with the same outcome so the graph can
 * route on it.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { delegationOutcome } from "../../adapters/m7-agent-delegator";
import type { ActionOutcome } from "../../../actions/action-outcome";
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext, WorkflowApprovalPending } from '../../runtime/effect-context';

const MAX_REQUIRED_TOOLS = 32;

export interface AgentDelegateRequest {
  goal: string;
  role?: string;
  maxIterations?: number;
  /** Tools that must have completed for the delegation to count as done. */
  requiredTools?: string[];
  /** Defaults to true. False returns a failed outcome as data for the graph. */
  requireSuccess?: boolean;
}

export interface AgentDelegateResponse {
  approval?: WorkflowApprovalPending;
  finalMessage: string;
  toolCalls: Array<{
    name: string;
    args?: string;
    result?: string;
    error?: string;
  }>;
  status: "completed" | "max_iterations" | "error" | "canceled" | "approval_required";
  error?: string;
  /** Present on every finished delegation. */
  outcome?: ActionOutcome;
}

export type AgentDelegateFn = (
  req: AgentDelegateRequest,
  ctx: WorkflowEffectContext,
) => Promise<AgentDelegateResponse>;

export interface JarvisAgentRouteDeps {
  agentDelegate?: AgentDelegateFn;
}

export function createJarvisAgentDelegateRoute(
  deps: JarvisAgentRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.agentDelegate) {
      return err("jarvis agent.delegate not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
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
      // The same ceiling as the primary agent loop. A workflow step asking for
      // more is either a mistake or a loop that should not be one LLM call per
      // iteration against a shared, rate-limited key.
      if (n > 200) {
        return err("maxIterations must be at most 200", 400);
      }
      out.maxIterations = n;
    }
    if (raw.requiredTools !== undefined) {
      const tools = raw.requiredTools;
      if (!Array.isArray(tools) || tools.length > MAX_REQUIRED_TOOLS
        || tools.some(tool => typeof tool !== "string" || tool.length === 0 || tool.length > 120)) {
        return err(`requiredTools must be an array of up to ${MAX_REQUIRED_TOOLS} non-empty tool names`, 400);
      }
      out.requiredTools = tools as string[];
    }
    if (raw.requireSuccess !== undefined) {
      if (typeof raw.requireSuccess !== "boolean") return err("requireSuccess must be a boolean", 400);
      out.requireSuccess = raw.requireSuccess;
    }
    const reply = await cancellableWorkflowService(deps.agentDelegate)(out, workflowEffectContext(ctx));
    if (reply.approval) return json(reply, 202);
    // A backend without the contract (the LLM-only fallback) is evaluated here.
    const outcome = reply.outcome ?? delegationOutcome(reply, out.requiredTools);
    // HTTP success for a handled outcome acknowledges that the outcome was
    // returned; it does not claim the declared work was done.
    const status = outcome.status === "succeeded" || raw.requireSuccess === false ? 200
      : outcome.status === "blocked" ? 409 : outcome.status === "error" ? 422 : 502;
    return json({ ...reply, outcome }, status);
  };
}
