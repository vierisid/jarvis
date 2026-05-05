/**
 * `jarvis-ask` piece -- single-shot prompt against the configured Jarvis LLM.
 *
 * Action: ask
 *   prompt:        string                          (required)
 *   system:        string                          (optional)
 *   model:         string                          (optional override)
 *   temperature:   number                          (optional)
 *   outputSchema:  "text" | "json"                 (default "text")
 *
 * When `outputSchema` is "json", the response is parsed (after stripping the
 * common ```json ... ``` wrapping) and returned as the parsed value. If
 * parsing fails the action throws -- workflows can wrap with a retry node or
 * fall back to text.
 *
 * No tool-use, no streaming. For richer behavior use `jarvis-agent`.
 */

import {
  JarvisActionInputError,
  type JarvisAction,
  type JarvisPiece,
  type JarvisPieceContext,
} from "./types";

export interface AskInput {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  outputSchema?: "text" | "json";
}

export interface AskOutput {
  /** Always present; the raw assistant reply. */
  text: string;
  /** Present iff `outputSchema === "json"` and parsing succeeded. */
  json?: unknown;
  /** Optional usage stats. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export const askAction: JarvisAction<AskInput, AskOutput> = {
  name: "ask",
  displayName: "Ask Jarvis",
  description:
    "Run a prompt against the configured Jarvis LLM and return the response. Optionally parse the response as JSON.",

  parseInput: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new JarvisActionInputError("input must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.prompt !== "string" || r.prompt.length === 0) {
      throw new JarvisActionInputError("prompt is required and must be a non-empty string");
    }
    if (r.system !== undefined && typeof r.system !== "string") {
      throw new JarvisActionInputError("system must be a string");
    }
    if (r.model !== undefined && typeof r.model !== "string") {
      throw new JarvisActionInputError("model must be a string");
    }
    if (r.temperature !== undefined && (typeof r.temperature !== "number" || !Number.isFinite(r.temperature))) {
      throw new JarvisActionInputError("temperature must be a finite number");
    }
    if (r.outputSchema !== undefined && r.outputSchema !== "text" && r.outputSchema !== "json") {
      throw new JarvisActionInputError("outputSchema must be 'text' or 'json'");
    }
    const out: AskInput = { prompt: r.prompt };
    if (typeof r.system === "string") out.system = r.system;
    if (typeof r.model === "string") out.model = r.model;
    if (typeof r.temperature === "number") out.temperature = r.temperature;
    if (r.outputSchema === "json" || r.outputSchema === "text") out.outputSchema = r.outputSchema;
    return out;
  },

  async execute(input, ctx: JarvisPieceContext): Promise<AskOutput> {
    const llm = ctx.services.llm;
    if (!llm) {
      throw new Error("jarvis-ask: ctx.services.llm is not configured");
    }
    const llmInput: Parameters<typeof llm.chat>[0] = { prompt: input.prompt };
    if (input.system !== undefined) llmInput.system = input.system;
    if (input.model !== undefined) llmInput.model = input.model;
    if (input.temperature !== undefined) llmInput.temperature = input.temperature;
    const reply = await llm.chat(llmInput);

    const out: AskOutput = { text: reply.text };
    if (reply.usage) out.usage = reply.usage;

    if (input.outputSchema === "json") {
      out.json = parseJsonReply(reply.text);
    }
    return out;
  },
};

/**
 * Strip common LLM JSON wrappings (```json ... ```, ``` ... ```, leading
 * "Here's the JSON:" prose) before JSON.parse. Throws if the result is not
 * valid JSON; callers in workflows can catch and retry.
 */
export function parseJsonReply(text: string): unknown {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `jarvis-ask: outputSchema='json' but reply was not valid JSON: ${(e as Error).message}`,
    );
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  // ```json\n...\n```  or  ```\n...\n```
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;
  const m = fence.exec(trimmed);
  if (m && typeof m[1] === "string") return m[1].trim();
  return trimmed;
}

export const jarvisAskPiece: JarvisPiece = {
  name: "jarvis-ask",
  displayName: "Jarvis: Ask",
  description:
    "Run a single-shot prompt against the configured Jarvis LLM. Use this for summaries, classification, formatting, and short reasoning tasks. For multi-step or tool-using tasks use jarvis-agent instead.",
  actions: {
    [askAction.name]: askAction as unknown as JarvisAction,
  },
};
