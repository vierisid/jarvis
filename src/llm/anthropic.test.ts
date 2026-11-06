import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { LLMManager } from './manager.ts';
import { setUsageDatabase } from './usage.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { Database } from 'bun:sqlite';
import { BackgroundBudget, BackgroundThrottled, BACKGROUND_LIMITS, setBackgroundBudget, type BackgroundLimits } from './background-budget.ts';
import { runWithOrigin } from './origin.ts';
import { AnthropicProvider, anthropicMessagesUrl } from './anthropic.ts';
import { CHAT_MODEL_SUGGESTIONS } from './model-catalog.ts';
import { LLMProviderError, type LLMMessage, type LLMStreamEvent } from './provider.ts';

const originalFetch = globalThis.fetch;

type CapturedBody = {
  model: string;
  system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  tools?: unknown[];
};

function anthropicResponse(usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'end_turn',
    usage,
  };
}

/** Mock fetch, capture the request body, and reply with a fixed completion. */
function captureChat(payload = anthropicResponse()): { body: () => CapturedBody } {
  let captured: CapturedBody | null = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as CapturedBody;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { body: () => {
    if (!captured) throw new Error('fetch was not called');
    return captured;
  } };
}

function countCacheControls(body: CapturedBody): number {
  let n = 0;
  for (const block of body.system ?? []) {
    if (block.cache_control) n++;
  }
  for (const msg of body.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as { cache_control?: unknown }).cache_control) n++;
      }
    }
  }
  return n;
}

describe('AnthropicProvider custom endpoint', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes base URLs to the Messages API endpoint', () => {
    expect(anthropicMessagesUrl('https://gateway.example.com')).toBe('https://gateway.example.com/v1/messages');
    expect(anthropicMessagesUrl('https://gateway.example.com/v1/')).toBe('https://gateway.example.com/v1/messages');
    expect(anthropicMessagesUrl('https://gateway.example.com/v1/messages')).toBe('https://gateway.example.com/v1/messages');
  });

  it('uses bearer authentication for a custom base URL', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(anthropicResponse()), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('custom-token', undefined, {
      baseUrl: 'https://gateway.example.com',
    });
    await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(requestUrl).toBe('https://gateway.example.com/v1/messages');
    expect(requestHeaders.get('authorization')).toBe('Bearer custom-token');
    expect(requestHeaders.get('x-api-key')).toBeNull();
    expect(requestHeaders.get('anthropic-version')).toBe('2023-06-01');
  });

  it('can use x-api-key authentication with a custom base URL', async () => {
    let requestHeaders = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(anthropicResponse()), { status: 200 });
    }) as unknown as typeof fetch;

    await new AnthropicProvider('gateway-key', undefined, {
      baseUrl: 'https://gateway.example.com',
      authHeader: 'x-api-key',
    }).chat([{ role: 'user', content: 'hi' }]);

    expect(requestHeaders.get('x-api-key')).toBe('gateway-key');
    expect(requestHeaders.get('authorization')).toBeNull();
  });

  it('keeps x-api-key authentication on Anthropic by default', async () => {
    let requestHeaders = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(anthropicResponse()), { status: 200 });
    }) as unknown as typeof fetch;

    await new AnthropicProvider('sk-ant-test').chat([{ role: 'user', content: 'hi' }]);

    expect(requestHeaders.get('x-api-key')).toBe('sk-ant-test');
    expect(requestHeaders.get('authorization')).toBeNull();
  });

  it('keeps x-api-key authentication when the official URL is entered explicitly', async () => {
    let requestHeaders = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(anthropicResponse()), { status: 200 });
    }) as unknown as typeof fetch;

    await new AnthropicProvider('sk-ant-test', undefined, {
      baseUrl: 'https://api.anthropic.com',
    }).chat([{ role: 'user', content: 'hi' }]);

    expect(requestHeaders.get('x-api-key')).toBe('sk-ant-test');
    expect(requestHeaders.get('authorization')).toBeNull();
  });

  it('returns a copy of the shared model suggestions without a gateway', async () => {
    const provider = new AnthropicProvider('sk-ant-test');
    const models = await provider.listModels();
    expect(models).toEqual([...CHAT_MODEL_SUGGESTIONS.anthropic]);
    models.push('mutated-by-caller');
    expect(CHAT_MODEL_SUGGESTIONS.anthropic).not.toContain('mutated-by-caller');
    expect(await provider.listModels()).toEqual(await new AnthropicProvider('sk-ant-other').listModels());
  });

  it('discovers models from a custom endpoint', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        data: [{ id: 'claude-custom-large' }, { id: 'claude-custom-fast' }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const models = await new AnthropicProvider('custom-token', undefined, {
      baseUrl: 'https://gateway.example.com',
    }).listModels();

    expect(requestUrl).toBe('https://gateway.example.com/v1/models');
    expect(requestHeaders.get('authorization')).toBe('Bearer custom-token');
    expect(requestHeaders.get('anthropic-version')).toBe('2023-06-01');
    expect(models).toEqual(['claude-custom-large', 'claude-custom-fast']);
  });

  it('accepts SSE from a gateway for a non-streaming chat request', async () => {
    const events = [
      { type: 'message_start', message: { model: 'gateway-model', usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'O' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'K' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 2 } } },
      { type: 'message_stop' },
    ];
    const sse = `: keepalive\n\n${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}`;
    globalThis.fetch = (async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    })) as unknown as typeof fetch;

    const response = await new AnthropicProvider('token', 'fallback', {
      baseUrl: 'https://gateway.example.com',
    }).chat([{ role: 'user', content: 'hi' }]);

    expect(response.content).toBe('OK');
    expect(response.model).toBe('gateway-model');
    expect(response.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
    expect(response.finish_reason).toBe('stop');
  });
});

describe('AnthropicProvider cache_control placement', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('emits system as a block array with cache_control on the marked block only', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    await provider.chat([
      { role: 'system', content: 'STATIC PART', cache: true },
      { role: 'system', content: 'DYNAMIC PART' },
      { role: 'user', content: 'hi' },
    ]);

    const body = capture.body();
    expect(body.system).toHaveLength(2);
    expect(body.system![0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system![1]!.cache_control).toBeUndefined();
    // '\n\n' separator prepended to FOLLOWING blocks so the rendered text
    // matches the old string join while the marked static block's bytes
    // stay independent of whether a dynamic block follows.
    expect(body.system![0]!.text).toBe('STATIC PART');
    expect(body.system![1]!.text).toBe('\n\nDYNAMIC PART');
  });

  it('static system block bytes are identical with and without a dynamic block', async () => {
    const provider = new AnthropicProvider('key');

    const captureWith = captureChat();
    await provider.chat([
      { role: 'system', content: 'STATIC PART', cache: true },
      { role: 'system', content: 'DYNAMIC PART' },
      { role: 'user', content: 'hi' },
    ]);
    const withDynamic = captureWith.body().system![0]!.text;

    const captureWithout = captureChat();
    await provider.chat([
      { role: 'system', content: 'STATIC PART', cache: true },
      { role: 'user', content: 'hi' },
    ]);
    const withoutDynamic = captureWithout.body().system![0]!.text;

    // A byte difference here would rewrite the cache entry whenever the
    // dynamic system message flips between empty and non-empty.
    expect(withDynamic).toBe(withoutDynamic);
  });

  it('marks the last message content block on conversational requests', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    await provider.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow-up' },
    ]);

    const body = capture.body();
    const last = body.messages[body.messages.length - 1]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]).toEqual({
      type: 'text',
      text: 'follow-up',
      cache_control: { type: 'ephemeral' },
    });
    // Unmarked system prompt -> no system breakpoint; only the message one.
    expect(countCacheControls(body)).toBe(1);
  });

  it('skips the last-message breakpoint on one-shot requests (no assistant turn)', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    await provider.chat([
      { role: 'system', content: 'classify this' },
      { role: 'user', content: 'some input' },
    ]);

    const body = capture.body();
    // One-shot prompts are never resent: a breakpoint would pay the 1.25x
    // write premium with zero reads.
    expect(countCacheControls(body)).toBe(0);
    expect(body.messages[body.messages.length - 1]!.content).toBe('some input');
  });

  it('marks the last tool_result block without mutating the caller history', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    const toolContent = [{ type: 'text' as const, text: 'result data' }];
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys', cache: true },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'run', arguments: {} }] },
      { role: 'tool', content: toolContent, tool_call_id: 't1' },
    ];
    await provider.chat(messages);

    const body = capture.body();
    const last = body.messages[body.messages.length - 1]!;
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]!.type).toBe('tool_result');
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(countCacheControls(body)).toBe(2);

    // The caller's own message objects must stay untouched: a leaked
    // cache_control would accumulate extra breakpoints on later requests.
    expect(JSON.stringify(messages)).not.toContain('cache_control');
  });

  it('emits zero cache_control when promptCache is disabled', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key', undefined, { promptCache: false });

    await provider.chat([
      { role: 'system', content: 'STATIC', cache: true },
      { role: 'system', content: 'DYNAMIC' },
      { role: 'user', content: 'hi' },
    ]);

    const body = capture.body();
    expect(countCacheControls(body)).toBe(0);
    // System is still a block array, just unmarked.
    expect(body.system).toHaveLength(2);
    expect(body.messages[0]!.content).toBe('hi');
  });

  it('caps breakpoints at 2 even when every message is marked', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    await provider.chat([
      { role: 'system', content: 'a', cache: true },
      { role: 'system', content: 'b', cache: true },
      { role: 'system', content: 'c', cache: true },
      { role: 'user', content: 'q1', cache: true },
      { role: 'assistant', content: 'a1', cache: true },
      { role: 'user', content: 'q2', cache: true },
    ]);

    const body = capture.body();
    // One breakpoint on the LAST marked system block, one on the last message.
    expect(countCacheControls(body)).toBe(2);
    expect(body.system![2]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system![0]!.cache_control).toBeUndefined();
  });

  it('skips empty system messages and empty last-message content', async () => {
    const capture = captureChat();
    const provider = new AnthropicProvider('key');

    await provider.chat([
      { role: 'system', content: '', cache: true },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]);

    const body = capture.body();
    expect(body.system).toBeUndefined();
    // Empty assistant string is left as-is (no empty text block created).
    const last = body.messages[body.messages.length - 1]!;
    expect(last.content).toBe('');
  });
});

describe('AnthropicProvider cache usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps cache token fields from a non-stream response', async () => {
    captureChat(anthropicResponse({
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 120,
    }));
    const provider = new AnthropicProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(50);
    expect(response.usage.cache_read_input_tokens).toBe(4000);
    expect(response.usage.cache_creation_input_tokens).toBe(120);
  });

  it('maps cache token fields from stream message_start', async () => {
    const sse = [
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-5-20250929',
          usage: { input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 2048, cache_creation_input_tokens: 64 },
        },
      })}`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 7 } } })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');

    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ) as unknown as typeof fetch;

    const provider = new AnthropicProvider('key');
    const events: LLMStreamEvent[] = [];
    for await (const event of provider.stream([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.response.usage.input_tokens).toBe(30);
      expect(done.response.usage.output_tokens).toBe(7);
      expect(done.response.usage.cache_read_input_tokens).toBe(2048);
      expect(done.response.usage.cache_creation_input_tokens).toBe(64);
    }
  });
});

describe('AnthropicProvider SSE chat responses', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function sseResponse(events: unknown[]) {
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('degrades a truncated tool call instead of discarding the whole response', async () => {
    // Regression: an unguarded JSON.parse threw a bare parser error out of
    // chat(), while the streaming path absorbs the identical payload.
    globalThis.fetch = (async () => sseResponse([
      { type: 'message_start', message: { model: 'gw-model', usage: { input_tokens: 3, output_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial answer' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'weather', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4 } },
      // A whole message ends in message_stop; without it the body was cut off (#1097).
      { type: 'message_stop' },
    ])) as unknown as typeof fetch;

    const result = await new AnthropicProvider('k', undefined, { baseUrl: 'https://gw.example' })
      .chat([{ role: 'user', content: 'hi' }]);

    expect(result.tool_calls).toEqual([]);
    expect(result.content).toContain('partial answer');
    expect(result.content).toContain('truncated');
    expect(result.model).toBe('gw-model');
  });

  it('still assembles a complete tool call from the SSE stream', async () => {
    globalThis.fetch = (async () => sseResponse([
      { type: 'message_start', message: { model: 'gw-model', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'weather', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Rome"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      // A whole message ends in message_stop; without it the body was cut off (#1097).
      { type: 'message_stop' },
    ])) as unknown as typeof fetch;

    const result = await new AnthropicProvider('k', undefined, { baseUrl: 'https://gw.example' })
      .chat([{ role: 'user', content: 'hi' }]);

    expect(result.tool_calls).toEqual([{ id: 't1', name: 'weather', arguments: { city: 'Rome' } }]);
  });
});


describe('Current Claude request parameters', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });
  for (const model of ['claude-opus-5-5', 'claude-haiku-5-5']) {
    it(`omits unsupported temperature for ${model}`, async () => {
      let body: Record<string, unknown> = {};
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return Response.json(anthropicResponse());
      }) as unknown as typeof fetch;
      await new AnthropicProvider('key').chat([{ role: 'user', content: 'hi' }], { model, temperature: 0.3 });
      expect(body.model).toBe(model);
      expect(body.temperature).toBeUndefined();
    });
  }
});

describe('AnthropicProvider stream completion (#1097)', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  const toolTurn = [
    { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'echo', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"message":"hello"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', usage: { output_tokens: 9 } } },
    { type: 'message_stop' },
  ];
  const textTurn = [
    { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer is' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 3 } } },
    { type: 'message_stop' },
  ];

  /** The SSE body in 11-byte chunks, so events straddle reads as on the wire. */
  function chunked(events: unknown[], tail = '\n\n') {
    const bytes = new TextEncoder().encode(
      events.map((e, i) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}${i === events.length - 1 ? tail : '\n\n'}`).join(''),
    );
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11));
        controller.close();
      },
    });
  }

  async function run(events: unknown[], tail?: string): Promise<LLMStreamEvent[]> {
    globalThis.fetch = (async () => new Response(chunked(events, tail), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    return out;
  }

  it('a complete tool turn ends in done with the call', async () => {
    const events = await run(toolTurn);
    const done = events.find((e) => e.type === 'done');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(done?.type === 'done' && done.response.finish_reason).toBe('tool_use');
    expect(done?.type === 'done' && done.response.tool_calls).toEqual([{ id: 't1', name: 'echo', arguments: { message: 'hello' } }]);
  });

  it('a final message_stop without a trailing newline still completes', async () => {
    const events = await run(textTurn, '');
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });

  for (const [label, events, outputTokens] of [
    ['EOF after message_delta, before message_stop', toolTurn.slice(0, -1), 9],
    ['EOF before message_delta and message_stop', toolTurn.slice(0, -2), 0],
    ['EOF mid-text, before any terminal event', textTurn.slice(0, 3), 0],
    ['EOF after message_delta of a text turn', textTurn.slice(0, -1), 3],
  ] as const) {
    it(`${label} is a retryable network error, never done`, async () => {
      const out = await run(events as unknown[]);
      expect(out.some((e) => e.type === 'done')).toBe(false);
      const last = out[out.length - 1];
      expect(last).toEqual({
        type: 'error', error: 'Anthropic stream ended before completion', code: 'network',
        // message_start (and any message_delta) before the cut is carried (#1258).
        usage: { input_tokens: 5, output_tokens: outputTokens },
      });
    });
  }

  /** A raw body in 7-byte chunks. */
  async function runRaw(body: string) {
    const bytes = new TextEncoder().encode(body);
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    return out;
  }
  const sse = (events: unknown[], eol = '\n') => events.map((e) => `data: ${JSON.stringify(e)}${eol}${eol}`).join('');

  it('CRLF line endings complete normally', async () => {
    const out = await runRaw(sse(textTurn, '\r\n'));
    expect(out.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('data: without the space after the colon is still read', async () => {
    const out = await runRaw(textTurn.map((e) => `data:${JSON.stringify(e)}\n\n`).join(''));
    expect(out.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('a body cut inside the message_stop line is a network error', async () => {
    const body = sse(toolTurn);
    const out = await runRaw(body.slice(0, body.lastIndexOf('message_stop') + 4));
    expect(out.some((e) => e.type === 'done')).toBe(false);
    expect(out[out.length - 1]).toEqual({
      type: 'error', error: 'Anthropic stream ended before completion', code: 'network',
      usage: { input_tokens: 5, output_tokens: 9 },
    });
  });

  it('text and a complete tool call before the cut still end in an error, not done', async () => {
    const mixed = [...textTurn.slice(0, 4), ...toolTurn.slice(1, 4).map((e) => ({ ...e, index: 1 })), toolTurn[4]];
    const out = await runRaw(sse(mixed));
    expect(out.map((e) => e.type)).toEqual(['text', 'tool_call', 'error']);
  });

  it('the response body is released when the provider stops reading early', async () => {
    // An error event ends the turn while the connection is still open.
    let cancelled = false;
    const head = new TextEncoder().encode(sse([textTurn[0], { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]));
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(head); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    expect(out.map((e) => e.type)).toEqual(['error']);
    expect(cancelled).toBe(true);
  });

  it('a body cut mid-line on the SSE chat path throws a network error, not invalid JSON', async () => {
    const body = sse(toolTurn);
    globalThis.fetch = (async () => new Response(body.slice(0, body.lastIndexOf('message_stop') + 4), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;
    const err = await new AnthropicProvider('k', undefined, { baseUrl: 'https://gw.example' })
      .chat([{ role: 'user', content: 'hi' }]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect((err as LLMProviderError).code).toBe('network');
  });

  it('an EOF before message_stop on the SSE chat path throws a network error', async () => {
    globalThis.fetch = (async () => new Response(chunked(toolTurn.slice(0, -1)), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;
    const err = await new AnthropicProvider('k', undefined, { baseUrl: 'https://gw.example' })
      .chat([{ role: 'user', content: 'hi' }]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect((err as LLMProviderError).code).toBe('network');
    expect((err as LLMProviderError).message).toBe('Anthropic stream ended before completion');
  });
});

describe('usage of a cut-off Anthropic call is recorded (#1258)', () => {
  const start = { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 7 } } };
  const text = [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 12 } } },
  ];
  const whole = [...text, { type: 'message_stop' }];
  // Usage reported, then cut before any text or tool call reached the consumer.
  const headOnly = [start];
  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

  type Row = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; error_code: string | null };
  let db: ReturnType<typeof initDatabase>;
  beforeEach(() => {
    closeDb();
    db = initDatabase(':memory:');
    setUsageDatabase(() => db);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    setUsageDatabase(() => null);
    closeDb();
  });

  /** Each fetch answers the next body; the last one repeats. */
  function serve(...bodies: unknown[][]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      const events = bodies[Math.min(calls++, bodies.length - 1)]!;
      return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    return () => calls;
  }
  function manager(): LLMManager {
    const m = new LLMManager();
    m.registerProvider(new AnthropicProvider('key'));
    m.setTierMap({ medium: { provider: 'anthropic', model: 'claude-test' } });
    return m;
  }
  const rows = () => db.query(
    'SELECT input_tokens, output_tokens, cache_read_input_tokens, error_code FROM llm_usage',
  ).all() as Row[];

  it('a stream cut after text records the reported usage with the error', async () => {
    const calls = serve(text);
    const out: LLMStreamEvent[] = [];
    for await (const e of manager().streamTier('medium', 'test', [{ role: 'user', content: 'hi' }])) out.push(e);
    expect(out.map((e) => e.type)).toEqual(['text', 'error']);
    expect(calls()).toBe(1); // text was emitted, so no retry
    expect(rows()).toEqual([{ input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 7, error_code: 'network' }]);
  });

  it('every retried cut-off attempt is counted', async () => {
    const calls = serve(headOnly);
    for await (const _ of manager().streamTier('medium', 'test', [{ role: 'user', content: 'hi' }])) { /* drain */ }
    expect(calls()).toBe(3);
    expect(rows()).toEqual([{ input_tokens: 120, output_tokens: 3, cache_read_input_tokens: 21, error_code: 'network' }]);
  });

  it('a cut attempt before a successful retry still counts', async () => {
    serve(headOnly, whole);
    const out: LLMStreamEvent[] = [];
    for await (const e of manager().streamTier('medium', 'test', [{ role: 'user', content: 'hi' }])) out.push(e);
    const done = out.find((e) => e.type === 'done');
    // The response itself reports only its own usage...
    expect(done?.type === 'done' && done.response.usage).toEqual({ input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 7 });
    // ...while the record holds both reported attempts.
    expect(rows()).toEqual([{ input_tokens: 80, output_tokens: 13, cache_read_input_tokens: 14, error_code: null }]);
  });

  it('chatTier records the usage of an SSE chat body cut off on every attempt', async () => {
    const calls = serve(text);
    const err = await manager().chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProviderError);
    expect(calls()).toBe(3);
    expect(rows()).toEqual([{ input_tokens: 120, output_tokens: 36, cache_read_input_tokens: 21, error_code: 'network' }]);
  });

  it('chatTier counts a cut attempt before a successful retry', async () => {
    serve(text, whole);
    const response = await manager().chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]);
    expect(response.usage).toEqual({ input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 7 });
    expect(rows()).toEqual([{ input_tokens: 80, output_tokens: 24, cache_read_input_tokens: 14, error_code: null }]);
  });

  it('an error event after message_start carries the usage reported so far', async () => {
    serve([...text.slice(0, 3), { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]);
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    expect(out.at(-1)).toEqual({
      type: 'error', error: 'overloaded_error: busy', code: 'server',
      usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 7 },
    });
  });

  it('a read that fails after message_start carries the usage reported so far', async () => {
    const head = new TextEncoder().encode(sse(text.slice(0, 3)));
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (head.length && !(controller as unknown as { sent?: boolean }).sent) {
          (controller as unknown as { sent?: boolean }).sent = true;
          controller.enqueue(head);
        } else controller.error(new Error('socket reset'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    const last = out.at(-1);
    expect(last?.type === 'error' && last.error).toContain('Stream error');
    expect(last?.type === 'error' && last.usage).toEqual({ input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 7 });
  });

  describe('governed background work', () => {
    afterEach(() => setBackgroundBudget(null));
    const budget = (limits: BackgroundLimits = BACKGROUND_LIMITS) => {
      const store = new Database(':memory:');
      return new BackgroundBudget(() => store, limits);
    };
    // A governed cut-off backs the provider off, so the budget refuses the
    // in-provider retry: the first attempt's usage must survive that.
    it('streamTier records a reported attempt whose retry the budget refused', async () => {
      setBackgroundBudget(budget());
      const calls = serve(headOnly);
      const out: LLMStreamEvent[] = [];
      await runWithOrigin('background', async () => {
        for await (const e of manager().streamTier('medium', 'test', [{ role: 'user', content: 'hi' }])) out.push(e);
      });
      expect(calls()).toBe(1);
      expect(out.at(-1)).toMatchObject({ type: 'error', code: 'background_throttled' });
      expect(rows()).toEqual([{ input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 7, error_code: 'background_throttled' }]);
    });

    it('chatTier records a reported attempt whose retry the budget refused', async () => {
      setBackgroundBudget(budget());
      const calls = serve(headOnly);
      const err = await runWithOrigin('background', () => manager().chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BackgroundThrottled);
      expect(calls()).toBe(1);
      expect(rows()).toEqual([{ input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 7, error_code: 'background_throttled' }]);
    });

    it('a call the budget refused before any attempt is still not recorded', async () => {
      setBackgroundBudget(budget({ ...BACKGROUND_LIMITS, requests: 0 }));
      const calls = serve(whole);
      await runWithOrigin('background', async () => {
        for await (const _ of manager().streamTier('medium', 'test', [{ role: 'user', content: 'hi' }])) { /* drain */ }
      });
      const err = await runWithOrigin('background', () => manager().chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BackgroundThrottled);
      expect(calls()).toBe(0);
      expect(rows()).toEqual([]);
    });
  });

  it('an error before message_start carries no usage', async () => {
    serve([{ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }]);
    const out: LLMStreamEvent[] = [];
    for await (const e of new AnthropicProvider('key').stream([{ role: 'user', content: 'hi' }])) out.push(e);
    expect(out).toEqual([{ type: 'error', error: 'invalid_request_error: bad', code: 'bad_request' }]);
  });
});
