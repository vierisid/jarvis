import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BACKGROUND_LIMITS, BackgroundBudget, setBackgroundBudget, type BackgroundLimits } from './background-budget';
import { LLMManager } from './manager';
import { runWithOrigin } from './origin';
import { LLMProviderError, type LLMOptions } from './provider';
import { UsejarvisAIProvider } from './usejarvis';

const originalFetch = globalThis.fetch;
const databases: Database[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  setBackgroundBudget(null);
  for (const db of databases.splice(0)) db.close();
});

const messages = [{ role: 'user' as const, content: 'Synthetic hosted retry' }];
function setup(streaming: boolean, limits: Partial<BackgroundLimits> = {}) {
  const db = new Database(':memory:'); databases.push(db);
  const budget = new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, ...limits });
  setBackgroundBudget(budget);
  const sent: number[] = [], active: number[] = [];
  globalThis.fetch = (async (_input, options) => {
    const body = JSON.parse(String(options?.body));
    sent.push(body.max_completion_tokens); active.push(budget.snapshot().active);
    if (sent.length === 1) return Response.json({ error: {
      message: 'max_tokens must be greater than thinking.budget_tokens',
    } }, { status: 400 });
    return streaming
      ? new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ model: 'uj-low', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  const manager = new LLMManager();
  manager.registerProvider(new UsejarvisAIProvider('https://fixture.invalid', 'fixture'));
  manager.setTierMap({ low: { provider: 'usejarvis_ai', model: 'uj-low' } });
  const invoke = async (options: LLMOptions = {}) => {
    const input = { max_tokens: 200, ...options };
    if (!streaming) return manager.chatTier('low', 'fixture', messages, input);
    for await (const event of manager.streamTier('low', 'fixture', messages, input)) {
      if (event.type === 'error') throw new LLMProviderError(event.error, event.code ?? 'unknown');
    }
  };
  return { budget, sent, active, invoke };
}

for (const streaming of [false, true]) {
  const mode = streaming ? 'stream' : 'chat';
  test(`hosted ${mode} retries reserve again, obey the output cap and reuse only their own slot`, async () => {
    const { budget, sent, active, invoke } = setup(streaming);
    const other = budget.acquire(messages, { max_tokens: 1 });
    try {
      await runWithOrigin('background', () => invoke());
      expect(sent).toEqual([200, BACKGROUND_LIMITS.requestOutputTokens]);
      expect(active).toEqual([2, 2]);
      const state = budget.snapshot();
      expect(state.active).toBe(1);
      expect(state.usage).toMatchObject({ requests: 3, outputTokens: 201 + BACKGROUND_LIMITS.requestOutputTokens,
        inputBytes: 3 * Buffer.byteLength(JSON.stringify({ messages, tools: [] })) });
    } finally { other.release(); }
    expect(budget.snapshot().active).toBe(0);
  });

  for (const [name, limits] of Object.entries({ attempts: { requests: 1 }, output: { outputTokens: 200 } })) {
    test(`hosted ${mode} cannot retry after exhausting the ${name} allowance`, async () => {
      const { budget, sent, invoke } = setup(streaming, limits);
      await expect(runWithOrigin('background', () => invoke())).rejects.toMatchObject({ code: 'background_throttled' });
      expect(sent).toEqual([200]);
      expect(budget.snapshot()).toMatchObject({ active: 0, reason: 'daily_budget', usage: { requests: 1, outputTokens: 200 } });
    });
  }

  test(`foreground hosted ${mode} retains its thinking retry without spending background allowance`, async () => {
    const { budget, sent, invoke } = setup(streaming, { requests: 0 });
    await runWithOrigin('user', () => invoke());
    expect(sent).toEqual([200, 16384]);
    expect(budget.snapshot()).toMatchObject({ active: 0, foreground: 0, usage: { requests: 0, outputTokens: 0 } });
  });
}
