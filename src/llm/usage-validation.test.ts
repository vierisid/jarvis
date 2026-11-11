import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { queryUsage, recordUsage, setUsageDatabase } from './usage.ts';
import { cleanTokenCount, cleanUsage, MAX_TOKENS_PER_CALL, addUsage } from './provider.ts';
import { LLMManager } from './manager.ts';
import { OpenAIProvider } from './openai.ts';

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
