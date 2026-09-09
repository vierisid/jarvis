/**
 * The LLM client the workflow composer runs on.
 *
 * Lives here rather than inline in the daemon's boot sequence for two
 * reasons: the daemon file is five thousand lines of wiring where a routing
 * decision this consequential disappears, and inline it could not be tested
 * at all -- which is how it went unnoticed that workflow composition was
 * running on the deprecated `LLMManager.chat()`, i.e. whatever `medium`
 * resolved to, billed to the subsystem label `legacy` -- or, with no tier map
 * at all, the legacy primary-provider chain, which records no usage whatever.
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
 * per turn), and `composeFlow` already makes up to four attempts because
 * weaker models need two or three to emit a valid tree. A model that gets it
 * right first time is frequently the cheaper one here.
 *
 * Do not read "four" as a bound on the spend, though. That cap counts
 * one-shot attempts, or `submit_flow` attempts in the tool loop -- and the
 * tool loop (the production path whenever the model supports tools) runs up
 * to TOOL_LOOP_MAX_TURNS = 12 calls against a conversation that grows with
 * every piece it inspects. A compose is therefore up to a dozen high-tier
 * calls, not one.
 *
 * The other thing `high` changes is wall time. `LLMManager.REQUEST_TIMEOUT_MS`
 * is a fixed 90s with no per-call override, and both paths here ask for up to
 * 8192 output tokens, so a slow high-tier model (a reasoning model, or a
 * large local one) is likelier to cross it than a medium one was.
 *
 * What happens then, precisely, because it is not what the manager's own
 * retry policy suggests: `withTimeout` rejects with "... timed out after
 * 90000ms", and both `classifyErrorString` and `shouldRetry` look for the
 * substring "timeout", which that message does not contain. So the failure
 * classifies as `unknown`: it is NOT retried, and on tool-loop turn 1 the
 * composer treats it as a tools-unsupported signal and falls back to the
 * one-shot prompt, which can burn another 90s before failing. Budget ~180s
 * worst case, and do not expect to see it retried.
 *
 * (That "timed out" / "timeout" mismatch is a latent bug in the manager
 * affecting every subsystem, not something this module should paper over.
 * Raising the ceiling would mean giving LLMOptions a timeout, which is a
 * change to shared LLM infrastructure and deliberately not made here.)
 *
 * `high` falls up to `medium` on its own (see TIER_FALLBACK in
 * src/llm/tiers.ts). That matters for an install that configures only
 * `llm.tiers.medium`, or whose `high` ref names an unregistered provider and
 * gets dropped. It is NOT what carries a single-model install: `llm.default`
 * populates low, medium and high with the same ref, so those resolve `high`
 * directly and never fall up.
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
 * The assistant text of a reply.
 *
 * `LLMResponse.content` is typed `string` and every provider returns one. An
 * earlier version of this adapter read `reply.text` instead -- a field that
 * does not exist on the response shape -- so every compose returned "" and
 * the composer burned its whole retry budget on "Unexpected EOF".
 *
 * A non-string body cannot be salvaged into a workflow tree, so it still
 * becomes "" and the composer fails its parse. But it is logged: silently
 * returning "" is what made that bug take so long to find, and a provider
 * that starts sending content blocks for a text completion should be
 * diagnosable from one line of the daemon log rather than from a parse error
 * four attempts downstream.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  console.warn(
    `[composer] LLM returned a non-string content body (${typeof content}); ` +
      `dropping the assistant text. A one-shot compose will now fail its JSON ` +
      `parse; a tool-loop turn carries on if it also returned tool_calls.`,
  );
  return "";
}

/**
 * Build the composer's LLM client over the daemon's `LLMManager`.
 */
export function createComposerLlmClient(manager: LLMManager): ComposerLlmClient {
  // The one place composition reaches the LLM. Both paths below go through
  // it, so the tier and the usage label cannot drift apart between them.
  const route = (messages: LLMMessage[], options: LLMOptions) =>
    manager.chatTier(COMPOSER_TIER, COMPOSER_SUBSYSTEM, messages, options);

  return {
    async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
      const messages: LLMMessage[] = [];
      if (input.system !== undefined) messages.push({ role: "system", content: input.system });
      messages.push({ role: "user", content: input.prompt });
      const reply = await route(messages, { max_tokens: COMPOSER_MAX_TOKENS });
      return { text: textOf(reply.content) };
    },

    // Tool-loop entrypoint: the composer discovers pieces via tools
    // (list_pieces / get_piece_details / ...) instead of a full catalog dump.
    // ComposerChatMessage / ComposerToolDef alias LLMMessage / LLMTool, so
    // this is a passthrough. A provider that rejects the `tools` parameter
    // must see its error REACH the composer: on turn 1, and only for codes
    // that are not rate_limit / network / server / auth / forbidden, the loop
    // catches it and falls back to the one-shot `chat` path above. Anything
    // transient is surfaced to the caller instead. `finish_reason` is passed
    // through so the loop can tell a reply truncated at the token cap (a
    // dropped submit_flow) from real prose.
    async chatTools(
      messages: ComposerChatMessage[],
      tools: ComposerToolDef[],
    ): Promise<ComposerChatReply> {
      const reply = await route(messages, {
        max_tokens: COMPOSER_MAX_TOKENS,
        tools,
        tool_choice: "auto",
      });
      return {
        content: textOf(reply.content),
        tool_calls: reply.tool_calls ?? [],
        finish_reason: reply.finish_reason,
      };
    },
  };
}
