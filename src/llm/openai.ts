import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
  LLMToolCall,
} from './provider.ts';
import { classifyHttpStatus } from './provider.ts';
import { compactHistory, calculateHistoryBudget } from './history.ts';

/**
 * OpenAI reasoning models reject any `temperature` other than the default (1):
 *   400 invalid_request_error "Unsupported value: 'temperature' does not
 *   support 0.6 with this model. Only the default (1) value is supported."
 * Unlike Anthropic's check (presence of the field), this one is on the VALUE —
 * but the only accepted value is the default, so the fix is the same: omit the
 * field and let the API apply its default.
 *
 * Covers the o-series (o1/o3/o4-mini/o3-pro…) and the GPT-5 reasoning family.
 * `gpt-5-chat*` is the non-reasoning variant and DOES accept a custom
 * temperature, so it's excluded. Add new families here if you see that 400.
 */
export function modelRejectsCustomTemperature(model: string): boolean {
  const id = model.toLowerCase();
  if (/^o\d/.test(id)) return true;
  if (id.startsWith('gpt-5') && !id.startsWith('gpt-5-chat')) return true;
  return false;
}

export type OpenAIContentPart =
  // `cache_control` is the Anthropic prompt-cache breakpoint. It is only ever
  // set by the hosted provider (src/llm/usejarvis.ts): LiteLLM forwards the
  // marker to Anthropic when it rides on a content part, and every other
  // upstream ignores the extra key.
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // GPT-4o + later vision models accept an array of content parts on
  // user messages so images can travel inline. System / assistant /
  // tool messages stick to plain string for compatibility.
  content: string | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

type OpenAIToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** LiteLLM surfaces Anthropic's cache WRITE count here when proxying an
     * Anthropic upstream. Folded into prompt_tokens, so it must be subtracted
     * out of input_tokens the same way cached_tokens is. */
    cache_creation_input_tokens?: number;
  };
};

type OpenAIStreamChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  /** Present (non-null) on at most one chunk when the request set
   * stream_options.include_usage. WHERE it appears differs by backend:
   * OpenAI sends a terminal chunk with an EMPTY choices array; the hosted
   * LiteLLM proxy rides it on the LAST CONTENT chunk (choices=1) with no
   * empty-choices terminal at all (platform-verified 2026-08-19). It must
   * therefore be read on every chunk, outside the choices guard. */
  usage?: OpenAIResponse['usage'] | null;
};

export function formatOpenAIHttpError(status: number, contentType: string | null, body: string): string {
  const trimmed = body.trim();
  if (contentType?.toLowerCase().includes('text/html') || /^<!doctype html|^<html/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    return `HTTP ${status}: ${title || 'the server returned an HTML page instead of an OpenAI-compatible API response'}`;
  }
  const compact = trimmed.replace(/\s+/g, ' ');
  return `HTTP ${status}${compact ? `: ${compact.slice(0, 500)}${compact.length > 500 ? '…' : ''}` : ''}`;
}

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  protected apiKey: string;
  protected defaultModel: string;
  protected baseUrl: string;
  protected authHeader: string;
  protected get apiUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }
  protected get modelsUrl(): string {
    return `${this.baseUrl}/models`;
  }
  protected get errorLabel(): string {
    return 'OpenAI';
  }
  /** Whether stream() asks for stream_options.include_usage. Default false:
   * only endpoints known to accept the field opt in (the hosted proxy
   * overrides this) — an unknown property is a 400 on stricter backends. */
  protected get streamIncludeUsage(): boolean {
    return false;
  }

  /** Whether to omit a caller-supplied `temperature` for this model. Delegates
   * to the by-name check by default; overridable because a provider whose model
   * ids are OPAQUE (the hosted proxy's `uj-*` aliases) cannot tell from the name
   * that the alias resolves to a reasoning model, so the name check never fires
   * and every request 400s with "temperature does not support …". */
  protected rejectsCustomTemperature(model: string): boolean {
    return modelRejectsCustomTemperature(model);
  }

  constructor(apiKey: string, defaultModel = 'gpt-4o', baseUrl = 'https://api.openai.com/v1', authHeader = 'Authorization') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // `||` not the default param alone: a stored empty string would otherwise
    // survive and produce a nameless header that fetch rejects at runtime.
    this.authHeader = authHeader || 'Authorization';
  }

  protected requestHeaders(includeContentType = true): Record<string, string> {
    const headers: Record<string, string> = includeContentType ? { 'Content-Type': 'application/json' } : {};
    if (this.apiKey) {
      headers[this.authHeader] = this.authHeader.toLowerCase() === 'authorization'
        ? `Bearer ${this.apiKey}`
        : this.apiKey;
    }
    return headers;
  }

  /**
   * `base` lets a subclass aim one request at an alternate root without
   * touching shared state. Passing it explicitly (rather than swapping
   * `this.baseUrl` around the call) is what keeps concurrent requests from
   * reading each other's root.
   */
  protected postChat(body: Record<string, unknown>, base = this.baseUrl): Promise<Response> {
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
    });
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const { model = this.defaultModel, temperature, max_tokens, tools, tool_choice } = options;

    // Compact history for large contexts (128k token limit)
    const budget = calculateHistoryBudget(128000);
    const compactedMessages = compactHistory(messages, budget);

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(compactedMessages),
    };

    if (temperature !== undefined && !this.rejectsCustomTemperature(model)) {
      body.temperature = temperature;
    }
    if (max_tokens !== undefined) body.max_completion_tokens = max_tokens;
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      body.tool_choice = tool_choice || 'auto';  // Enable tool calling
    }

    const response = await this.postChat(body);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.errorLabel} API error: ${formatOpenAIHttpError(response.status, response.headers.get('content-type'), errorText)}`);
    }

    const data = await response.json() as OpenAIResponse;
    return this.convertResponse(data);
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncIterable<LLMStreamEvent> {
    const { model = this.defaultModel, temperature, max_tokens, tools, tool_choice } = options;

    // Compact history for large contexts (128k token limit)
    const budget = calculateHistoryBudget(128000);
    const compactedMessages = compactHistory(messages, budget);

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(compactedMessages),
      stream: true,
    };
    if (this.streamIncludeUsage) body.stream_options = { include_usage: true };

    if (temperature !== undefined && !this.rejectsCustomTemperature(model)) {
      body.temperature = temperature;
    }
    if (max_tokens !== undefined) body.max_completion_tokens = max_tokens;
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      body.tool_choice = tool_choice || 'auto';  // Enable tool calling
    }

    const response = await this.postChat(body);

    if (!response.ok) {
      const errorText = await response.text();
      yield {
        type: 'error',
        error: `${this.errorLabel} API error: ${formatOpenAIHttpError(response.status, response.headers.get('content-type'), errorText)}`,
        code: classifyHttpStatus(response.status),
      };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body', code: 'network' };
      return;
    }

    let accumulatedText = '';
    const toolCalls: LLMToolCall[] = [];
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finishReason: string | null = null;
    let responseModel = model;
    let streamUsage: OpenAIResponse['usage'] | null = null;

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as OpenAIStreamChunk;
            // Capture usage from WHICHEVER chunk carries it (last one wins),
            // before the choices guard: OpenAI attaches it to an empty-choices
            // terminal chunk, the hosted proxy to the last content chunk.
            if (chunk.usage) streamUsage = chunk.usage;
            if (chunk.choices && chunk.choices.length > 0) {
              const choice = chunk.choices[0];
              responseModel = chunk.model;

              if (choice!.delta.content) {
                accumulatedText += choice!.delta.content;
                yield { type: 'text', text: choice!.delta.content };
              }

              if (choice!.delta.tool_calls) {
                for (const toolCallDelta of choice!.delta.tool_calls) {
                  const index = toolCallDelta.index;
                  let builder = toolCallBuilders.get(index);

                  if (!builder) {
                    builder = {
                      id: toolCallDelta.id || '',
                      name: toolCallDelta.function?.name || '',
                      arguments: '',
                    };
                    toolCallBuilders.set(index, builder);
                  }

                  if (toolCallDelta.id) builder.id = toolCallDelta.id;
                  if (toolCallDelta.function?.name) builder.name = toolCallDelta.function.name;
                  if (toolCallDelta.function?.arguments) {
                    builder.arguments += toolCallDelta.function.arguments;
                  }
                }
              }

              if (choice!.finish_reason) {
                finishReason = choice!.finish_reason;
              }
            }
          } catch (err) {
            // Skip invalid JSON lines
            console.error('Failed to parse SSE chunk:', err);
          }
        }
      }

      // Convert accumulated tool calls
      for (const builder of toolCallBuilders.values()) {
        try {
          const toolCall: LLMToolCall = {
            id: builder.id,
            name: builder.name,
            arguments: JSON.parse(builder.arguments),
          };
          toolCalls.push(toolCall);
          yield { type: 'tool_call', tool_call: toolCall };
        } catch (err) {
          yield { type: 'error', error: `Failed to parse tool call arguments: ${err}`, code: 'bad_request' };
        }
      }

      const mappedFinishReason = this.mapFinishReason(finishReason);
      yield {
        type: 'done',
        response: {
          content: accumulatedText,
          tool_calls: toolCalls,
          // Real usage when the endpoint honoured include_usage (the hosted
          // proxy does); zeros only where usage genuinely isn't streamed.
          usage: streamUsage
            ? this.normalizeUsage(streamUsage)
            : { input_tokens: 0, output_tokens: 0 },
          model: responseModel,
          finish_reason: mappedFinishReason,
        },
      };
    } catch (err) {
      yield { type: 'error', error: `Stream error: ${err}`, code: 'network' };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const headers = this.requestHeaders(false);
      const response = await fetch(this.modelsUrl, { headers });

      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }

      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data
        .map(m => m.id)
        .filter(id => id.startsWith('gpt-') || /^o\d/.test(id)) // gpt-* + the o-series (o1/o3/o4-mini…)
        .sort();
    } catch (err) {
      // Fallback to known models if the live /models call fails.
      return [
        'gpt-5.5',
        'gpt-5.5-pro',
        'gpt-5.4',
        'gpt-5-mini',
        'o4-mini',
      ];
    }
  }

  /** protected so subclasses can decorate the wire messages — the hosted
   * provider attaches Anthropic cache breakpoints here (src/llm/usejarvis.ts). */
  protected convertMessages(messages: LLMMessage[]): OpenAIMessage[] {
    return messages.map(m => {
      // Multi-modal user messages (T19 region capture) need the image to
      // ride alongside the text. OpenAI's vision API takes a content
      // array of {type:'text'} / {type:'image_url'} parts on user
      // messages. Other roles stay string for compat.
      let content: string | OpenAIContentPart[];
      if (typeof m.content === 'string') {
        content = m.content;
      } else if (m.role === 'user' && m.content.some(b => b.type === 'image')) {
        content = m.content.map<OpenAIContentPart>((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          return {
            type: 'image_url',
            image_url: {
              url: `data:${b.source.media_type};base64,${b.source.data}`,
            },
          };
        });
      } else {
        content = m.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n');
      }
      const msg: OpenAIMessage = {
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        // When assistant made tool calls, content must be null (not empty string)
        content: (m.tool_calls && m.tool_calls.length > 0) ? '' : content,
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        msg.tool_calls = m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id;
      }
      return msg;
    });
  }

  private convertTools(tools: LLMTool[]): OpenAIToolDef[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private convertResponse(response: OpenAIResponse): LLMResponse {
    const choice = response.choices[0]!;
    const message = choice.message;
    const content = message.content || '';
    const tool_calls: LLMToolCall[] = [];

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        try {
          tool_calls.push({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments),
          });
        } catch (err) {
          console.error('Failed to parse tool call arguments:', err);
        }
      }
    }

    return {
      content,
      tool_calls,
      usage: this.normalizeUsage(response.usage),
      model: response.model,
      finish_reason: this.mapFinishReason(choice!.finish_reason),
    };
  }

  /** Wire usage → LLMResponse usage. Normalized semantics (see
   * LLMResponse.usage): input_tokens counts only UNCACHED prompt tokens.
   * OpenAI's prompt_tokens includes cached tokens, so subtract them out;
   * Anthropic already reports cache tokens separately from input_tokens.
   *
   * Clamped at zero: the subtraction assumes the proxy folds
   * cache_creation_input_tokens into prompt_tokens (true for current LiteLLM
   * Anthropic mappings, not guaranteed across versions/routes) — an unfolded
   * report would otherwise persist a NEGATIVE count into llm_usage and skew
   * /api/usage totals downward.
   *
   * cache_creation_input_tokens passes through when present: `0` is exactly
   * the signal that Anthropic silently declined to cache — the one field
   * that distinguishes "working" from "declined every time". */
  protected normalizeUsage(usage: OpenAIResponse['usage']): LLMResponse['usage'] {
    return {
      input_tokens: Math.max(0, usage.prompt_tokens
        - (usage.prompt_tokens_details?.cached_tokens ?? 0)
        - (usage.cache_creation_input_tokens ?? 0)),
      output_tokens: usage.completion_tokens,
      ...(usage.prompt_tokens_details?.cached_tokens !== undefined
        ? { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens } : {}),
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
    };
  }

  private mapFinishReason(finishReason: string | null): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (finishReason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'error';
      default:
        return 'stop';
    }
  }
}
