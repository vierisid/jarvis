/**
 * The LLM client the workflow composer runs on.
 *
 * Lives here rather than inline in the daemon's boot sequence for two
 * reasons: the daemon file is five thousand lines of wiring where a routing
 * decision this consequential disappears, and inline it could not be tested
 * at all -- which is how it went unnoticed that every workflow the user asked
 * for was being written by whichever model backs the `medium` tier.
 *
 * The composer's own contract (`ComposerLlmClient`) is deliberately narrow:
 * `chat` is the mandatory single-shot path, `chatTools` the optional
 * tool-calling one. This module is the only place that maps those onto
 * `LLMManager`, so tier, subsystem label and token cap are decided once.
 */

import type { LLMManager } from "../../llm/manager.ts";
import type { LLMMessage, LLMOptions } from "../../llm/provider.ts";
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
 * Build the composer's LLM client over the daemon's `LLMManager`.
 */
export function createComposerLlmClient(manager: LLMManager): ComposerLlmClient {
  const call = (messages: LLMMessage[], options: LLMOptions) =>
    manager.chat(messages, options);

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
