import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
  LLMToolCall,
} from './provider.ts';

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
};

type OllamaToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OllamaResponse = {
  model: string;
  created_at: string;
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

type OllamaStreamChunk = {
  model: string;
  created_at: string;
  message?: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

type OllamaModelInfo = {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
};

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private baseUrl: string;
  private defaultModel: string;

  constructor(baseUrl = 'http://localhost:11434', defaultModel = 'llama3') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.defaultModel = defaultModel;
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const { model = this.defaultModel, temperature, tools } = options;

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(messages),
      stream: false,
    };

    if (temperature !== undefined) {
      body.options = { temperature };
    }

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as OllamaResponse;
    return this.convertResponse(data);
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncIterable<LLMStreamEvent> {
    const { model = this.defaultModel, temperature, tools } = options;

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(messages),
      stream: true,
    };

    if (temperature !== undefined) {
      body.options = { temperature };
    }

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: `Ollama API error (${response.status}): ${errorText}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    let accumulatedText = '';
    const toolCalls: LLMToolCall[] = [];
    let responseModel = model;
    let inputTokens = 0;
    let outputTokens = 0;

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
          if (!line.trim()) continue;

          try {
            const chunk = JSON.parse(line) as OllamaStreamChunk;
            responseModel = chunk.model;

            if (chunk.message?.content) {
              accumulatedText += chunk.message.content;
              yield { type: 'text', text: chunk.message.content };
            }

            if (chunk.message?.tool_calls) {
              for (const toolCall of chunk.message.tool_calls) {
                const id = `ollama_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                const call: LLMToolCall = {
                  id,
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                };
                toolCalls.push(call);
                yield { type: 'tool_call', tool_call: call };
              }
            }

            if (chunk.done) {
              inputTokens = chunk.prompt_eval_count || 0;
              outputTokens = chunk.eval_count || 0;

              yield {
                type: 'done',
                response: {
                  content: accumulatedText,
                  tool_calls: toolCalls,
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                  model: responseModel,
                  finish_reason: toolCalls.length > 0 ? 'tool_use' : 'stop',
                },
              };
            }
          } catch (err) {
            console.error('Failed to parse Ollama chunk:', err);
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: `Stream error: ${err}` };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);

      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }

      const data = await response.json() as { models: OllamaModelInfo[] };
      return data.models.map(m => m.name).sort();
    } catch (err) {
      // Fallback to common models if API call fails
      return ['llama3', 'llama2', 'mistral', 'mixtral', 'codellama'];
    }
  }

  private convertMessages(messages: LLMMessage[]): OllamaMessage[] {
    return messages.map(m => {
      if (typeof m.content === 'string') {
        return {
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        };
      }

      // ContentBlock[] — extract text and images separately
      let text = '';
      const images: string[] = [];

      for (const block of m.content) {
        if (block.type === 'text') {
          text += (text ? '\n' : '') + block.text;
        } else if (block.type === 'image') {
          images.push(block.source.data);
        }
      }

      const msg: OllamaMessage = {
        role: m.role as 'system' | 'user' | 'assistant',
        content: text,
      };
      if (images.length > 0) {
        msg.images = images;
      }
      return msg;
    });
  }

  private convertTools(tools: LLMTool[]): OllamaToolDef[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private convertResponse(response: OllamaResponse): LLMResponse {
    const content = response.message.content;
    const tool_calls: LLMToolCall[] = [];

    if (response.message.tool_calls) {
      for (const toolCall of response.message.tool_calls) {
        const id = `ollama_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        tool_calls.push({
          id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
    }

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: response.prompt_eval_count || 0,
        output_tokens: response.eval_count || 0,
      },
      model: response.model,
      finish_reason: tool_calls.length > 0 ? 'tool_use' : 'stop',
    };
  }
}
