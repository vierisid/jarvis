/**
 * Adapter: PieceLlmClient over Jarvis' LLMManager.
 *
 * The piece interface is single-shot: prompt -> text. LLMManager is
 * message-based and supports streaming + tool use. We project down: build a
 * 1- or 2-message chat (system + user), call `chat()`, and surface only the
 * text content. Streaming and tool use are out of scope for jarvis-ask.
 */

import type {
  PieceLlmClient,
  PieceLlmInput,
  PieceLlmResponse,
} from "../jarvis-pieces/types";
import type { LLMManager } from "../../llm/manager";
import type { LLMMessage, LLMOptions, LLMResponse } from "../../llm/provider";

export class JarvisLlmClient implements PieceLlmClient {
  constructor(private readonly manager: LLMManager) {}

  async chat(input: PieceLlmInput): Promise<PieceLlmResponse> {
    const messages: LLMMessage[] = [];
    if (input.system !== undefined) {
      messages.push({ role: "system", content: input.system });
    }
    messages.push({ role: "user", content: input.prompt });
    const options: LLMOptions = {};
    if (input.model !== undefined) options.model = input.model;
    if (input.temperature !== undefined) options.temperature = input.temperature;

    const reply: LLMResponse = await this.manager.chat(messages, options);

    return projectResponse(reply);
  }
}

/**
 * Extract the text portion from an LLMResponse. Tool calls and structured
 * blocks are dropped -- jarvis-ask is a text piece. If there's no text at
 * all, returns the empty string (callers can decide what to do; we don't
 * want to throw on edge cases like all-thinking responses).
 */
export function projectResponse(reply: LLMResponse): PieceLlmResponse {
  const text = extractText(reply);
  const out: PieceLlmResponse = { text };
  const usage = extractUsage(reply);
  if (usage) out.usage = usage;
  return out;
}

function extractText(reply: LLMResponse): string {
  // `LLMResponse.content` is typed as `string` in provider.ts, which is
  // what every provider returns today. Older / parallel shapes may carry
  // a block array (`{ type: 'text', text: '...' }[]`) or a top-level
  // `text` field. Be defensive: try each shape in turn, fall back to "".
  const r = reply as unknown as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  const content = r.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function extractUsage(reply: LLMResponse): { promptTokens?: number; completionTokens?: number } | undefined {
  const r = reply as unknown as { usage?: { promptTokens?: number; completionTokens?: number } };
  if (!r.usage) return undefined;
  const out: { promptTokens?: number; completionTokens?: number } = {};
  if (typeof r.usage.promptTokens === "number") out.promptTokens = r.usage.promptTokens;
  if (typeof r.usage.completionTokens === "number") out.completionTokens = r.usage.completionTokens;
  return out;
}
