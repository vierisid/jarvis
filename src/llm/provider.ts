export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: LLMToolCall[];   // present on assistant messages with tool use
  tool_call_id?: string;        // present on tool result messages
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
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
};

/**
 * Structured classification for provider/stream errors. Lets the UI render
 * user-facing copy without string-matching the upstream error message.
 */
export type LLMErrorCode =
  | 'auth'         // invalid API key, unauthorized
  | 'rate_limit'   // 429, quota exhausted
  | 'network'      // timeout, connection refused, 502/503/504
  | 'bad_request'  // 400/422, invalid parameters
  | 'not_found'    // 404, model/resource missing
  | 'server'       // generic 5xx
  | 'unknown';

export type LLMStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool_call: LLMToolCall }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; error: string; code?: LLMErrorCode };

/**
 * Map an HTTP status code returned by a provider to a canonical error code.
 * Use this at the emission site (where the status is still available) so the
 * UI doesn't have to guess from the error string.
 */
export function classifyHttpStatus(status: number): LLMErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
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
  if (
    /\b401\b/.test(s) || /\b403\b/.test(s) ||
    s.includes('unauthorized') || s.includes('api key') ||
    s.includes('invalid_api_key') || s.includes('invalid x-api-key') ||
    s.includes('authentication')
  ) return 'auth';
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
