/**
 * The LLM client the workflow composer runs on.
 *
 * Lives here rather than inline in the daemon's boot sequence for two
 * reasons: the daemon file is five thousand lines of wiring where a routing
 * decision this consequential disappears, and inline it could not be tested
 * at all -- which is how it went unnoticed that every workflow the user asked
 * for was being written by whichever model backs the `medium` tier.
 *
 * Composing now runs on `high`, labelled `workflow_composer` -- see the two
 * constants below for why.
 *
 * The composer's own contract (`ComposerLlmClient`) is deliberately narrow:
 * `chat` is the mandatory single-shot path, `chatTools` the optional
 * tool-calling one. This module is the only place that maps those onto
 * `LLMManager`, so tier, subsystem label and token cap are decided once.
 */

import type { LLMManager } from "../../llm/manager.ts";
import type { LLMMessage, LLMOptions } from "../../llm/provider.ts";
import type { Tier } from "../../llm/tiers.ts";
import type {
  ComposerChatMessage,
  ComposerChatReply,
  ComposerLlmClient,
  ComposerToolDef,
} from "./workflow-composer.ts";

/**
 * Output cap for both composer paths.
 *
 * A realistic flow is 500-2000 output tokens; 8192 leaves room for verbose
 * pieces (long input schemas, many steps) without surprise truncation.
 * Ollama's default `num_predict` is 128, which truncates every compose reply
 * mid-JSON and crashes parsing with "Unexpected EOF"; other providers either
 * have higher defaults or ignore the cap. The two paths must agree -- a
 * tool-loop reply that dies at a different limit than the one-shot path would
 * make truncation bugs impossible to reproduce.
 */
const COMPOSER_MAX_TOKENS = 8192;

/**
 * Composing runs on the `high` tier.
 *
 * It is the most reasoning-dense thing `manage_workflow` does: read a catalog
 * of piece contracts, choose pieces, wire `{{step.field}}` references against
 * each upstream step's DECLARED output shape, match router operators to the
 * real type of the value they test, satisfy every required input, and write
 * commands for the OS of the machine the step lands on. Getting any one of
 * those wrong produces a flow that validates today and fails on its first
 * real run.
 *
 * It is also the tier decision with the least cost pressure behind it.
 * Composing is user-initiated and rare (a handful of times per workflow, not
 * per turn), and `composeFlow` already retries up to four times because
 * weaker models need two or three attempts to emit a valid tree -- each retry
 * being another full catalog-sized prompt. A model that gets it right first
 * time is frequently the cheaper one here.
 *
 * `high` falls up to `medium` on its own when no high tier is configured
 * (see TIER_FALLBACK in src/llm/tiers.ts), so a single-model install keeps
 * working with no wiring at all.
 */
const COMPOSER_TIER: Tier = "high";

/**
 * Usage label for the composer's spend.
 *
 * The old path went through the deprecated `LLMManager.chat()`, which books
 * every call to the subsystem `legacy` -- so workflow composition was not
 * merely running on the wrong tier, it was invisible in per-subsystem usage
 * reporting. Anything that reads `llm_usage` groups on this string.
 */
const COMPOSER_SUBSYSTEM = "workflow_composer";

/**
 * Build the composer's LLM client over the daemon's `LLMManager`.
 */
export function createComposerLlmClient(manager: LLMManager): ComposerLlmClient {
  const call = (messages: LLMMessage[], options: LLMOptions) =>
    manager.chatTier(COMPOSER_TIER, COMPOSER_SUBSYSTEM, messages, options);

  return {
    async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
      const messages: LLMMessage[] = [];
      if (input.system !== undefined) messages.push({ role: "system", content: input.system });
      messages.push({ role: "user", content: input.prompt });
      const reply = await call(messages, { max_tokens: COMPOSER_MAX_TOKENS });
      // `LLMResponse.content` is the assistant-text field; an earlier version
      // of this adapter read `reply.text`, which does not exist on the
      // provider response shape, so every compose returned "" and JSON.parse
      // crashed with EOF. Stay strict -- if a provider ever returns
      // ContentBlock[] for a text-only completion we want to know.
      return { text: typeof reply.content === "string" ? reply.content : "" };
    },

    // Tool-loop entrypoint: the composer discovers pieces via tools
    // (list_pieces / get_piece_details / ...) instead of a full catalog dump.
    // ComposerChatMessage / ComposerToolDef alias LLMMessage / LLMTool, so
    // this is a passthrough. If the provider rejects the tools parameter the
    // composer catches the error and falls back to the one-shot `chat` path
    // above. `finish_reason` is surfaced so the loop can tell a reply
    // truncated at the token cap (a dropped submit_flow) from real prose.
    async chatTools(
      messages: ComposerChatMessage[],
      tools: ComposerToolDef[],
    ): Promise<ComposerChatReply> {
      const reply = await call(messages, {
        max_tokens: COMPOSER_MAX_TOKENS,
        tools,
        tool_choice: "auto",
      });
      return {
        content: typeof reply.content === "string" ? reply.content : "",
        tool_calls: reply.tool_calls ?? [],
        finish_reason: reply.finish_reason,
      };
    },
  };
}
