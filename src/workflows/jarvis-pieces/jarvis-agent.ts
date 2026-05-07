/**
 * `jarvis-agent` piece -- delegate a goal to a Jarvis sub-agent (M7). The
 * agent runs its own tool loop with reasoning and returns a final message
 * plus the trace of tools it called along the way.
 *
 * Action: delegate
 *   goal:           string  (required)
 *   role:           string  (optional -- M7 specialist role, e.g. "researcher")
 *   maxIterations:  number  (optional -- caps the tool loop)
 *
 * For tasks where you know the exact tool to call, use `jarvis-tool`. For
 * single-shot LLM work without tool use, `jarvis-ask`. Use `jarvis-agent`
 * when the LLM should plan and use tools to reach a goal.
 */

import {
  JarvisActionInputError,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
  type PieceAgentDelegateInput,
  type PieceAgentDelegateResult,
} from "./types";

export interface DelegateInput {
  goal: string;
  role?: string;
  maxIterations?: number;
}

export interface DelegateOutput extends PieceAgentDelegateResult {}

export const delegateAction: JarvisAction<DelegateInput, DelegateOutput> = {
  name: "delegate",
  displayName: "Delegate to a Jarvis sub-agent",
  description:
    "Spawn a sub-agent (M7) with a goal and let it plan + call tools to reach it. Use for multi-step tasks where the LLM should pick what to do. Returns the agent's final message and the full tool-call trace.",

  inputSchema: {
    fields: [
      {
        name: "goal",
        label: "Goal",
        type: "long_text",
        required: true,
        placeholder: "Plain-English description of what the agent should do.",
      },
      {
        name: "role",
        label: "Specialist role",
        type: "string",
        required: false,
        description: "Optional. M7 specialist role id (researcher, planner, ...).",
      },
      {
        name: "maxIterations",
        label: "Max iterations",
        type: "number",
        required: false,
        description: "Caps the agent's tool-use loop. Defaults to the daemon's setting.",
      },
    ],
  },

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.goal !== "string" || r.goal.length === 0) {
      throw new JarvisActionInputError("goal is required and must be a non-empty string");
    }
    const out: DelegateInput = { goal: r.goal };
    if (r.role !== undefined) {
      if (typeof r.role !== "string" || r.role.length === 0) {
        throw new JarvisActionInputError("role must be a non-empty string if provided");
      }
      out.role = r.role;
    }
    if (r.maxIterations !== undefined) {
      if (
        typeof r.maxIterations !== "number" ||
        !Number.isFinite(r.maxIterations) ||
        r.maxIterations <= 0 ||
        Math.floor(r.maxIterations) !== r.maxIterations
      ) {
        throw new JarvisActionInputError("maxIterations must be a positive integer");
      }
      out.maxIterations = r.maxIterations;
    }
    return out;
  },

  async execute(input, ctx: JarvisPieceContext): Promise<DelegateOutput> {
    const delegator = ctx.services.agentDelegator;
    if (!delegator) {
      throw new Error("jarvis-agent: ctx.services.agentDelegator is not configured");
    }
    const delegateInput: PieceAgentDelegateInput = { goal: input.goal };
    if (input.role !== undefined) delegateInput.role = input.role;
    if (input.maxIterations !== undefined) delegateInput.maxIterations = input.maxIterations;
    return delegator.delegate(delegateInput);
  },
};

export const jarvisAgentPiece: JarvisPiece = {
  name: "jarvis-agent",
  displayName: "Jarvis: Agent",
  description:
    "Run a Jarvis sub-agent with a goal. The agent uses its full reasoning + tool loop to reach the goal and returns the final answer plus the tool-call trace.",
  actions: {
    [delegateAction.name]: delegateAction as unknown as JarvisAction,
  },
};
