import { afterEach, describe, expect, it } from 'bun:test';
import { OmniRouteProvider } from './omniroute.ts';
import { instantiateProvider } from './config-binding.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OmniRouteProvider', () => {
  it('uses the OmniRoute local endpoint by default', () => {
    const provider = new OmniRouteProvider();
    expect(provider.name).toBe('omniroute');
    expect((provider as any).apiUrl).toBe('http://localhost:20128/v1/chat/completions');
  });

  it('is created by the canonical config binding with its custom provider name', () => {
    const provider = instantiateProvider('omni-free', {
      kind: 'omniroute',
      base_url: 'http://localhost:20128/v1',
      api_key: 'sk-omni',
    });
    expect(provider).toBeInstanceOf(OmniRouteProvider);
    expect(provider?.name).toBe('omni-free');
  });

  it('uses the local default when config omits the base URL', () => {
    const provider = instantiateProvider('omni-local', {
      kind: 'omniroute',
      api_key: 'sk-omni',
    });
    expect(provider).toBeInstanceOf(OmniRouteProvider);
    expect((provider as any).apiUrl).toBe('http://localhost:20128/v1/chat/completions');
  });

  it('sends OpenAI function tools and parses returned tool calls', async () => {
    let requestUrl = '';
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, any> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'chatcmpl-omni',
        object: 'chat.completion',
        created: 0,
        model: 'free-coding-combo',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"Jarvis"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OmniRouteProvider('https://omni.example/v1/', 'auto', 'sk-omni');
    const result = await provider.chat(
      [{ role: 'user', content: 'Find Jarvis' }],
      {
        model: 'free-coding-combo',
        tools: [{
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        }],
      },
    );

    expect(requestUrl).toBe('https://omni.example/v1/chat/completions');
    expect(requestHeaders?.get('Authorization')).toBe('Bearer sk-omni');
    expect(requestBody.model).toBe('free-coding-combo');
    expect(requestBody.tool_choice).toBe('auto');
    expect(requestBody.tools[0].function.name).toBe('search');
    expect(result.tool_calls).toEqual([{ id: 'call_1', name: 'search', arguments: { query: 'Jarvis' } }]);
    expect(result.finish_reason).toBe('tool_use');
  });

  it('returns every model and combo route without OpenAI-family filtering', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'auto' },
        { id: 'cc/claude-opus-4-6' },
        { id: 'free-coding-combo' },
        { id: 'google/gemini-3-flash' },
        { id: 'auto' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const models = await new OmniRouteProvider(undefined, undefined, 'sk-omni').listModels();
    expect(models).toEqual([
      'auto',
      'cc/claude-opus-4-6',
      'free-coding-combo',
      'google/gemini-3-flash',
    ]);
  });

  it('assembles streamed tool-call deltas from routed models', async () => {
    const events = [
      { id: '1', object: 'chat.completion.chunk', created: 0, model: 'auto', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'weather', arguments: '{"city"' } }] }, finish_reason: null }] },
      { id: '1', object: 'chat.completion.chunk', created: 0, model: 'auto', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    globalThis.fetch = (async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const received = [];
    for await (const event of new OmniRouteProvider().stream(
      [{ role: 'user', content: 'Weather?' }],
      { tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }] },
    )) {
      received.push(event);
    }

    expect(received).toContainEqual({
      type: 'tool_call',
      tool_call: { id: 'call_stream', name: 'weather', arguments: { city: 'Paris' } },
    });
    const done = received.find((event) => event.type === 'done');
    expect(done?.type === 'done' ? done.response.finish_reason : null).toBe('tool_use');
  });
});
