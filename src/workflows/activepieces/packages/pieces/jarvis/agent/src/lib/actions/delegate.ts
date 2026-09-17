/**
 * `delegate` action -- POST `{ goal, role?, maxIterations?, requiredTools?,
 * requireSuccess? }` to `/v1/jarvis/agent/delegate` and surface the agent's
 * final message + tool-call trace + status + declared outcome. Sub-agent
 * execution lives entirely in the daemon. A governed tool call inside the
 * agent parks this step on an approval; the step runs again after the
 * decision and the agent continues where it stopped.
 */

import { createAction, Property } from "@activepieces/pieces-framework";
import { assertActionSucceeded, isActionOutcome, type ActionOutcome } from '../../../../../../../../../actions/action-outcome';

interface DelegateResponse {
  approval?: { effectId: string; approvalId: string; waitpointId: string };
  finalMessage: string;
  toolCalls: Array<{
    name: string;
    args?: string;
    result?: string;
    error?: string;
  }>;
  status: "completed" | "max_iterations" | "error" | "canceled" | "approval_required";
  error?: string;
  outcome?: ActionOutcome;
}

export const delegateAction = createAction({
  name: "delegate",
  displayName: "Delegate to a Jarvis sub-agent",
  description:
    "Spawn a sub-agent with a goal and let it plan + call tools to reach it. Returns the agent's final message, the tool-call trace and a declared outcome. A finished conversation is not a business outcome: name the tools that must complete.",
  // Variable-picker hint: `finalMessage` is the agent's natural-language
  // wrap-up (use as the downstream input). `status` is how the conversation
  // ended. `outcome` is whether the declared work was done. `toolCalls` is
  // the trace; `error` is set only on `status: "error"`.
  outputSample: {
    finalMessage: "Done. I scheduled the follow-up call for Friday at 10am.",
    toolCalls: [
      {
        name: "calendar.create_event",
        args: '{"title":"Follow-up","start":"2026-05-23T10:00Z"}',
        result: '{"eventId":"evt_abc123"}',
      },
    ],
    status: "completed",
    outcome: { status: "succeeded" },
    error: null,
  },
  props: {
    goal: Property.LongText({
      displayName: "Goal",
      description: "Plain-English description of what the agent should accomplish.",
      required: true,
    }),
    role: Property.ShortText({
      displayName: "Specialist role",
      description: "Optional. M7 specialist role id (researcher, planner, ...).",
      required: false,
    }),
    maxIterations: Property.Number({
      displayName: "Max iterations",
      description: "Caps the agent's tool-use loop. Defaults to the daemon's setting.",
      required: false,
    }),
    requiredTools: Property.LongText({
      displayName: "Required tools",
      description:
        "Tool names, comma or newline separated, that must complete for this step to count as done. Without them, `outcome` only says the agent finished cleanly.",
      required: false,
    }),
    requireSuccess: Property.Checkbox({
      displayName: "Require the declared outcome",
      description:
        "Stop the step when the agent fails, stops early, or finishes without completing a required tool. Turn off only when a later step routes on {{step.outcome.status}} and handles the failure itself. On a failure, `outcome` carries `code` and `message`.",
      required: false,
      defaultValue: true,
    }),
  },
  async run(context) {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/agent/delegate";
    const goal = context.propsValue["goal"];
    if (typeof goal !== "string" || goal.length === 0) {
      throw new Error("jarvis-agent: goal is required and must be a non-empty string");
    }
    const body: Record<string, unknown> = { goal };
    const role = context.propsValue["role"];
    const maxIterations = context.propsValue["maxIterations"];
    if (typeof role === "string" && role.length > 0) body["role"] = role;
    if (
      typeof maxIterations === "number" &&
      Number.isFinite(maxIterations) &&
      maxIterations > 0 &&
      Math.floor(maxIterations) === maxIterations
    ) {
      body["maxIterations"] = maxIterations;
    }
    const requireSuccess = context.propsValue["requireSuccess"] ?? true;
    if (typeof requireSuccess !== "boolean") throw new Error("jarvis-agent: requireSuccess must be a boolean");
    body["requireSuccess"] = requireSuccess;
    const requiredTools = requiredToolsFrom(context.propsValue["requiredTools"]);
    if (requiredTools.length > 0) body["requiredTools"] = requiredTools;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
        'X-Jarvis-Step-Name': context.step.name,
        'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let reply: DelegateResponse;
    try { reply = JSON.parse(text); } catch {
      throw new Error(`jarvis-agent: invalid daemon response (${response.status})`);
    }
    if (response.ok && reply?.approval) {
      context.run.waitForWaitpoint(reply.approval.waitpointId);
      return reply;
    }
    if (!isActionOutcome(reply?.outcome)) {
      if (!response.ok) throw new Error(`jarvis-agent: daemon responded ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`jarvis-agent: daemon response lacks an action outcome (${response.status}): ${text.slice(0, 500)}`);
    }
    if (requireSuccess) assertActionSucceeded(reply.outcome);
    if (!response.ok) throw new Error(`jarvis-agent: daemon responded ${response.status}: ${text.slice(0, 500)}`);
    return reply;
  },
});

/** Names typed one per line or comma separated; an array from an expression is taken as is. */
function requiredToolsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim());
  if (typeof value !== "string") return [];
  return value.split(/[\n,]/u).map(part => part.trim()).filter(part => part.length > 0);
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
