import { createComposerLlmClient } from '../actions/tools/composer-llm';
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackgroundBudget, BACKGROUND_LIMITS, backgroundBudgetStatus, setBackgroundBudget } from './background-budget';
import { LLMManager } from './manager';
import { runWithOrigin } from './origin';
import { LLMProviderError, type LLMProvider, type LLMResponse } from './provider';

const databases: Database[] = [];
afterEach(() => { setBackgroundBudget(null); for (const db of databases.splice(0)) db.close(); });
const messages = [{ role: 'user' as const, content: 'Synthetic fixture' }];
const reply: LLMResponse = { content: 'ok', tool_calls: [], model: 'fixture', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
function setup(overrides: Partial<typeof BACKGROUND_LIMITS> = {}, now = Date.now) {
  const db = new Database(':memory:'); databases.push(db);
  const budget = new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, ...overrides }, now);
  setBackgroundBudget(budget); return { db, budget };
}
function manager(chat: LLMProvider['chat'], stream?: LLMProvider['stream']) {
  const m = new LLMManager();
  m.registerProvider({ name: 'fixture', chat, stream: stream ?? (async function* () { yield { type: 'done', response: reply }; }),
    listModels: async () => [] } as LLMProvider);
  m.setTierMap({ medium: { provider: 'fixture' } }); return m;
}
const bg = <T>(fn: () => T) => runWithOrigin('background', fn);

test('a burst admits two transports, refuses the rest without queuing, and lets two user chats through', async () => {
  const { budget } = setup(); let calls = 0; let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const m = manager(async () => { calls++; if (calls <= 2) await hold; return reply; });
  const first = bg(() => m.chatTier('medium', 'awareness', messages));
  const second = bg(() => m.chatTier('medium', 'awareness', messages));
  const burst = await Promise.allSettled(Array.from({ length: 100 }, () => bg(() => m.chatTier('medium', 'awareness', messages))));
  expect(burst.every(r => r.status === 'rejected')).toBe(true);
  expect(calls).toBe(2); expect(budget.snapshot().active).toBe(2);
  await runWithOrigin('user', () => Promise.all([m.chatTier('medium', 'chat', messages), m.chatTier('medium', 'chat', messages)]));
  expect(calls).toBe(4); expect(budget.snapshot().usage.requests).toBe(2);
  release(); await Promise.all([first, second]); expect(budget.snapshot().active).toBe(0);
});

test('attempt, payload and output reservations survive a new governor and expire only with the rolling window', () => {
  let now = 100_000_000;
  const { db, budget } = setup({}, () => now);
  const lease = budget.acquire(messages, { max_tokens: 9000 });
  expect(lease.options.max_tokens).toBe(8192); lease.release(); lease.release();
  const restarted = new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, requests: 1 }, () => now);
  expect(() => restarted.acquire(messages)).toThrow('daily_budget');
  expect(restarted.snapshot().usage.outputTokens).toBe(8192);
  now += BACKGROUND_LIMITS.windowMs;
  restarted.acquire(messages).release(); expect(restarted.snapshot().usage.requests).toBe(1);
});

test('oversized requests and exhausted output budgets make zero provider calls', async () => {
  const { db } = setup(); let calls = 0;
  setBackgroundBudget(new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, outputTokens: 1 }));
  const m = manager(async () => { calls++; return reply; });
  await expect(bg(() => m.chatTier('medium', 'test', messages))).rejects.toThrow('daily_budget');
  await expect(bg(() => m.chatTier('medium', 'test', [{ role: 'user', content: 'x'.repeat(BACKGROUND_LIMITS.requestBytes) }]))).rejects.toThrow('request_size');
  expect(calls).toBe(0);
});

test('unavailable database refuses background calls, while user calls still work', async () => {
  const { db } = setup(); db.close(); databases.splice(databases.indexOf(db), 1);
  let calls = 0; const m = manager(async () => { calls++; return reply; });
  await expect(bg(() => m.chatTier('medium', 'test', messages))).rejects.toThrow('budget_unavailable');
  expect(backgroundBudgetStatus().state).toBe('unavailable');
  await runWithOrigin('user', () => m.chatTier('medium', 'chat', messages)); expect(calls).toBe(1);
});

test('quota failure backs off across restart; unknown usage and failures do not refund the reservation', async () => {
  const { db, budget } = setup(); let calls = 0;
  const m = manager(async () => { calls++; throw new LLMProviderError('fixture', 'quota_exhausted'); });
  await expect(bg(() => m.chatTier('medium', 'test', messages))).rejects.toThrow();
  expect(budget.snapshot().usage.requests).toBe(1);
  setBackgroundBudget(new BackgroundBudget(() => db));
  await expect(bg(() => m.chatTier('medium', 'test', messages))).rejects.toThrow('provider_backoff');
  expect(calls).toBe(1);
});

test('cancellation does not release a slot for a transport that ignores abort', async () => {
  const { budget } = setup(); let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const m = manager(async () => { await hold; return reply; });
  const abort = new AbortController();
  const pending = bg(() => m.chatTier('medium', 'test', messages, { signal: abort.signal }));
  abort.abort(); await expect(pending).rejects.toThrow();
  expect(budget.snapshot().active).toBe(1);
  release(); await new Promise(resolve => setTimeout(resolve, 0)); expect(budget.snapshot().active).toBe(0);
});

test('streaming and legacy calls use the same durable budget; a streamed error persists backoff', async () => {
  const { budget } = setup();
  const m = manager(async () => reply, async function* () { yield { type: 'error', error: 'fixture', code: 'quota_exhausted' }; });
  await bg(async () => { for await (const _ of m.streamTier('medium', 'test', messages)) { /* consume */ } });
  expect(budget.snapshot().reason).toBe('provider_backoff'); expect(budget.snapshot().active).toBe(0);
  m.setTierMap({});
  await expect(bg(() => m.chat(messages))).rejects.toThrow('provider_backoff');
  expect(budget.snapshot().usage.requests).toBe(1);
});

test('detached prepared composition is bounded while an explicitly user initiated composition stays foreground', async () => {
  const { db } = setup();
  setBackgroundBudget(new BackgroundBudget(() => db, { ...BACKGROUND_LIMITS, requests: 0 }));
  let calls = 0; const client = createComposerLlmClient(manager(async () => { calls++; return reply; }));
  await expect(client.chat({ prompt: 'fixture' })).rejects.toThrow('daily_budget');
  await runWithOrigin('user', () => client.chat({ prompt: 'fixture' })); expect(calls).toBe(1);
});

test('new background work waits for active foreground work and does not serialize refused payloads', async () => {
  const { budget } = setup(); let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const m = manager(async () => { await hold; return reply; });
  const user = runWithOrigin('user', () => m.chatTier('medium', 'chat', messages));
  const payload = [{ role: 'user' as const, content: 'fixture', toJSON() { throw new Error('must not serialize'); } }];
  await expect(bg(() => m.chatTier('medium', 'capture', payload))).rejects.toThrow('foreground_busy');
  expect(budget.snapshot().usage.requests).toBe(0);
  release(); await user; expect(budget.snapshot().state).toBe('ready');
});

test('a reservation larger than remaining allowance persists its retry time for queue admission', () => {
  const { db, budget } = setup();
  db.run('INSERT INTO background_model_reservations(started_at,input_bytes,output_tokens) VALUES (?,?,?)', [Date.now(), 0, BACKGROUND_LIMITS.outputTokens - 1]);
  expect(() => budget.acquire(messages)).toThrow('daily_budget');
  expect(new BackgroundBudget(() => db).snapshot().reason).toBe('daily_budget');
});
