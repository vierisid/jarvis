import { describe, expect, it, afterEach } from 'bun:test';
import { OpenRouterProvider } from './openrouter.ts';
import type { LLMStreamEvent } from './provider.ts';

const originalFetch = globalThis.fetch;

type CapturedBody = {
  model: string;
  messages: unknown[];
  cache_control?: { type: string };
};

function completionPayload(usage: Record<string, unknown>, model = 'anthropic/claude-sonnet-4') {
  return {
    id: 'gen-test',
    object: 'chat.completion',
    created: 0,
    model,
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

function captureChat(payload: unknown): { body: () => CapturedBody } {
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

const basicUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

describe('OpenRouterProvider cache_control', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends top-level cache_control for anthropic/* models', async () => {
    const capture = captureChat(completionPayload(basicUsage));
    const provider = new OpenRouterProvider('key', 'anthropic/claude-sonnet-4');

    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(capture.body().cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits cache_control for qwen/* models (top-level form is Anthropic-only)', async () => {
    // Qwen needs explicit caching but only supports per-content-block
    // cache_control, which we don't emit yet. Sending the top-level field
    // would be undocumented behavior for this upstream.
    const capture = captureChat(completionPayload(basicUsage, 'qwen/qwen-2.5-72b'));
    const provider = new OpenRouterProvider('key');

    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'qwen/qwen-2.5-72b' });
    expect(capture.body().cache_control).toBeUndefined();
  });

  it('omits cache_control for auto-caching upstreams', async () => {
    const capture = captureChat(completionPayload(basicUsage, 'openai/gpt-4o'));
    const provider = new OpenRouterProvider('key');

    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'openai/gpt-4o' });
    expect(capture.body().cache_control).toBeUndefined();
  });

  it('omits cache_control when promptCache is disabled', async () => {
    const capture = captureChat(completionPayload(basicUsage));
    const provider = new OpenRouterProvider('key', 'anthropic/claude-sonnet-4', { promptCache: false });

    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(capture.body().cache_control).toBeUndefined();
  });
});

describe('OpenRouterProvider usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes input_tokens and maps cache token details', async () => {
    captureChat(completionPayload({
      prompt_tokens: 5000,
      completion_tokens: 50,
      total_tokens: 5050,
      prompt_tokens_details: { cached_tokens: 4200, cache_write_tokens: 300 },
    }));
    const provider = new OpenRouterProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    // input excludes cached reads (OpenAI-shaped prompt_tokens includes them)
    expect(response.usage.input_tokens).toBe(5000 - 4200);
    expect(response.usage.cache_read_input_tokens).toBe(4200);
    expect(response.usage.cache_creation_input_tokens).toBe(300);
  });

  it('never reports negative input_tokens', async () => {
    captureChat(completionPayload({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      // Defensive: a routed upstream reporting cached tokens NOT included
      // in prompt_tokens must not push input below zero.
      prompt_tokens_details: { cached_tokens: 150 },
    }));
    const provider = new OpenRouterProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(0);
    expect(response.usage.cache_read_input_tokens).toBe(150);
  });

  it('omits cache fields when prompt_tokens_details is absent', async () => {
    captureChat(completionPayload(basicUsage));
    const provider = new OpenRouterProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(100);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
    expect(response.usage.cache_creation_input_tokens).toBeUndefined();
  });

  it('captures usage from the final stream chunk', async () => {
    const sse = [
      `data: ${JSON.stringify({
        id: 'gen', object: 'chat.completion.chunk', created: 0, model: 'anthropic/claude-sonnet-4',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'gen', object: 'chat.completion.chunk', created: 0, model: 'anthropic/claude-sonnet-4',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 2000, completion_tokens: 7, total_tokens: 2007,
          prompt_tokens_details: { cached_tokens: 1800 },
        },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n');

    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ) as unknown as typeof fetch;

    const provider = new OpenRouterProvider('key');
    const events: LLMStreamEvent[] = [];
    for await (const event of provider.stream([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.response.content).toBe('hello');
      expect(done.response.usage.input_tokens).toBe(200);
      expect(done.response.usage.output_tokens).toBe(7);
      expect(done.response.usage.cache_read_input_tokens).toBe(1800);
    }
  });
});
