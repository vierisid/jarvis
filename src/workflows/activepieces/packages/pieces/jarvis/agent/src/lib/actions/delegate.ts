/**
 * `delegate` action -- POST `{ goal, role?, maxIterations? }` to
 * `/v1/jarvis/agent/delegate` and surface the agent's final message + tool-call
 * trace + status. Sub-agent execution lives entirely in the daemon.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface DelegateResponse {
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

export const delegateAction = createAction({
  name: "delegate",
  displayName: "Delegate to a Jarvis sub-agent",
  description:
    "Spawn a sub-agent with a goal and let it plan + call tools to reach it. Returns the agent's final message and the full tool-call trace.",
  // Variable-picker hint: `finalMessage` is the agent's natural-language
  // wrap-up (use as the downstream input). `status` is the terminal
  // verdict. `toolCalls` is the trace; `error` is set only on
  // `status: "error"`. All four are always present in the wire shape.
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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-agent: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return (await response.json()) as DelegateResponse;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
