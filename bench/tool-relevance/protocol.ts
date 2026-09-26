/**
 * Wire-format parsing for the benchmark, kept pure so it is tested.
 *
 * Two protocols: ollama's /api/chat and the OpenAI /chat/completions shape
 * that llama.cpp's llama-server, LM Studio, vLLM and OpenRouter speak. What
 * matters is the first tool call and how many prompt tokens the server
 * actually EVALUATED, because that is what the cache criterion is about.
 */

export type ToolCallOut = { id: string; name: string; args: Record<string, unknown> };

export type Reply = {
  call: ToolCallOut | null;
  /** How many tool calls the reply carried; only the first is followed. */
  callCount: number;
  /** Assistant text alongside the call, fed back into selection like production. */
  content: string;
  /** Prompt tokens in the request, when the server reports them. */
  promptTokens: number | null;
  /** Prompt tokens the server actually evaluated (not served from cache). */
  evaluatedTokens: number | null;
  prefillMs: number | null;
};

/**
 * Arguments arrive as a JSON string (OpenAI) or an object (ollama, and some
 * OpenAI-compatible servers). Parsing an object as a string threw and fell
 * back to `{}`, which turned `discover_tools({names})` into a catalogue read.
 */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

type OllamaBody = {
  message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
};

/**
 * ollama reports only what it evaluated; a cached prefix is not counted.
 * Its metrics fields are `omitempty`, so a fully cached prompt can arrive
 * with no `prompt_eval_count` at all: on a successful response that means
 * 0, not "unknown" -- otherwise one fully warm request would turn the whole
 * run into NO CACHE RESULT.
 */
export function parseOllamaReply(body: OllamaBody, fallbackId: string): Reply {
  const calls = body.message?.tool_calls ?? [];
  const fn = calls[0]?.function;
  return {
    call: fn?.name ? { id: fallbackId, name: fn.name, args: parseArgs(fn.arguments) } : null,
    callCount: calls.length,
    content: body.message?.content ?? '',
    promptTokens: null,
    evaluatedTokens: body.prompt_eval_count ?? 0,
    prefillMs: body.prompt_eval_duration !== undefined ? Math.round(body.prompt_eval_duration / 1e6) : null,
  };
}

type OpenAIBody = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>;
  usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  timings?: { prompt_n?: number; prompt_ms?: number; cache_n?: number };
};

/**
 * Evaluated tokens, most specific source first: llama-server's own
 * `timings.prompt_n`, then the OpenAI `cached_tokens` split. With neither,
 * the server is not saying what it cached, and the cache criterion cannot
 * be read -- null, never a guess.
 */
export function parseOpenAIReply(body: OpenAIBody, fallbackId: string): Reply {
  const msg = body.choices?.[0]?.message;
  const calls = msg?.tool_calls ?? [];
  const tc = calls[0];
  const prompt = body.usage?.prompt_tokens ?? null;
  const cached = body.usage?.prompt_tokens_details?.cached_tokens;
  return {
    call: tc?.function?.name ? { id: tc.id ?? fallbackId, name: tc.function.name, args: parseArgs(tc.function.arguments) } : null,
    callCount: calls.length,
    content: msg?.content ?? '',
    promptTokens: prompt,
    evaluatedTokens: body.timings?.prompt_n ?? (prompt !== null && typeof cached === 'number' ? prompt - cached : null),
    prefillMs: body.timings?.prompt_ms !== undefined ? Math.round(body.timings.prompt_ms) : null,
  };
}

/**
 * `OLLAMA_HOST` is often set the way the SERVER reads it: no scheme, or the
 * bind address `0.0.0.0`. As a client URL both fail every request.
 */
export function normalizeOllamaHost(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, '$1127.0.0.1');
  if (!/:\d+(\/|$)/.test(url.replace(/^https?:\/\//i, ''))) url = url.replace(/\/*$/, ':11434');
  return url.replace(/\/+$/, '');
}

/** A non-negative integer flag, or an error. `--max-calls abc` used to remove the cap. */
export function parseCount(flag: string, raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n)) {
    throw new Error(`${flag} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}
