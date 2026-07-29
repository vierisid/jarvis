/**
 * Adapter: PieceAgentDelegator.
 *
 * Two implementations are provided:
 *
 *   `LlmOnlyAgentDelegator` -- delegates by feeding the goal to the LLM with
 *      a system prompt instructing it to plan and answer. No tool loop. This
 *      is the baseline that works without M7 wired up: it gets `jarvis-agent`
 *      flows running and returning final messages, even if the "agent" can't
 *      take actions yet. Tool trace is empty.
 *
 *   M7-backed delegator -- see `m7-agent-delegator.ts` for the full
 *      implementation (spawns sub-agents through orchestrator.spawnSubAgent,
 *      runs them through runSubAgent, extracts tool-call trace).
 *
 * The piece-side type doesn't expose a "tool trace" concept beyond an array
 * of `{name, args?, result?}` objects; both impls satisfy the same contract.
 */

import type {
  PieceAgentDelegateInput,
  PieceAgentDelegateResult,
  PieceAgentDelegator,
  PieceLlmClient,
} from "../jarvis-pieces/types";

/**
 * Minimal-viable delegator: a single LLM round-trip with a "plan-and-answer"
 * system prompt. No tools. Use until the M7-backed delegator lands.
 */
export class LlmOnlyAgentDelegator implements PieceAgentDelegator {
  constructor(
    private readonly llm: PieceLlmClient,
    /** Optional override for the system prompt; default is goal-shaped. */
    private readonly systemPrompt: string = "You are a Jarvis sub-agent. Plan briefly, then answer the user's goal directly. If you would need a tool you don't have, say so explicitly.",
  ) {}

  async delegate(input: PieceAgentDelegateInput): Promise<PieceAgentDelegateResult> {
    const reply = await this.llm.chat({
      system: this.systemPrompt,
      prompt: input.goal,
    });
    return {
      finalMessage: reply.text,
      toolCalls: [],
      status: "completed",
    };
  }
}
