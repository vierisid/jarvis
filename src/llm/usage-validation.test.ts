import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { queryUsage, recordUsage, setUsageDatabase } from './usage.ts';
import { cleanTokenCount, cleanUsage, MAX_TOKENS_PER_CALL, addUsage } from './provider.ts';
import { LLMManager } from './manager.ts';
import { OpenAIProvider } from './openai.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GroqProvider } from './groq.ts';
import { OpenRouterProvider } from './openrouter.ts';
import type { LLMProvider } from './provider.ts';

const originalFetch = globalThis.fetch;
beforeEach(() => { closeDb(); initDatabase(':memory:', { quiet: true }); setUsageDatabase(() => getDb()); });
afterEach(() => { globalThis.fetch = originalFetch; closeDb(); });
const rows = () => getDb().query<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; latency_ms: number; error_code: string | null }, []>(
  'SELECT input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, latency_ms, error_code FROM llm_usage ORDER BY id').all();
const base = { tier: 'medium', resolved_tier: 'medium', subsystem: 't', provider: 'p', model: 'm', latency_ms: 5 } as const;

describe('a token count is accepted only when it is a sane whole number', () => {
  test.each([
    [0, 0], [1, 1], [12345, 12345], [MAX_TOKENS_PER_CALL, MAX_TOKENS_PER_CALL],
    [-5, 0], [1e30, 0], [9e15, 0], [MAX_TOKENS_PER_CALL + 1, 0], [12.5, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0],
    [null, 0], [undefined, 0], ['12', 0], [{}, 0], [[5], 0], [true, 0],
  ])('%p becomes %p', (input, expected) => expect(cleanTokenCount(input)).toBe(expected));

  test('cleanUsage and addUsage never let a bad count in', () => {
    expect(cleanUsage({ input_tokens: 1e30, output_tokens: 7, cache_read_input_tokens: -1 })).toEqual({ input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0 });
    const into = { input_tokens: 5, output_tokens: 5 };
    addUsage(into, { input_tokens: NaN, output_tokens: 1e30, cache_read_input_tokens: 9e15 });
    expect(into).toEqual({ input_tokens: 5, output_tokens: 5 });
  });
});

describe('the usage table never holds a number a provider made up', () => {
  test('absurd, negative and missing numbers are stored as 0 and the call is still recorded', () => {
    recordUsage({ ...base, input_tokens: 1e30, output_tokens: -4, cache_read_input_tokens: 9e15, cache_creation_input_tokens: NaN });
    recordUsage({ ...base, input_tokens: NaN, output_tokens: null as never, latency_ms: -3 });
    recordUsage({ ...base, input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3 });
    expect(rows()).toEqual([
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, latency_ms: 5, error_code: null },
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, latency_ms: 0, error_code: null },
      { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 0, latency_ms: 5, error_code: null },
    ]);
    // The totals the dashboard and alerts read stay real numbers.
    expect(queryUsage({}, 'model').total).toMatchObject({ calls: 3, input_tokens: 10, output_tokens: 20 });
  });
});

describe('through the manager, from a provider that reports garbage', () => {
  const answer = (usage: unknown) => JSON.stringify({ id: 'x', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage });
  async function call(usage: unknown) {
    globalThis.fetch = (async () => new Response(answer(usage), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const manager = new LLMManager();
    manager.registerProvider(new OpenAIProvider('k'));
    manager.setTierMap({ medium: { provider: 'openai' } });
    return manager.chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]);
  }

  test('a null completion count: the reply is delivered and the call is recorded, not lost', async () => {
    const response = await call({ prompt_tokens: 10, completion_tokens: null });
    expect(response.content).toBe('hello');
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 0 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ input_tokens: 10, output_tokens: 0, error_code: null });
  });

  test('a missing prompt count (NaN once subtracted) and a missing usage block are 0, with the call recorded', async () => {
    await call({ completion_tokens: 3 });
    await call(undefined);
    expect(rows().map(r => [r.input_tokens, r.output_tokens])).toEqual([[0, 3], [0, 0]]);
  });

  test('1e30 and 9e15 are not stored', async () => {
    const response = await call({ prompt_tokens: 1e30, completion_tokens: 9e15 });
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(rows()[0]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  test('a stream that ends with garbage usage records the call with zeros', async () => {
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    globalThis.fetch = (async () => new Response(
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })
      + chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: -9, completion_tokens: 1e30 } })
      + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const manager = new LLMManager();
    manager.registerProvider(new OpenAIProvider('k'));
    manager.setTierMap({ conversation: { provider: 'openai' } });
    let done: { usage: unknown } | undefined;
    for await (const event of manager.streamTier('conversation', 'test', [{ role: 'user', content: 'hi' }])) if (event.type === 'done') done = event.response;
    expect(done?.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('every provider adapter, and the legacy paths', () => {
  const json = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  };
  const openAIStyle = (usage: unknown) => ({ id: 'x', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage });
  async function viaTier(provider: LLMProvider) {
    const manager = new LLMManager();
    manager.registerProvider(provider);
    manager.setTierMap({ medium: { provider: provider.name } });
    return manager.chatTier('medium', 'test', [{ role: 'user', content: 'hi' }]);
  }

  test('Anthropic: a missing usage block delivers the reply and records the call; garbage counts are 0', async () => {
    const reply = (usage: unknown) => ({ id: 'x', type: 'message', role: 'assistant', model: 'claude', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage });
    json(reply(undefined));
    expect((await viaTier(new AnthropicProvider('k'))).content).toBe('hello');
    json(reply({ input_tokens: 1e30, output_tokens: -2, cache_read_input_tokens: 'x', cache_creation_input_tokens: 4 }));
    expect((await viaTier(new AnthropicProvider('k'))).usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 });
    expect(rows().map(r => [r.input_tokens, r.output_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens])).toEqual([[0, 0, 0, 0], [0, 0, 0, 4]]);
  });

  test('Groq and OpenRouter: a bad cached figure does not zero out the prompt count, and no usage block is 0', async () => {
    json(openAIStyle({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1e30 } }));
    expect((await viaTier(new GroqProvider('k'))).usage).toEqual({ input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0 });
    json(openAIStyle({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: -7 } }));
    expect((await viaTier(new OpenRouterProvider('k'))).usage).toEqual({ input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0 });
    json(openAIStyle(undefined));
    expect((await viaTier(new GroqProvider('k'))).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    json(openAIStyle(undefined));
    expect((await viaTier(new OpenRouterProvider('k'))).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('the legacy chat and stream paths (no tier map) clean usage too', async () => {
    const provider: LLMProvider = {
      name: 'raw',
      async chat() { return { content: 'ok', tool_calls: [], usage: { input_tokens: 1e30, output_tokens: NaN }, model: 'm', finish_reason: 'stop' }; },
      async *stream() { yield { type: 'done', response: { content: 'ok', tool_calls: [], usage: { input_tokens: -1, output_tokens: 7 }, model: 'm', finish_reason: 'stop' } }; },
      async listModels() { return []; },
    } as unknown as LLMProvider;
    const manager = new LLMManager();
    manager.registerProvider(provider);
    manager.setPrimary('raw');
    expect((await manager.chat([{ role: 'user', content: 'hi' }])).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    let done: unknown;
    for await (const event of manager.stream([{ role: 'user', content: 'hi' }])) if (event.type === 'done') done = event.response.usage;
    expect(done).toEqual({ input_tokens: 0, output_tokens: 7 });
  });

  test('a rejected count is logged once, by field and kind, never with the value or the body', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new OpenAIProvider('k');
      provider.name = 'gw-log-test';
      for (let i = 0; i < 3; i++) {
        json({ ...openAIStyle({ prompt_tokens: 123456789012, completion_tokens: null, secret_marker: 'BODY-SECRET' }), note: 'BODY-SECRET' });
        await viaTier(provider);
      }
      const lines = warn.mock.calls.map(c => c.join(' ')).filter(l => l.includes('gw-log-test'));
      expect(lines).toEqual([
        '[LLM] gw-log-test reported prompt_tokens that is above 100000000; counted as 0 (unknown)',
        '[LLM] gw-log-test reported completion_tokens that is null; counted as 0 (unknown)',
      ]);
      expect(lines.join('\n')).not.toContain('123456789012');
      expect(lines.join('\n')).not.toContain('BODY-SECRET');
      // A count that is simply absent is not a rejection.
      warn.mockClear();
      const quiet = new OpenAIProvider('k');
      quiet.name = 'gw-quiet-test';
      json(openAIStyle(undefined));
      await viaTier(quiet);
      expect(warn.mock.calls.filter(c => c.join(' ').includes('gw-quiet-test'))).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
