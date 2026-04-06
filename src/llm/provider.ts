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

export type LLMStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool_call: LLMToolCall }
  | { type: 'done'; response: LLMResponse }
  | { type: 'error'; error: string };

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
