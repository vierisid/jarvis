import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
  LLMToolCall,
} from './provider.ts';
type GroqMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
};

type GroqToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type GroqToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type GroqResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: GroqToolCall[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type GroqStreamChunk = {
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
};

export class GroqProvider implements LLMProvider {
  name = 'groq';
  private apiKey: string;
  private defaultModel: string;
  private apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
  private static readonly SAFE_PROMPT_CHAR_BUDGET = 24_000;
  private static readonly SAFE_TOOL_OVERHEAD_CHARS = 8_000;
  private static readonly RETRY_PROMPT_CHAR_BUDGET = 12_000;
  private static readonly MAX_SYSTEM_MESSAGE_CHARS = 8_000;
  private static readonly MAX_USER_MESSAGE_CHARS = 3_500;
  private static readonly MAX_ASSISTANT_MESSAGE_CHARS = 3_500;
  private static readonly MAX_TOOL_MESSAGE_CHARS = 2_000;
  private static readonly MIN_RECENT_MESSAGES = 6;

  constructor(apiKey: string, defaultModel = 'llama-3.3-70b-versatile') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    let response = await this.sendRequest(
      this.buildRequestBody(messages, options, false, GroqProvider.SAFE_PROMPT_CHAR_BUDGET)
    );

    if (!response.ok) {
      const errorText = await response.text();
      if (this.isRequestTooLargeError(response.status, errorText)) {
        response = await this.sendRequest(
          this.buildRequestBody(messages, options, false, GroqProvider.RETRY_PROMPT_CHAR_BUDGET)
        );
      } else {
        throw new Error(`Groq API error (${response.status}): ${errorText}`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as GroqResponse;
    return this.convertResponse(data);
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncIterable<LLMStreamEvent> {
    const body = this.buildRequestBody(
      messages,
      options,
      true,
      GroqProvider.SAFE_PROMPT_CHAR_BUDGET,
    );
    const responseModel = typeof body.model === 'string' ? body.model : this.defaultModel;

    let response = await this.sendRequest(body);

    if (!response.ok) {
      const errorText = await response.text();
      if (this.isRequestTooLargeError(response.status, errorText)) {
        response = await this.sendRequest(
          this.buildRequestBody(
            messages,
            options,
            true,
            GroqProvider.RETRY_PROMPT_CHAR_BUDGET,
          )
        );
      } else {
        yield { type: 'error', error: `Groq API error (${response.status}): ${errorText}` };
        return;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: `Groq API error (${response.status}): ${errorText}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    let accumulatedText = '';
    const toolCalls: LLMToolCall[] = [];
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let finishReason: string | null = null;
    let streamedModel = responseModel;

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
            const chunk = JSON.parse(data) as GroqStreamChunk;
            if (chunk.choices && chunk.choices.length > 0) {
              const choice = chunk.choices[0];
              streamedModel = chunk.model;

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
          yield { type: 'error', error: `Failed to parse tool call arguments: ${err}` };
        }
      }

      const mappedFinishReason = this.mapFinishReason(finishReason);
      yield {
        type: 'done',
        response: {
          content: accumulatedText,
          tool_calls: toolCalls,
          usage: { input_tokens: 0, output_tokens: 0 },
          model: streamedModel,
          finish_reason: mappedFinishReason,
        },
      };
    } catch (err) {
      yield { type: 'error', error: `Stream error: ${err}` };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }

      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map(m => m.id).sort();
    } catch (_err) {
      return [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'qwen/qwen3-32b',
        'deepseek-r1-distill-llama-70b',
      ];
    }
  }

  private buildRequestBody(
    messages: LLMMessage[],
    options: LLMOptions,
    stream: boolean,
    promptBudget: number
  ): Record<string, unknown> {
    const { model = this.defaultModel, temperature, max_tokens, tools } = options;
    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(this.compactMessages(messages, promptBudget, tools)),
    };

    if (stream) body.stream = true;
    if (temperature !== undefined) body.temperature = temperature;
    if (max_tokens !== undefined) body.max_completion_tokens = max_tokens;
    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    return body;
  }

  private async sendRequest(body: Record<string, unknown>): Promise<Response> {
    return fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private convertMessages(messages: LLMMessage[]): GroqMessage[] {
    return messages.map(m => {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n');
      const hasToolCalls = !!(m.tool_calls && m.tool_calls.length > 0);
      const msg: GroqMessage = {
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: hasToolCalls && text.trim().length === 0 ? null : text,
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

  private compactMessages(messages: LLMMessage[], promptBudget: number, tools?: LLMTool[]): LLMMessage[] {
    const toolOverhead = tools && tools.length > 0
      ? Math.min(
        GroqProvider.SAFE_TOOL_OVERHEAD_CHARS,
        JSON.stringify(this.convertTools(tools)).length,
      )
      : 0;
    const budget = Math.max(6_000, promptBudget - toolOverhead);
    const normalized = messages.map((message) => this.normalizeMessage(message));
    const systemMessages = normalized.filter((message) => message.role === 'system');
    const nonSystemMessages = normalized.filter((message) => message.role !== 'system');
    const usedBySystems = systemMessages.reduce((sum, message) => sum + this.measureMessage(message), 0);
    let remainingBudget = Math.max(budget - usedBySystems, 0);

    if (nonSystemMessages.length === 0) {
      return systemMessages;
    }

    const recentCount = Math.min(nonSystemMessages.length, GroqProvider.MIN_RECENT_MESSAGES);
    const olderMessages = nonSystemMessages.slice(0, nonSystemMessages.length - recentCount);
    const recentMessages = nonSystemMessages.slice(-recentCount);
    const recentBudget = Math.max(Math.floor(remainingBudget / Math.max(recentCount, 1)) - 64, 240);
    const selectedOlder: LLMMessage[] = [];
    const selectedRecent: LLMMessage[] = [];

    for (const message of recentMessages) {
      const candidate = this.normalizeMessage(message, recentBudget);
      const candidateSize = this.measureMessage(candidate);
      if (candidateSize <= remainingBudget) {
        selectedRecent.push(candidate);
        remainingBudget -= candidateSize;
      }
    }

    for (let i = olderMessages.length - 1; i >= 0; i--) {
      const candidate = olderMessages[i]!;
      const candidateSize = this.measureMessage(candidate);
      if (candidateSize <= remainingBudget) {
        selectedOlder.unshift(candidate);
        remainingBudget -= candidateSize;
      }
    }

    return [...systemMessages, ...selectedOlder, ...selectedRecent];
  }

  private normalizeMessage(message: LLMMessage, overrideBudget?: number): LLMMessage {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => block.type === 'text' ? block.text : '[image]').join('\n');
    const budget = overrideBudget ?? this.getMessageBudget(message.role);
    return {
      ...message,
      content: this.truncateText(content, budget),
    };
  }

  private getMessageBudget(role: LLMMessage['role']): number {
    switch (role) {
      case 'system':
        return GroqProvider.MAX_SYSTEM_MESSAGE_CHARS;
      case 'tool':
        return GroqProvider.MAX_TOOL_MESSAGE_CHARS;
      case 'assistant':
        return GroqProvider.MAX_ASSISTANT_MESSAGE_CHARS;
      case 'user':
      default:
        return GroqProvider.MAX_USER_MESSAGE_CHARS;
    }
  }

  private truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    if (maxChars <= 80) return text.slice(0, maxChars);
    const head = Math.floor(maxChars * 0.65);
    const tail = Math.max(maxChars - head - 29, 0);
    const suffix = tail > 0 ? text.slice(-tail) : '';
    return `${text.slice(0, head)}\n...[truncated for Groq]...\n${suffix}`;
  }

  private measureMessage(message: LLMMessage): number {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n');
    const toolCallsSize = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
    return content.length + toolCallsSize + 128;
  }

  private isRequestTooLargeError(status: number, errorText: string): boolean {
    return status === 413 || /message is too large|request too large|context length|too many tokens|payload too large/i.test(errorText);
  }

  private convertTools(tools: LLMTool[]): GroqToolDef[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private convertResponse(response: GroqResponse): LLMResponse {
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
      usage: {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      },
      model: response.model,
      finish_reason: this.mapFinishReason(choice!.finish_reason),
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
