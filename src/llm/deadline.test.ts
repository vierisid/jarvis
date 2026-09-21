import { afterEach, expect, spyOn, test } from 'bun:test';
import { LLMManager } from './manager';
import { UsejarvisAIProvider } from './usejarvis';
import { OpenAICompatibleProvider } from './openai-compatible';
import { GroqProvider } from './groq';
import { classifyErrorString, LLMProviderError, type LLMProvider } from './provider';
import { composeFlow } from '../actions/tools/workflow-composer';
import { createComposerLlmClient } from '../actions/tools/composer-llm';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';

const statics = LLMManager as unknown as { REQUEST_TIMEOUT_MS: number };
const originalTimeout = statics.REQUEST_TIMEOUT_MS;
const originalFetch = globalThis.fetch;
let restoreClock = () => {};
afterEach(() => { statics.REQUEST_TIMEOUT_MS = originalTimeout; globalThis.fetch = originalFetch; restoreClock(); });
function managerWith(chat: LLMProvider['chat']) {
  const manager = new LLMManager();
  manager.registerProvider({ name: 'fixture', chat, async *stream() {}, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'fixture' } });
  return manager;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const [provider, status, body, contentType] of [
  [new UsejarvisAIProvider('https://fixture.invalid', 'fake'), 400,
    JSON.stringify({ error: { message: '`max_tokens` must be greater than `thinking.budget_tokens`.' } }), 'application/json'],
  [new OpenAICompatibleProvider('https://fixture.invalid'), 404, '<html>route missing</html>', 'text/html'],
  [new GroqProvider('fake'), 413, 'Request too large', 'text/plain'],
] as const) {
  test(`expired composition blocks ${provider.name} internal recovery before a second HTTP request`, async () => {
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    restoreClock = () => clock.mockRestore();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++; now = 101;
      return new Response(body, { status, headers: { 'Content-Type': contentType } });
    }) as unknown as typeof fetch;
    const manager = new LLMManager();
    manager.registerProvider(provider);
    manager.setTierMap({ high: { provider: provider.name } });
    const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 100,
      llm: createComposerLlmClient(manager) }, { name: 'Report', description: 'Prepare a report' });
    expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
    expect(calls).toBe(1);
  });
}

for (const path of ['tools', 'text'] as const) {
  for (const failure of ['retry', 'failover'] as const) {
    test(`expired composition blocks manager ${failure} on the ${path} path before its timer fires`, async () => {
      let now = 0;
      const clock = spyOn(performance, 'now').mockImplementation(() => now);
      restoreClock = () => clock.mockRestore();
      let calls = 0;
      const manager = managerWith(async () => {
        calls++;
        // Model synchronous provider work crossing the absolute deadline.
        // No event-loop turn occurs, so the abort timer cannot have fired.
        now = 101;
        throw new LLMProviderError('Provider unavailable', failure === 'retry' ? 'network' : 'rate_limit');
      });
      manager.registerProvider({ name: 'fallback', async chat() {
        calls++;
        throw new LLMProviderError('Fallback unavailable', 'bad_request');
      }, async *stream() {}, async listModels() { return []; } });
      manager.setTierMap({ high: { provider: 'fixture' }, medium: { provider: 'fallback' } });
      const client = createComposerLlmClient(manager);
      const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 100,
        llm: path === 'tools' ? client : { chat: client.chat } },
      { name: 'Report', description: 'Prepare a report' });
      expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
      expect(calls).toBe(1);
    });
  }
}

test('the actual manager timeout wording is a network failure', () => {
  expect(classifyErrorString('LLM request to fixture timed out after 90000ms')).toBe('network');
});

test('manager timeouts retain a typed network code through bounded retries', async () => {
  statics.REQUEST_TIMEOUT_MS = 10;
  const signals: AbortSignal[] = [];
  const manager = managerWith(async (_messages, options) => {
    signals.push(options!.signal!);
    return new Promise(() => {}); // deliberately ignores cancellation
  });
  const error = await manager.chatTier('high', 'test', []).catch(error => error);
  expect(error).toBeInstanceOf(LLMProviderError);
  expect(error.code).toBe('network');
  expect(error.message).toContain('timed out');
  expect(signals).toHaveLength(3);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

test('actual manager timeouts cannot become a text-only fallback through the adapter', async () => {
  statics.REQUEST_TIMEOUT_MS = 10;
  let calls = 0;
  let texts = 0;
  const manager = managerWith(async (_messages, options) => {
    calls++; if (!options?.tools) texts++;
    return new Promise(() => {});
  });
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 500,
    llm: createComposerLlmClient(manager) }, { name: 'Report', description: 'Prepare a report' });
  expect(result).toMatchObject({ ok: false, errorCode: 'network' });
  expect(calls).toBe(3);
  expect(texts).toBe(0);
});

test('the composition budget cancels the real manager before its request retry allowance is exhausted', async () => {
  statics.REQUEST_TIMEOUT_MS = 100;
  let calls = 0;
  let seen: AbortSignal | undefined;
  const manager = managerWith(async (_messages, options) => {
    calls++; seen = options?.signal;
    return new Promise(() => {});
  });
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 20,
    llm: createComposerLlmClient(manager) }, { name: 'Report', description: 'Prepare a report' });
  expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
  expect(seen?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test('caller cancellation settles even if a provider ignores its signal', async () => {
  statics.REQUEST_TIMEOUT_MS = 100;
  const abort = new AbortController();
  let calls = 0;
  const manager = managerWith(async () => { calls++; return new Promise(() => {}); });
  const stopped = new Error('caller stopped');
  const pending = manager.chatTier('high', 'test', [], { signal: abort.signal }).catch(error => error);
  abort.abort(stopped);
  const result = await Promise.race([pending, pause(40).then(() => 'still waiting')]);
  await pending;
  expect(result).toBe(stopped);
  expect(calls).toBe(1);
});

test('caller cancellation interrupts Retry-After without a second dispatch', async () => {
  const abort = new AbortController();
  let calls = 0;
  const manager = managerWith(async () => {
    calls++;
    throw new LLMProviderError('Retry later', 'rate_limit', 100);
  });
  const stopped = new Error('stop during retry wait');
  const pending = manager.chatTier('high', 'test', [], { signal: abort.signal }).catch(error => error);
  await pause(5);
  abort.abort(stopped);
  const result = await Promise.race([pending, pause(40).then(() => 'still waiting')]);
  await pending;
  expect(result).toBe(stopped);
  expect(calls).toBe(1);
});

test('legacy routing also stops retries and fallback after caller cancellation', async () => {
  statics.REQUEST_TIMEOUT_MS = 100;
  const abort = new AbortController();
  let calls = 0;
  const manager = managerWith(async () => { calls++; return new Promise(() => {}); });
  manager.registerProvider({ name: 'fallback', async chat() { calls++; throw new Error('unexpected fallback'); },
    async *stream() {}, async listModels() { return []; } });
  manager.setFallbackChain(['fallback']);
  const stopped = new Error('network request cancelled');
  const pending = manager.chatWithOverride([], null, { signal: abort.signal }).catch(error => error);
  abort.abort(stopped);
  const result = await Promise.race([pending, pause(40).then(() => 'still waiting')]);
  await pending;
  expect(result).toBe(stopped);
  expect(calls).toBe(1);
});
