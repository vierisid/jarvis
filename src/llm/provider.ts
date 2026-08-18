export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: LLMToolCall[];   // present on assistant messages with tool use
  tool_call_id?: string;        // present on tool result messages
  cache?: boolean;              // marks a stable prompt-cache boundary. Only honored on SYSTEM messages (Anthropic puts a cache_control breakpoint on the marked block); conversation-history caching is automatic via the provider's last-message breakpoint. Providers without explicit prompt caching ignore it.
};

export type LLMTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
};

export type LLMToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LLMResponse = {
  content: string;
  tool_calls: LLMToolCall[];
  usage: {
    // Normalized across providers: input_tokens counts only UNCACHED prompt
    // tokens (billed at full price). The full prompt size is
    // input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;      // tokens served from provider prompt cache (~0.1x on Anthropic, 0.5x on OpenAI)
    cache_creation_input_tokens?: number;  // tokens written to provider prompt cache (1.25x on Anthropic; always 0 on OpenAI)
  };
  model: string;
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
};

/**
 * Structured classification for provider/stream errors. Lets the UI render
 * user-facing copy without string-matching the upstream error message.
 */
export type LLMErrorCode =
  | 'auth'         // 401, invalid or missing API key
  | 'forbidden'    // 403, credentials accepted but this model/endpoint is not allowed
  | 'rate_limit'   // 429, quota exhausted
  | 'network'      // timeout, connection refused, 502/503/504
  | 'bad_request'  // 400/422, invalid parameters
  | 'not_found'    // 404, model/resource missing
  | 'server'       // generic 5xx
  | 'unknown';

export type LLMStreamEvent =
  /**
   * `segmentEnd` marks the text as a finished, speakable unit — set by
   * orchestrators when an acknowledgment is complete and slow tool work is
   * about to start. Consumers use it to flush a pending TTS sentence instead
   * of inferring completion from punctuation in a partial token buffer.
   * Providers never set it; the text may be empty when the signal is all the
   * producer has to say.
   */
  | { type: 'text'; text: string; segmentEnd?: boolean }
  | { type: 'tool_call'; tool_call: LLMToolCall }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; error: string; code?: LLMErrorCode; retry_after_ms?: number };

/** HTTP-aware provider failure used to carry Retry-After into the router. */
export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly code: LLMErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

/**
 * Map an HTTP status code returned by a provider to a canonical error code.
 * Use this at the emission site (where the status is still available) so the
 * UI doesn't have to guess from the error string.
 */
export function classifyHttpStatus(status: number): LLMErrorCode {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limit';
  // Some OpenAI-compatible gateways use non-standard 498 for an upstream
  // connection/token expiry and expect clients to retry it as a network fault.
  if (status === 498) return 'network';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 502 || status === 503 || status === 504) return 'network';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Fallback classifier when the HTTP status is not available (e.g., error came
 * from a thrown Error or an aggregated failure message). Uses word-boundary
 * regexes so stray digits inside a message don't misclassify the bucket.
 */
export function classifyErrorString(raw: string | undefined | null): LLMErrorCode {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase();
  // 403 and 401 need different advice (no model access vs. a bad key), so the
  // authoritative markers for a permission failure are checked first. The
  // softer permission wording is checked *after* auth, because providers mix
  // it into 401 bodies too and a stated 401 is the better signal.
  if (
    /\b403\b/.test(s) ||
    s.includes('forbidden') ||
    s.includes('permission_error') || s.includes('permission_denied')
  ) return 'forbidden';
  if (
    /\b401\b/.test(s) ||
    s.includes('unauthorized') || s.includes('api key') ||
    s.includes('invalid_api_key') || s.includes('invalid x-api-key') ||
    s.includes('authentication')
  ) return 'auth';
  // "not have access" covers both wordings providers use ("you do not have
  // access to model X", "project ... does not have access to model X").
  if (
    s.includes('permission denied') || s.includes('not have access')
  ) return 'forbidden';
  if (
    /\b429\b/.test(s) ||
    s.includes('rate limit') || s.includes('too many requests') ||
    s.includes('insufficient_quota') || s.includes('quota')
  ) return 'rate_limit';
  if (
    /\b(502|503|504)\b/.test(s) ||
    s.includes('timeout') || s.includes('temporarily unavailable') ||
    s.includes('econnrefused') || s.includes('enotfound') ||
    s.includes('network')
  ) return 'network';
  if (/\b404\b/.test(s) || s.includes('not found') || s.includes('model_not_found')) return 'not_found';
  if (/\b(400|422)\b/.test(s) || s.includes('bad request') || s.includes('invalid_request')) return 'bad_request';
  if (/\b5\d\d\b/.test(s) || s.includes('internal server error')) return 'server';
  return 'unknown';
}

export type LLMOptions = {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: LLMTool[];
  stream?: boolean;
  tool_choice?: 'auto' | 'none' | 'required';  // 'auto' enables tool calling when available
};

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  stream(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamEvent>;
  listModels(): Promise<string[]>;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB base64 limit

export function guardImageSize(block: ContentBlock): ContentBlock {
  if (block.type === 'image' && block.source.data.length > MAX_IMAGE_BYTES) {
    return { type: 'text', text: '[Image too large to send — saved to disk instead]' };
  }
  return block;
}
