import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { GroqProvider } from './groq.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { LLMManager } from './manager.ts';
import { guardImageSize, type LLMMessage, type ContentBlock } from './provider.ts';
import { isToolResult, type ToolResult } from '../actions/tools/registry.ts';

describe('LLM Provider Types', () => {
  test('AnthropicProvider can be instantiated', () => {
    const provider = new AnthropicProvider('test-key', 'test-model');
    expect(provider.name).toBe('anthropic');
  });

  test('OpenAIProvider can be instantiated', () => {
    const provider = new OpenAIProvider('test-key', 'test-model');
    expect(provider.name).toBe('openai');
  });

  test('GroqProvider can be instantiated', () => {
    const provider = new GroqProvider('test-key', 'test-model');
    expect(provider.name).toBe('groq');
  });

  test('OllamaProvider can be instantiated', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'llama3');
    expect(provider.name).toBe('ollama');
  });

  test('OpenRouterProvider can be instantiated', () => {
    const provider = new OpenRouterProvider('test-key', 'anthropic/claude-sonnet-4');
    expect(provider.name).toBe('openrouter');
  });
});

describe('LLMManager', () => {
  test('can register providers', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    expect(manager.getProvider('anthropic')).toBe(anthropic);
  });

  test('sets first registered provider as primary', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    // Primary is set automatically
    expect(manager.getProvider('anthropic')).toBeDefined();
  });

  test('can change primary provider', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key-1');
    const openai = new OpenAIProvider('test-key-2');

    manager.registerProvider(anthropic);
    manager.registerProvider(openai);
    manager.setPrimary('openai');

    // Should not throw
    expect(manager.getProvider('openai')).toBeDefined();
  });

  test('throws when setting non-existent provider as primary', () => {
    const manager = new LLMManager();
    expect(() => manager.setPrimary('nonexistent')).toThrow();
  });

  test('can set fallback chain', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key-1');
    const openai = new OpenAIProvider('test-key-2');

    manager.registerProvider(anthropic);
    manager.registerProvider(openai);
    manager.setPrimary('anthropic');
    manager.setFallbackChain(['openai']);

    // Should not throw
    expect(manager.getProvider('anthropic')).toBeDefined();
    expect(manager.getProvider('openai')).toBeDefined();
  });

  test('throws when setting non-existent fallback provider', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    expect(() => manager.setFallbackChain(['nonexistent'])).toThrow();
  });
});

describe('Message Types', () => {
  test('LLMMessage has correct structure', () => {
    const message: LLMMessage = {
      role: 'user',
      content: 'Hello',
    };

    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });

  test('supports all message roles', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('assistant');
  });
});

describe('Provider URLs', () => {
  test('AnthropicProvider uses correct API URL', () => {
    const provider = new AnthropicProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  test('OpenAIProvider uses correct API URL', () => {
    const provider = new OpenAIProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('OpenRouterProvider uses correct API URL', () => {
    const provider = new OpenRouterProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  test('GroqProvider uses correct API URL', () => {
    const provider = new GroqProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  test('OllamaProvider uses correct base URL', () => {
    const provider = new OllamaProvider() as any;
    expect(provider.baseUrl).toBe('http://localhost:11434');
  });

  test('OllamaProvider removes trailing slash from base URL', () => {
    const provider = new OllamaProvider('http://localhost:11434/') as any;
    expect(provider.baseUrl).toBe('http://localhost:11434');
  });
});

describe('Default Models', () => {
  test('AnthropicProvider has correct default model', () => {
    const provider = new AnthropicProvider('test-key') as any;
    expect(provider.defaultModel).toBe('claude-sonnet-4-5-20250929');
  });

  test('OpenAIProvider has correct default model', () => {
    const provider = new OpenAIProvider('test-key') as any;
    expect(provider.defaultModel).toBe('gpt-4o');
  });

  test('OllamaProvider has correct default model', () => {
    const provider = new OllamaProvider() as any;
    expect(provider.defaultModel).toBe('llama3');
  });

  test('GroqProvider has correct default model', () => {
    const provider = new GroqProvider('test-key') as any;
    expect(provider.defaultModel).toBe('llama-3.3-70b-versatile');
  });

  test('OpenRouterProvider has correct default model', () => {
    const provider = new OpenRouterProvider('test-key') as any;
    expect(provider.defaultModel).toBe('anthropic/claude-sonnet-4');
  });

  test('can override default models', () => {
    const anthropic = new AnthropicProvider('key', 'custom-model') as any;
    const openai = new OpenAIProvider('key', 'custom-model') as any;
    const groq = new GroqProvider('key', 'custom-model') as any;
    const ollama = new OllamaProvider('http://localhost:11434', 'custom-model') as any;
    const openrouter = new OpenRouterProvider('key', 'custom-model') as any;

    expect(anthropic.defaultModel).toBe('custom-model');
    expect(openai.defaultModel).toBe('custom-model');
    expect(groq.defaultModel).toBe('custom-model');
    expect(ollama.defaultModel).toBe('custom-model');
    expect(openrouter.defaultModel).toBe('custom-model');
  });
});

describe('Vision Support', () => {
  describe('guardImageSize', () => {
    test('passes text blocks through unchanged', () => {
      const block: ContentBlock = { type: 'text', text: 'hello' };
      expect(guardImageSize(block)).toBe(block);
    });

    test('passes small images through unchanged', () => {
      const block: ContentBlock = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      };
      expect(guardImageSize(block)).toBe(block);
    });

    test('replaces oversized images with text warning', () => {
      const bigData = 'x'.repeat(6 * 1024 * 1024); // 6 MB
      const block: ContentBlock = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bigData },
      };
      const result = guardImageSize(block);
      expect(result.type).toBe('text');
      expect((result as { type: 'text'; text: string }).text).toContain('too large');
    });
  });

  describe('isToolResult', () => {
    test('returns true for valid ToolResult', () => {
      const tr: ToolResult = {
        content: [{ type: 'text', text: 'hello' }],
      };
      expect(isToolResult(tr)).toBe(true);
    });

    test('returns false for plain string', () => {
      expect(isToolResult('hello')).toBe(false);
    });

    test('returns false for null', () => {
      expect(isToolResult(null)).toBe(false);
    });

    test('returns false for object without content array', () => {
      expect(isToolResult({ content: 'not an array' })).toBe(false);
    });

    test('returns false for object with no content field', () => {
      expect(isToolResult({ data: 'something' })).toBe(false);
    });
  });

  describe('ContentBlock in LLMMessage', () => {
    test('LLMMessage accepts string content', () => {
      const msg: LLMMessage = { role: 'user', content: 'Hello' };
      expect(typeof msg.content).toBe('string');
    });

    test('LLMMessage accepts ContentBlock[] content', () => {
      const msg: LLMMessage = {
        role: 'tool',
        content: [
          { type: 'text', text: 'Screenshot captured' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
        tool_call_id: 'test-id',
      };
      expect(Array.isArray(msg.content)).toBe(true);
      expect((msg.content as ContentBlock[]).length).toBe(2);
    });
  });
});

describe('Tool Call Conversion', () => {
  const toolUseConversation: LLMMessage[] = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'What time is it?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'get_time', arguments: { timezone: 'UTC' } },
      ],
    },
    {
      role: 'tool',
      content: '2026-03-30T12:00:00Z',
      tool_call_id: 'call_1',
    },
  ];

  test('OpenAIProvider preserves tool_calls on assistant messages', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const assistant = converted[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('get_time');
    expect(assistant.tool_calls[0].function.arguments).toBe('{"timezone":"UTC"}');
  });

  test('OpenAIProvider preserves tool_call_id on tool messages', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const tool = converted[3];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('2026-03-30T12:00:00Z');
  });

  test('GroqProvider preserves tool_calls on assistant messages', () => {
    const provider = new GroqProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const assistant = converted[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('get_time');
    expect(assistant.tool_calls[0].function.arguments).toBe('{"timezone":"UTC"}');
    expect(assistant.content).toBeNull();
  });

  test('GroqProvider preserves tool_call_id on tool messages', () => {
    const provider = new GroqProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const tool = converted[3];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('2026-03-30T12:00:00Z');
  });

  test('Messages without tool_calls omit the field', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
    expect(converted[0].tool_calls).toBeUndefined();
    expect(converted[1].tool_calls).toBeUndefined();
    expect(converted[0].tool_call_id).toBeUndefined();
  });
});

describe('Groq request shaping', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'cmpl_test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'llama-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-test-body': typeof init?.body === 'string' ? init.body : '',
        },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('GroqProvider uses Groq-compatible tool fields', async () => {
    const provider = new GroqProvider('test-key') as any;
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Use the weather tool.' },
    ];

    await provider.chat(messages, {
      max_tokens: 321,
      tools: [
        {
          name: 'weather_lookup',
          description: 'Look up weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      ],
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.max_completion_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.tools).toHaveLength(1);
  });

  test('GroqProvider trims oversized history but keeps system and latest turn', async () => {
    const provider = new GroqProvider('test-key') as any;
    const long = 'x'.repeat(12_000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'latest question' },
    ];

    await provider.chat(messages, {
      tools: [
        {
          name: 'delegate_task',
          description: 'Delegate focused work',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.messages[0].role).toBe('system');
    expect(body.messages.at(-1).content).toBe('latest question');
    expect(body.messages.length).toBeLessThan(messages.length);
  });
});
