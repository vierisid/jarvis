import { truncateHead } from '../util/truncate.ts';
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
  /**
   * Set by a provider when the model's arguments were not valid JSON. The
   * call is still delivered (with empty `arguments`) so the loop can answer it
   * with a tool error the model can read and correct, the way it answers a tool
   * name that does not exist, instead of ending the turn. Every loop that
   * dispatches calls must answer such a call with `malformedArgumentsResult`
   * BEFORE anything else reads it (discovery, off-list admission, special
   * tools): its empty `arguments` are not what the model asked for and must
   * never be run. A short fixed phrase, never the arguments themselves.
   */
  argumentsError?: string;
};

/** Reasons a provider may set as `argumentsError`; anything else is reported as unreadable. */
const ARGUMENTS_ERROR_REASONS = new Set(['not valid JSON', 'expected a JSON object']);

/**
 * The tool result for a call whose arguments could not be read. Never ran
 * anything. Only fixed text and the tool name (model output, bounded and
 * quoted as a JSON string) go back: never the arguments or a parser message.
 */
export function malformedArgumentsResult(call: Pick<LLMToolCall, 'name' | 'argumentsError'>): string {
  const reason = call.argumentsError !== undefined && ARGUMENTS_ERROR_REASONS.has(call.argumentsError)
    ? call.argumentsError : 'unreadable';
  return `Error: the arguments for ${JSON.stringify(String(call.name).slice(0, 100))} were not valid JSON (${reason}). `
    + 'The tool did not run. Call it again with valid JSON arguments.';
}

/**
 * Tool call ids must be unique within one assistant message: a provider keys
 * each tool result on its id, and a strict one rejects the next request when
 * two results share one. A model (or a compatible server) that repeats or omits
 * an id gets the later calls renamed, so each call still runs exactly once.
 */
export function withUniqueToolCallIds(calls: LLMToolCall[]): LLMToolCall[] {
  const seen = new Set<string>();
  return calls.map((call, index) => {
    let id = call.id || `call_${index + 1}`;
    for (let n = 2; seen.has(id); n++) id = `${call.id || `call_${index + 1}`}_${n}`;
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

export type LLMResponse = {
  content: string;
  tool_calls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  finish_reason: 'stop' | 'tool_use' | 'length' | 'error';
};

export type LLMUsage = {
  // Normalized across providers: input_tokens counts only UNCACHED prompt
  // tokens (billed at full price). The full prompt size is
  // input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;      // tokens served from provider prompt cache (~0.1x on Anthropic, 0.5x on OpenAI)
  cache_creation_input_tokens?: number;  // tokens written to provider prompt cache (1.25x on Anthropic; always 0 on OpenAI)
};

/** Whether any token count of `usage` is non-zero. */
export function hasUsage(usage: LLMUsage): boolean {
  return usage.input_tokens > 0 || usage.output_tokens > 0
    || (usage.cache_read_input_tokens ?? 0) > 0 || (usage.cache_creation_input_tokens ?? 0) > 0;
}

/** Adds `from` into `into`, so a call's failed attempts still count (#1258). */
export function addUsage(into: LLMUsage, from: LLMUsage | undefined): void {
  if (!from) return;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  if (from.cache_read_input_tokens) {
    into.cache_read_input_tokens = (into.cache_read_input_tokens ?? 0) + from.cache_read_input_tokens;
  }
  if (from.cache_creation_input_tokens) {
    into.cache_creation_input_tokens = (into.cache_creation_input_tokens ?? 0) + from.cache_creation_input_tokens;
  }
}

/**
 * Structured classification for provider/stream errors. Lets the UI render
 * user-facing copy without string-matching the upstream error message.
 */
export type LLMErrorCode =
  | 'background_throttled' // local resource admission refused; never retry/fail over
  | 'auth'         // 401, invalid or missing API key
  | 'forbidden'    // 403, credentials accepted but this model/endpoint is not allowed
  | 'rate_limit'   // 429, quota exhausted
  | 'network'      // timeout, connection refused, 502/503/504
  | 'bad_request'  // 400/422, invalid parameters
  | 'unsupported_tools' // explicit lack of tool-calling support, not an arbitrary 400
  | 'not_found'    // 404, model/resource missing
  | 'server'       // generic 5xx, or a reply the provider sent that cannot be read
  | 'tool_loop_limit' // Jarvis stopped a turn that kept calling tools; not a provider failure
  // Hosted (usejarvis_ai) outcomes that retrying cannot change. None of them
  // is retried on the same provider; see LLMManager.shouldFailOver for which
  // may still move to another one.
  | 'quota_exhausted' // the plan's included usage is used up for this window
  | 'content_policy'  // the platform's content policy blocked this request
  | 'restricted'      // hosted AI is restricted on this account
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
  /**
   * `usage` is what the provider already reported before the failure (for
   * example a stream cut off after message_start), so the tokens it already
   * reported are not recorded as zero (#1258).
   *
   * `hosted_detail` is set only by the hosted (usejarvis_ai) provider: its own
   * authored sentence for this account (when usage resumes, where to appeal),
   * never an upstream body, so a surface that shows no raw error may show it.
   */
  | { type: 'error'; error: string; code?: LLMErrorCode; retry_after_ms?: number; usage?: LLMUsage; hosted_detail?: string };

/** HTTP-aware provider failure used to carry Retry-After into the router. */
export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly code: LLMErrorCode,
    readonly retryAfterMs?: number,
    /** Usage the provider reported before failing (#1258). */
    readonly usage?: LLMUsage,
    /** The hosted provider's authored copy for this account; see the stream event's `hosted_detail`. */
    readonly hostedDetail?: string,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

/** Typed outcomes take precedence. A generic HTTP 400 may be refined only
 * when its body explicitly identifies unsupported tool calling.
 */
export function getLLMErrorCode(error: unknown): LLMErrorCode {
  if (error instanceof LLMProviderError) {
    if (error.code === 'bad_request' && classifyErrorString(error.message) === 'unsupported_tools') return 'unsupported_tools';
    return error.code;
  }
  return classifyErrorString(error instanceof Error ? error.message : String(error));
}

/**
 * An HTTP `Retry-After` header (delta-seconds or HTTP-date) in milliseconds.
 *
 * Undefined when absent or unreadable: that is "no hint", which the manager
 * reads as "retry without a pause", so a parse that guessed would be worse
 * than none.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
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
    s.includes('timeout') || /\btimed\s+out\b/.test(s) || s.includes('temporarily unavailable') ||
    s.includes('econnrefused') || s.includes('enotfound') ||
    s.includes('network')
  ) return 'network';
  if (/\b404\b/.test(s) || s.includes('not found') || s.includes('model_not_found')) return 'not_found';
  if (/\b5\d\d\b/.test(s) || s.includes('internal server error')) return 'server';
  if (
    /\b(?:tools?|tool[_ -](?:calling|use)|function[_ -]calling)['"]?\s+(?:(?:is|are)\s+)?(?:not supported|unsupported)\b/.test(s) ||
    /\b(?:does not|doesn't|do not|cannot)\s+support\s+(?:tools?|tool[_ -](?:calling|use)|function[_ -]calling)\b/.test(s) ||
    /\bunsupported (?:parameter|field)\s*:\s*['"]?(?:tools|tool_choice)\b/.test(s)
  ) return 'unsupported_tools';
  if (/\b(400|422)\b/.test(s) || s.includes('bad request') || s.includes('invalid_request')) return 'bad_request';
  return 'unknown';
}

export type LLMOptions = {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: LLMTool[];
  stream?: boolean;
  tool_choice?: 'auto' | 'none' | 'required';  // 'auto' enables tool calling when available
  /**
   * Aborts the underlying request. The manager sets it so a request it has
   * already given up on (its timeout) stops running at the provider instead of
   * holding a slot there while the retry goes out. A caller may also pass its
   * own; the manager composes the two, so cancelling the caller's also stops
   * further retries and tier failover.
   */
  signal?: AbortSignal;
  /**
   * Check the caller's absolute monotonic deadline, aborting its signal and
   * throwing when expired. Non-streaming routing calls this before every
   * provider attempt and after settlement, even if the abort timer is delayed.
   */
  checkDeadline?: () => void;
  /**
   * Internal resource admission for a provider's retry of the same messages.
   * Call only after the previous transport settles, before starting another,
   * and use the returned options (including any lower output limit). Throws
   * when the retry cannot be reserved. Unset for foreground/unmanaged calls.
   */
  reserveRetry?: (options: LLMOptions) => LLMOptions;
};

export interface LLMProvider {
  name: string;
  /**
   * True when the built-in default model is a guess rather than one the
   * endpoint is known to serve (local servers and gateways serve whatever
   * their operator installed). Tier failover never retries such a provider
   * without a model: the guess cannot recover a failed request and replaces
   * the real error with an unrelated "model not found".
   */
  readonly placeholderDefaultModel?: boolean;
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

/**
 * The text blocks of a multi-modal tool result cut to `maxChars` IN TOTAL, the
 * budget the plain-string path gives one result (#876). Applied to the payload
 * BEFORE it is framed, never to framed text, so a cut never drops a closing
 * line. Under the budget the same array comes back untouched. Over it, the text
 * block that crosses the budget keeps its head plus a note giving the total
 * (or, when the budget ran out exactly before it, the last kept text block
 * carries the note), later text blocks are dropped, and every non-text block is kept;
 * images are bounded separately by `guardImageSize`.
 */
export function capTextBlocks(blocks: ContentBlock[], maxChars: number): ContentBlock[] {
  let total = 0;
  for (const b of blocks) if (b.type === 'text') total += b.text.length;
  if (total <= maxChars) return blocks;
  let budget = maxChars;
  let cut = false;
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type !== 'text') { out.push(b); continue; }
    if (cut) continue;
    if (b.text.length <= budget) { budget -= b.text.length; out.push(b); continue; }
    cut = true;
    const note = `\n... (truncated, was ${total} chars)`;
    // Budget spent exactly by the blocks before: put the note on the last text
    // block kept rather than send a block that holds nothing but the note.
    const lastText = budget === 0 ? out.findLastIndex((k) => k.type === 'text') : -1;
    if (lastText >= 0) {
      out[lastText] = { type: 'text', text: (out[lastText] as { text: string }).text + note };
      continue;
    }
    out.push({ type: 'text', text: truncateHead(b.text, budget) + note });
  }
  return out;
}
