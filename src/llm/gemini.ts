import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
  LLMToolCall,
} from './provider.ts';

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type GeminiResponse = {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: 'model' };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | null;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
};

type GeminiStreamChunk = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: 'model' };
    finishReason?: string | null;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private apiKey: string;
  private defaultModel: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(apiKey: string, defaultModel = 'gemini-3-flash-preview') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  private async fetchWithRetry(url: string, body: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.ok) return response;

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Gemini] ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await Bun.sleep(delay);
        continue;
      }

      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    throw new Error('Gemini API: max retries exceeded');
  }

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const { model = this.defaultModel, temperature, max_tokens, tools } = options;
    const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

    const { systemInstruction, contents } = this.convertMessages(messages);
    const body: Record<string, unknown> = { contents };

    if (systemInstruction) body.systemInstruction = systemInstruction;

    const generationConfig: Record<string, unknown> = {};
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (max_tokens !== undefined) generationConfig.maxOutputTokens = max_tokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: this.convertTools(tools) }];
    }

    const response = await this.fetchWithRetry(url, JSON.stringify(body));
    const data = await response.json() as GeminiResponse;
    return this.convertResponse(data, model);
  }

  async *stream(messages: LLMMessage[], options: LLMOptions = {}): AsyncIterable<LLMStreamEvent> {
    const { model = this.defaultModel, temperature, max_tokens, tools } = options;
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const { systemInstruction, contents } = this.convertMessages(messages);
    const body: Record<string, unknown> = { contents };

    if (systemInstruction) body.systemInstruction = systemInstruction;

    const generationConfig: Record<string, unknown> = {};
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (max_tokens !== undefined) generationConfig.maxOutputTokens = max_tokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: this.convertTools(tools) }];
    }

    let response: Response;
    try {
      response = await this.fetchWithRetry(url, JSON.stringify(body));
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
    let finishReason: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0 };

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
            const chunk = JSON.parse(data) as GeminiStreamChunk;

            if (chunk.usageMetadata) {
              usage.input_tokens = chunk.usageMetadata.promptTokenCount ?? 0;
              usage.output_tokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
            }

            if (chunk.candidates && chunk.candidates.length > 0) {
              const candidate = chunk.candidates[0]!;

              if (candidate.finishReason) {
                finishReason = candidate.finishReason;
              }

              if (candidate.content?.parts) {
                for (const part of candidate.content.parts) {
                  if ('text' in part) {
                    accumulatedText += part.text;
                    yield { type: 'text', text: part.text };
                  } else if ('functionCall' in part) {
                    const toolCall: LLMToolCall = {
                      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args,
                    };
                    toolCalls.push(toolCall);
                    yield { type: 'tool_call', tool_call: toolCall };
                  }
                }
              }
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }

      yield {
        type: 'done',
        response: {
          content: accumulatedText,
          tool_calls: toolCalls,
          usage,
          model,
          finish_reason: this.mapFinishReason(finishReason),
        },
      };
    } catch (err) {
      yield { type: 'error', error: `Stream error: ${err}` };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(
        `${this.baseUrl}/models?key=${this.apiKey}`,
      );

      if (!response.ok) throw new Error(`Failed to list models: ${response.status}`);

      const data = await response.json() as { models: Array<{ name: string }> };
      return data.models
        .map(m => m.name.replace('models/', ''))
        .filter(id => id.startsWith('gemini'))
        .sort();
    } catch {
      return [
        'gemini-3.1-pro-preview',
        'gemini-3-deep-think',
        'gemini-3-flash-preview',
        'gemini-3-1-flash-lite-preview',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ];
    }
  }

  private convertMessages(messages: LLMMessage[]): {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: GeminiContent[];
  } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemText = systemMessages
      .map(m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n'))
      .join('\n\n');

    const systemInstruction = systemText
      ? { parts: [{ text: systemText }] }
      : undefined;

    const contents: GeminiContent[] = [];
    const nonSystem = messages.filter(m => m.role !== 'system');

    for (const msg of nonSystem) {
      if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];

        if (msg.content) {
          const text = typeof msg.content === 'string'
            ? msg.content
            : msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
          if (text) parts.push({ text });
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments },
            });
          }
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool results go as user role with functionResponse
        const responseContent = typeof msg.content === 'string'
          ? (() => { try { return JSON.parse(msg.content); } catch { return { result: msg.content }; } })()
          : { result: msg.content };

        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.tool_call_id ?? 'unknown',
              response: responseContent,
            },
          }],
        });
      } else {
        // User message
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');

        contents.push({ role: 'user', parts: [{ text }] });
      }
    }

    return { systemInstruction, contents };
  }

  private convertTools(tools: LLMTool[]): GeminiFunctionDeclaration[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private convertResponse(response: GeminiResponse, model: string): LLMResponse {
    const candidate = response.candidates?.[0];
    let content = '';
    const tool_calls: LLMToolCall[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if ('text' in part) {
          content += part.text;
        } else if ('functionCall' in part) {
          tool_calls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args,
          });
        }
      }
    }

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: response.modelVersion ?? model,
      finish_reason: this.mapFinishReason(candidate?.finishReason ?? null),
    };
  }

  private mapFinishReason(reason: string | null): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'error';
      default:
        return tool_calls_present(reason) ? 'tool_use' : 'stop';
    }
  }
}

// Gemini doesn't have a distinct "tool_use" finish reason — we detect it
// from the response content instead. This helper is only for the fallback
// in mapFinishReason; the actual tool_call detection happens in convertResponse.
function tool_calls_present(_reason: string | null): boolean {
  return false;
}
