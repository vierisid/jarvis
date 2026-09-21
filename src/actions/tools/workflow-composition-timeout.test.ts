import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { LLMProviderError } from '../../llm/provider';
import { LLMManager } from '../../llm/manager';
import { createComposerLlmClient } from './composer-llm';
import { CompositionTimeoutError, withCompositionBudget } from './composition-budget';
import { composeFlow } from './workflow-composer';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';

const request = { name: 'Report', description: 'Prepare a report for the dashboard only.' };
const flow = { displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY' } };
const valid = JSON.stringify(flow);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let restoreClock = () => {};
afterEach(() => { restoreClock(); jest.useRealTimers(); });

function controlledClock() {
  jest.useFakeTimers();
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  return { advance(ms: number) { now += ms; jest.advanceTimersByTime(ms); } };
}

for (const error of [
  new Error('LLM request to fixture timed out after 90000ms'),
  new Error('upstream unexpectedly closed'),
  new Error('500 internal server error: tools not supported (misleading body)'),
  new LLMProviderError('400 invalid JSON schema', 'bad_request'),
  new LLMProviderError('404 model not found', 'not_found'),
  new LLMProviderError('tools not supported (misleading body)', 'network'),
  new LLMProviderError('tools not supported (misleading body)', 'content_policy'),
]) {
  test(`provider failure does not become a tool-support fallback: ${error.message}`, async () => {
    let texts = 0;
    const result = await composeFlow({ pieceRegistry: sampleCatalog(), llm: {
      async chatTools() { throw error; },
      async chat() { texts++; return { text: valid }; },
    } }, request);
    expect(result.ok).toBe(false);
    expect(texts).toBe(0);
  });
}

for (const error of [new Error('tools not supported'),
  new LLMProviderError('400: This model does not support tools', 'bad_request'),
  new LLMProviderError('Capability unavailable', 'unsupported_tools')]) {
  test(`explicit unsupported tools still permit one-shot composition: ${error.message}`, async () => {
    let texts = 0;
    const result = await composeFlow({ pieceRegistry: sampleCatalog(), llm: {
      async chatTools() { throw error; },
      async chat() { texts++; return { text: valid }; },
    } }, request);
    expect(result.ok).toBe(true);
    expect(texts).toBe(1);
  });
}

test('one deadline covers tools, fallback and a provider that ignores abort', async () => {
  const clock = controlledClock();
  const signals: AbortSignal[] = [];
  const toolReply = Promise.withResolvers<void>();
  const fallbackStarted = Promise.withResolvers<void>();
  const lateReply = Promise.withResolvers<{ text: string }>();
  const pending = composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 50, llm: {
    async chatTools(_messages, _tools, signal) {
      signals.push(signal!); await toolReply.promise;
      throw new Error('tools not supported');
    },
    async chat({ signal }) {
      signals.push(signal!); fallbackStarted.resolve(); return lateReply.promise;
    },
  } }, request);
  clock.advance(25);
  toolReply.resolve();
  await fallbackStarted.promise;
  let settled = false;
  void pending.then(() => { settled = true; });
  clock.advance(24);
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(1);
  const result = await pending;
  lateReply.resolve({ text: valid });
  expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

test('repairs share the original budget and never accept a late valid result', async () => {
  const clock = controlledClock();
  const repairStarted = Promise.withResolvers<void>();
  const lateReply = Promise.withResolvers<{ text: string }>();
  let calls = 0;
  const pending = composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 30, llm: {
    async chat() {
      if (++calls === 1) { clock.advance(20); return { text: '{unfinished' }; }
      repairStarted.resolve(); return lateReply.promise;
    },
  } }, request);
  await repairStarted.promise;
  let settled = false;
  void pending.then(() => { settled = true; });
  clock.advance(9);
  await Promise.resolve();
  expect(settled).toBe(false);
  clock.advance(1);
  const result = await pending;
  expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
  lateReply.resolve({ text: valid });
  await Promise.resolve();
  expect(calls).toBe(2);
});

test('caller cancellation settles promptly and does not create a fallback from a late error', async () => {
  const abort = new AbortController();
  const stopped = new Error('user stopped');
  let release!: () => void;
  let texts = 0;
  const pending = composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 500, llm: {
    async chatTools() { await new Promise<void>(resolve => { release = resolve; }); throw new Error('tools not supported'); },
    async chat() { texts++; return { text: valid }; },
  } }, { ...request, signal: abort.signal }).catch(error => error);
  abort.abort(stopped);
  const result = await Promise.race([pending, pause(40).then(() => 'still waiting')]);
  release(); await pending;
  expect(result).toBe(stopped);
  expect(texts).toBe(0);
});

test('success disposes the composition timer', async () => {
  let seen: AbortSignal | undefined;
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 20, llm: {
    async chat({ signal }) { seen = signal; return { text: valid }; },
  } }, request);
  expect(result.ok).toBe(true);
  expect(seen).toBeDefined();
  await pause(35);
  expect(seen?.aborted).toBe(false);
});

test('synchronous work that overruns the deadline cannot start a repair', async () => {
  let calls = 0;
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 10, llm: {
    async chat() {
      calls++;
      const end = performance.now() + 20;
      while (performance.now() < end) { /* model adapter blocks the event loop */ }
      return { text: '{unfinished' };
    },
  } }, request);
  expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
  expect(calls).toBe(1);
});

// The composer does real synchronous work after its last provider reply --
// catalog rendering, JSON parsing, full flow validation. Nothing checks the
// deadline again on that path, so the post-run check is the only thing that
// stops a result finished past the budget from being returned as a success.
test('a result finished after the deadline is a typed failure, not a success', async () => {
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  let ran = false;
  const outcome = await withCompositionBudget(async () => {
    ran = true;
    now = 101; // validation overran the budget; the abort timer has not fired
    return { ok: true as const };
  }, undefined, 100).catch(error => error);
  expect(ran).toBe(true);
  expect(outcome).toBeInstanceOf(CompositionTimeoutError);
});

test('an already-cancelled composition makes no provider call', async () => {
  const abort = new AbortController();
  const stopped = new Error('cancelled before starting');
  abort.abort(stopped);
  let calls = 0;
  const outcome = await composeFlow({ pieceRegistry: sampleCatalog(), llm: {
    async chat() { calls++; return { text: valid }; },
  } }, { ...request, signal: abort.signal }).catch(error => error);
  expect(outcome).toBe(stopped);
  expect(calls).toBe(0);
});

for (const totalTimeoutMs of [0, -1, Infinity, NaN, 2_147_483_648]) {
  test(`invalid budget ${totalTimeoutMs} is rejected before dispatch`, async () => {
    let calls = 0;
    await expect(composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs, llm: {
      async chat() { calls++; return { text: valid }; },
    } }, request)).rejects.toThrow('totalTimeoutMs');
    expect(calls).toBe(0);
  });
}

test('explicit unsupported tools survives the real manager and adapter as a capability code', async () => {
  const manager = new LLMManager();
  let calls = 0;
  manager.registerProvider({ name: 'text-only', async chat(_messages, options) {
    calls++;
    if (options?.tools) throw new LLMProviderError('400: This model does not support tools', 'bad_request');
    return { content: valid, model: 'fixture', tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
  }, async *stream() {}, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'text-only' } });
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), llm: createComposerLlmClient(manager) }, request);
  expect(result.ok).toBe(true);
  expect(calls).toBe(2);
});

test('the real tier router and composer share a budget during Retry-After', async () => {
  const manager = new LLMManager();
  let calls = 0;
  manager.registerProvider({ name: 'slow', async chat() {
    calls++; throw new LLMProviderError('Try later', 'rate_limit', 100);
  }, async *stream() {}, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'slow' } });
  const result = await composeFlow({ pieceRegistry: sampleCatalog(), totalTimeoutMs: 25,
    llm: createComposerLlmClient(manager) }, request);
  expect(result).toMatchObject({ ok: false, errorCode: 'composition_timeout' });
  await pause(110);
  expect(calls).toBe(1);
});
