import { describe, expect, it, afterEach } from 'bun:test';
import { OpenAIProvider } from './openai.ts';

const originalFetch = globalThis.fetch;

function mockFetchResponse(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

function completionPayload(usage: Record<string, unknown>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

describe('OpenAIProvider HTTP failures', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const errorResponse = (status: number, headers: Record<string, string> = {}) =>
    new Response('{"error":{"message":"nope"}}', {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  it('chat throws a typed error carrying a numeric Retry-After', async () => {
    globalThis.fetch = (async () => errorResponse(429, { 'Retry-After': '7' })) as unknown as typeof fetch;
    await expect(new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LLMProviderError',
      code: 'rate_limit',
      retryAfterMs: 7_000,
    });
  });

  it('chat reads an HTTP-date Retry-After, and no header means no hint', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    globalThis.fetch = (async () => errorResponse(503, { 'Retry-After': at })) as unknown as typeof fetch;
    const dated = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(dated.code).toBe('network');
    expect(dated.retryAfterMs).toBeGreaterThan(25_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(30_000);

    globalThis.fetch = (async () => errorResponse(429)) as unknown as typeof fetch;
    const bare = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(bare.retryAfterMs).toBeUndefined();
  });

  it('stream error events carry retry_after_ms only when the server sent one', async () => {
    const firstError = async () => {
      for await (const event of new OpenAIProvider('k').stream([{ role: 'user', content: 'hi' }])) {
        if (event.type === 'error') return event;
      }
      return null;
    };
    globalThis.fetch = (async () => errorResponse(429, { 'Retry-After': '60' })) as unknown as typeof fetch;
    expect(await firstError()).toMatchObject({ code: 'rate_limit', retry_after_ms: 60_000 });
    globalThis.fetch = (async () => errorResponse(429)) as unknown as typeof fetch;
    expect(await firstError()).not.toHaveProperty('retry_after_ms');
  });

  it('forwards the caller signal to fetch', async () => {
    let received: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      received = init?.signal;
      return new Response(JSON.stringify(completionPayload({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }], { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});

describe('OpenAIProvider usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps prompt_tokens_details.cached_tokens to cache_read_input_tokens', async () => {
    mockFetchResponse(completionPayload({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      prompt_tokens_details: { cached_tokens: 1024 },
    }));

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    // Normalized: input_tokens excludes cached tokens (OpenAI's prompt_tokens
    // includes them), so input + cache_read = the full 1200-token prompt.
    expect(response.usage.input_tokens).toBe(1200 - 1024);
    expect(response.usage.output_tokens).toBe(40);
    expect(response.usage.cache_read_input_tokens).toBe(1024);
    expect(response.usage.cache_creation_input_tokens).toBeUndefined();
  });

  it('omits cache fields when prompt_tokens_details is absent', async () => {
    mockFetchResponse(completionPayload({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    }));

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(100);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
    expect(response.usage.cache_creation_input_tokens).toBeUndefined();
  });
});


describe('GPT-6 official Responses transport', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });
  const result = {
    model: 'gpt-6.1-sol', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Ready' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"test"}' },
    ],
    usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
  };
  it('sends tools, images and call history through Responses without storing them', async () => {
    let url = ''; let body: any;
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => { url = String(u); body = JSON.parse(String(init?.body)); return Response.json(result); }) as unknown as typeof fetch;
    const reply = await new OpenAIProvider('k').chat([
      { role: 'system', content: 'Help' },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old', name: 'lookup', arguments: { query: 'old' } }] },
      { role: 'tool', content: 'found', tool_call_id: 'old' },
    ], { model: 'gpt-6.1-sol', temperature: 0.3, max_tokens: 200, tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }], tool_choice: 'required' });
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body.store).toBe(false); expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBe(200);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'lookup', strict: false });
    expect(body.tool_choice).toBe('required');
    expect(body.input[1].content[0].image_url).toBe('data:image/png;base64,abc');
    expect(body.input[2]).toMatchObject({ type: 'function_call', call_id: 'old' });
    expect(body.input[3]).toMatchObject({ type: 'function_call_output', call_id: 'old', output: 'found' });
    expect(reply.tool_calls[0]).toEqual({ id: 'call_1', name: 'lookup', arguments: { query: 'test' } });
    expect(reply.usage).toEqual({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 8 });
    expect(reply.finish_reason).toBe('tool_use');
  });
  it('preserves Chat Completions for compatible gateways even with GPT-6 model names', async () => {
    let url = '';
    globalThis.fetch = (async (u: unknown) => { url = String(u); return Response.json(completionPayload({})); }) as unknown as typeof fetch;
    await new OpenAIProvider('k', 'gpt-6.1-sol', 'http://localhost:8080/v1').chat([{ role: 'user', content: 'hi' }]);
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
  });
  it('streams split SSE frames and emits one complete tool call and usage receipt', async () => {
    const wire = 'data: '+JSON.stringify({ type: 'response.output_text.delta', delta: 'Ready' })+'\r\n\r\n' +
      'data: '+JSON.stringify({ type: 'response.completed', response: result });
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) {
      const bytes = new TextEncoder().encode(wire); c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17)); c.close();
    } }))) as unknown as typeof fetch;
    const events = [];
    for await (const event of new OpenAIProvider('k').stream([{ role: 'user', content: 'hi' }], { model: 'gpt-6-astra' })) events.push(event);
    expect(events.map(e => e.type)).toEqual(['text', 'tool_call', 'done']);
    expect(events.at(-1)).toMatchObject({ response: { finish_reason: 'tool_use', usage: { input_tokens: 12 } } });
  });
  it('does not execute partial arguments on a token-limited response', async () => {
    globalThis.fetch = (async () => Response.json({ ...result, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', arguments: '{' }] })) as unknown as typeof fetch;
    const reply = await new OpenAIProvider('k').chat([], { model: 'gpt-6-luna' });
    expect(reply.finish_reason).toBe('length'); expect(reply.tool_calls).toEqual([]);
  });
  it('reports interrupted streams as failures, never completion', async () => {
    globalThis.fetch = (async () => new Response('data: {"type":"response.created"}\n\n')) as unknown as typeof fetch;
    const events = [];
    for await (const event of new OpenAIProvider('k').stream([], { model: 'gpt-6-luna' })) events.push(event);
    expect(events).toEqual([{ type: 'error', code: 'network', error: 'OpenAI stream ended before completion' }]);
  });
  it('reports a malformed stream frame as a typed server error without echoing the frame', async () => {
    for (const frame of ['{"type":"response.output_text.delta","delta":"secret partial', 'null', '7']) {
      globalThis.fetch = (async () => new Response('data: '+JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi' })+'\n\ndata: '+frame+'\n\n')) as unknown as typeof fetch;
      const events = [];
      for await (const event of new OpenAIProvider('k').stream([], { model: 'gpt-6-luna' })) events.push(event);
      expect(events).toEqual([{ type: 'text', text: 'Hi' }, { type: 'error', code: 'server', error: 'OpenAI Responses stream sent malformed JSON' }]);
    }
  });
  it('reports a frame cut off by the end of the stream as a dropped connection', async () => {
    globalThis.fetch = (async () => new Response('data: {"type":"response.output_text.delta","delta":"cut')) as unknown as typeof fetch;
    const events = [];
    for await (const event of new OpenAIProvider('k').stream([], { model: 'gpt-6-luna' })) events.push(event);
    expect(events).toEqual([{ type: 'error', code: 'network', error: 'OpenAI stream ended before completion' }]);
  });
  it('preserves typed rate-limit errors and checks cancellation before dispatch', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '4' } }); }) as unknown as typeof fetch;
    await expect(new OpenAIProvider('k').chat([], { model: 'gpt-6-luna' })).rejects.toMatchObject({ code: 'rate_limit', retryAfterMs: 4000 });
    const controller = new AbortController(); controller.abort();
    await expect(new OpenAIProvider('k').chat([], { model: 'gpt-6-luna', signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
