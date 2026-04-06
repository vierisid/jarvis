import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
  LLMToolCall,
} from './provider.ts';
import { compactHistory, calculateHistoryBudget } from './history.ts';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
};

type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicToolUse = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | AnthropicToolUse;

type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};

type AnthropicStreamEvent =
  | { type: 'message_start'; message: Partial<AnthropicResponse> }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string; usage?: { output_tokens: number } } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

const MAX_RETRIES = 0;
const RETRY_BASE_DELAY_MS = 5000; // 5s, 10s, 20s

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private apiKey: string;
  private defaultModel: string;
  private apiUrl = 'https://api.anthropic.com/v1/messages';

  constructor(apiKey: string, defaultModel = 'claude-sonnet-4-5-20250929') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  /**
   * Make an API request with retry on rate limit (429) and server errors (5xx).
   */
  private async fetchWithRetry(body: string, stream: boolean = false): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body,
      });

      if (response.ok) return response;

      // Retry on rate limit (429) or server error (5xx)
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Anthropic] ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await Bun.sleep(delay);
        continue;
      }

      // Non-retryable error
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    throw new Error('Anthropic API: max retries exceeded');
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const { model = this.defaultModel, temperature, max_tokens = 16384, tools, tool_choice } = options;

    // Compact history for Claude's context window
    const budget = calculateHistoryBudget(200000);
    const compactedMessages = compactHistory(messages, budget);

    const { system, messages: anthropicMessages } = this.convertMessages(compactedMessages);
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens,
    };

    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      // Anthropic uses budget_tokens for tool use (no explicit tool_choice needed)
    }

    const response = await this.fetchWithRetry(JSON.stringify(body));
    const data = await response.json() as AnthropicResponse;
    return this.convertResponse(data);
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncIterable<LLMStreamEvent> {
    const { model = this.defaultModel, temperature, max_tokens = 16384, tools, tool_choice } = options;

    // Compact history for Claude's context window
    const budget = calculateHistoryBudget(200000);
    const compactedMessages = compactHistory(messages, budget);

    const { system, messages: anthropicMessages } = this.convertMessages(compactedMessages);
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens,
      stream: true,
    };

    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      // Anthropic automatically uses tools when provided (no explicit tool_choice needed)
    }
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
    }

    let response: Response;
    try {
      response = await this.fetchWithRetry(JSON.stringify(body), true);
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    let accumulatedText = '';
    const toolCalls: LLMToolCall[] = [];
    let currentToolCall: { id: string; name: string; input_json: string } | null = null;
    let stopReason: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let responseModel = model;

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
            const event = JSON.parse(data) as AnthropicStreamEvent;

            if (event.type === 'message_start' && event.message.usage) {
              usage.input_tokens = event.message.usage.input_tokens;
              if (event.message.model) responseModel = event.message.model;
            } else if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                currentToolCall = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  input_json: '',
                };
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                accumulatedText += event.delta.text;
                yield { type: 'text', text: event.delta.text };
              } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
                currentToolCall.input_json += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop' && currentToolCall) {
              try {
                const toolCall: LLMToolCall = {
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: JSON.parse(currentToolCall.input_json || '{}'),
                };
                toolCalls.push(toolCall);
                yield { type: 'tool_call', tool_call: toolCall };
              } catch (err) {
                // Truncated JSON (e.g., max_tokens hit mid-tool-call)
                // Warn the agent so it can retry with smaller chunks
                const truncLen = currentToolCall.input_json?.length ?? 0;
                console.error(`[Anthropic] Tool call '${currentToolCall.name}' truncated (${truncLen} chars of JSON). max_tokens likely hit.`);
                const warning = `\n\n[SYSTEM WARNING: Your tool call to "${currentToolCall.name}" was truncated due to output token limits. ` +
                  `The call was NOT executed. If you were writing long content, use append_body with shorter chunks (under 1000 words per call).]`;
                accumulatedText += warning;
                yield { type: 'text', text: warning };
              }
              currentToolCall = null;
            } else if (event.type === 'message_delta') {
              stopReason = event.delta.stop_reason;
              if (event.delta.usage) {
                usage.output_tokens = event.delta.usage.output_tokens;
              }
            } else if (event.type === 'error') {
              yield { type: 'error', error: `${event.error.type}: ${event.error.message}` };
              return;
            }
          } catch (err) {
            // Skip invalid JSON lines
            console.error('Failed to parse SSE event:', err);
          }
        }
      }

      const finishReason = this.mapStopReason(stopReason);
      yield {
        type: 'done',
        response: {
          content: accumulatedText,
          tool_calls: toolCalls,
          usage,
          model: responseModel,
          finish_reason: finishReason,
        },
      };
    } catch (err) {
      yield { type: 'error', error: `Stream error: ${err}` };
    }
  }

  async listModels(): Promise<string[]> {
    // Anthropic doesn't have a models endpoint, so return known models
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  private convertMessages(messages: LLMMessage[]): {
    system?: string;
    messages: AnthropicMessage[];
  } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const system = systemMessages.map(m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')).join('\n\n') || undefined;

    const anthropicMessages: AnthropicMessage[] = [];
    const nonSystem = messages.filter(m => m.role !== 'system');

    let i = 0;
    while (i < nonSystem.length) {
      const msg = nonSystem[i];

      if (msg!.role === 'assistant' && msg!.tool_calls && msg!.tool_calls.length > 0) {
        // Assistant message with tool use → content blocks
        const content: Array<{ type: string; [key: string]: unknown }> = [];
        if (msg!.content) {
          const textContent = typeof msg!.content === 'string' ? msg!.content : msg!.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
          if (textContent) content.push({ type: 'text', text: textContent });
        }
        for (const tc of msg!.tool_calls!) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
        i++;

        // Collect subsequent tool result messages into a single user message
        const toolResults: Array<{ type: string; [key: string]: unknown }> = [];
        while (i < nonSystem.length && nonSystem[i]!.role === 'tool') {
          const toolMsg = nonSystem[i]!;
          // ContentBlock[] → pass as structured content (supports images)
          // string → pass as-is (backward-compatible)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.tool_call_id,
            content: toolMsg.content,
          });
          i++;
        }
        if (toolResults.length > 0) {
          anthropicMessages.push({ role: 'user', content: toolResults });
        }
      } else if (msg!.role === 'tool') {
        // Standalone tool result (shouldn't happen but handle gracefully)
        anthropicMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg!.tool_call_id, content: msg!.content }],
        });
        i++;
      } else {
        // Regular user or assistant message
        // ContentBlock[] passes through (supports images in user messages)
        anthropicMessages.push({
          role: msg!.role as 'user' | 'assistant',
          content: msg!.content as string | Array<{ type: string; [key: string]: unknown }>,
        });
        i++;
      }
    }

    return { system, messages: anthropicMessages };
  }

  private convertTools(tools: LLMTool[]): AnthropicToolDef[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  private convertResponse(response: AnthropicResponse): LLMResponse {
    let content = '';
    const tool_calls: LLMToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      model: response.model,
      finish_reason: this.mapStopReason(response.stop_reason),
    };
  }

  private mapStopReason(stopReason: string | null): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }
}
