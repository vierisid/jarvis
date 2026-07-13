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

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  // Assistant messages that invoked tools must replay those calls, or the
  // model cannot see its own prior actions and re-issues/hallucinates steps.
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  // Tool-result messages: Ollama links results by function name (tool_name);
  // newer servers also accept tool_call_id. Send both.
  tool_name?: string;
  tool_call_id?: string;
};

// Ollama's server-side default num_predict (~128) truncates any structured
// reply mid-JSON and reports it as a normal stop. Always lift the cap.
const DEFAULT_NUM_PREDICT = 4096;
// Small local models emit malformed tool JSON at their default sampling
// temperature (~0.8). Tool-calling turns default low unless the caller opts in.
const DEFAULT_TOOL_TEMPERATURE = 0.2;
// Must match the history budget below AND be sent as num_ctx: Ollama's own
// default context (4096) would silently truncate the 32k history we send.
const DEFAULT_CONTEXT_WINDOW = 32000;

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
  private contextWindow: number;

  constructor(baseUrl = 'http://localhost:11434', defaultModel = 'llama3', contextWindow = DEFAULT_CONTEXT_WINDOW) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.defaultModel = defaultModel;
    this.contextWindow = contextWindow;
  }

  /**
   * Map our cross-provider options to Ollama's `body.options` bag, with
   * defaults that keep tool use alive: lift the ~128-token num_predict cap,
   * pin num_ctx to the same window the history budget assumes, and run
   * tool-calling turns at low temperature unless the caller overrides.
   */
  private buildOptions(options: LLMOptions): Record<string, unknown> {
    const { temperature, max_tokens, tools } = options;
    const ollamaOptions: Record<string, unknown> = {
      num_predict: max_tokens ?? DEFAULT_NUM_PREDICT,
      num_ctx: this.contextWindow,
    };
    if (temperature !== undefined) {
      ollamaOptions.temperature = temperature;
    } else if (tools && tools.length > 0) {
      ollamaOptions.temperature = DEFAULT_TOOL_TEMPERATURE;
    }
    return ollamaOptions;
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const { model = this.defaultModel, tools } = options;

    // Compact history for Ollama's context limits
    const budget = calculateHistoryBudget(this.contextWindow);
    const compactedMessages = compactHistory(messages, budget);

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(compactedMessages),
      stream: false,
      options: this.buildOptions(options),
    };

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
    const { model = this.defaultModel, tools } = options;

    // Compact history for Ollama's context limits
    const budget = calculateHistoryBudget(this.contextWindow);
    const compactedMessages = compactHistory(messages, budget);

    const body: Record<string, unknown> = {
      model,
      messages: this.convertMessages(compactedMessages),
      stream: true,
      options: this.buildOptions(options),
    };

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
      yield {
        type: 'error',
        error: `Ollama API error (${response.status}): ${errorText}`,
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
      yield { type: 'error', error: `Stream error: ${err}`, code: 'network' };
    }
  }

  async listModels(): Promise<string[]> {
    // Deliberately NOT caught: a failed call must not masquerade as an empty
    // or invented install. This used to fall back to a hardcoded list
    // (['llama3', 'llama2', ...]) which was wrong twice over — those models
    // are usually not pulled, and the untagged ids resolve to ':latest',
    // which 404s on first use. Callers decide how to present the failure.
    // The short timeout keeps probes of unroutable hosts (onboarding lets the
    // user point this at any URL) from hanging for the OS connect timeout.
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }

    const data = await response.json() as { models: OllamaModelInfo[] };
    return data.models.map(m => m.name).sort();
  }

  private convertMessages(messages: LLMMessage[]): OllamaMessage[] {
    // Ollama links tool results to calls by function name (tool_name), not by
    // id — recover the name for each tool_call_id from the assistant turns.
    const callNames = new Map<string, string>();
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) callNames.set(tc.id, tc.name);
      }
    }

    return messages.map(m => {
      let text: string;
      const images: string[] = [];

      if (typeof m.content === 'string') {
        text = m.content;
      } else {
        // ContentBlock[] — extract text and images separately
        text = '';
        for (const block of m.content) {
          if (block.type === 'text') {
            text += (text ? '\n' : '') + block.text;
          } else if (block.type === 'image') {
            images.push(block.source.data);
          }
        }
      }

      const msg: OllamaMessage = {
        role: m.role,
        content: text,
      };
      if (images.length > 0) {
        msg.images = images;
      }

      // Replay the assistant's own tool calls — without these the model sees
      // an empty assistant turn and a dangling result, and cannot know which
      // actions it already took (the root cause of re-issued/hallucinated
      // steps on multi-step desktop tasks).
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        msg.tool_calls = m.tool_calls.map(tc => ({
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }

      // Anchor tool results to their call: tool_name for Ollama's linkage,
      // tool_call_id passthrough for servers that support it.
      if (m.role === 'tool' && m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id;
        const name = callNames.get(m.tool_call_id);
        if (name) msg.tool_name = name;
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
