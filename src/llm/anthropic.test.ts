import { describe, expect, it, afterEach } from 'bun:test';
import { AnthropicProvider, anthropicMessagesUrl } from './anthropic.ts';
import type { LLMMessage, LLMStreamEvent } from './provider.ts';

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
