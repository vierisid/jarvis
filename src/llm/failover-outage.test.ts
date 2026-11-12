import { afterEach, beforeEach, expect, test } from 'bun:test';
import { LLMManager } from './manager';
import { OpenAIProvider } from './openai';
import { classifyErrorString, getLLMErrorCode, LLMProviderError, type LLMErrorCode, type LLMProvider, type LLMStreamEvent } from './provider';
import { failureEvidence } from '../failures/evidence';
import { failureText, projectFailure } from '../failures/projection';

const statics = LLMManager as unknown as { RETRY_BACKOFF_MS: number[] };
const originalBackoff = statics.RETRY_BACKOFF_MS;
const originalFetch = globalThis.fetch;
beforeEach(() => { statics.RETRY_BACKOFF_MS = [0, 0]; });
afterEach(() => { statics.RETRY_BACKOFF_MS = originalBackoff; globalThis.fetch = originalFetch; });

const reply = { content: 'from fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm', finish_reason: 'stop' as const };
const messages = [{ role: 'user' as const, content: 'hi' }];

function pair(failure: () => Error | LLMProviderError) {
  const calls = { primary: 0, fallback: 0 };
  const manager = new LLMManager();
  const primary: LLMProvider = { name: 'primary', async chat() { calls.primary++; throw failure(); },
    async *stream() { calls.primary++; const e = failure(); yield { type: 'error', error: e.message, code: e instanceof LLMProviderError ? e.code : undefined } as LLMStreamEvent; },
    async listModels() { return []; } };
  const fallback: LLMProvider = { name: 'fallback', async chat() { calls.fallback++; return reply; },
    async *stream() { calls.fallback++; yield { type: 'text', text: 'from fallback' }; yield { type: 'done', response: reply }; }, async listModels() { return []; } };
  manager.registerProvider(primary);
  manager.registerProvider(fallback);
  manager.setTierMap({ high: { provider: 'primary' }, medium: { provider: 'fallback' } });
  return { manager, calls };
}

const outages: Array<[string, () => Error]> = [
  ['a 503', () => new LLMProviderError('API error: 503 overloaded', 'server')],
  ['a 500', () => new LLMProviderError('API error: 500 boom', 'server')],
  ['a timeout', () => new LLMProviderError('LLM request to primary timed out after 90000ms', 'network')],
  ['a refused connection', () => new Error('fetch failed: ECONNREFUSED')],
  ['a reset connection', () => new Error('ECONNRESET: The socket connection was closed unexpectedly')],
  ['a malformed reply', () => new Error('Malformed_HTTP_Response fetching "http://x"')],
];
for (const [name, failure] of outages) {
  test(`${name} moves on to the next configured provider (chat)`, async () => {
    const { manager, calls } = pair(failure);
    expect((await manager.chatTier('high', 't', messages)).content).toBe('from fallback');
    expect(calls.fallback).toBe(1);
    expect(calls.primary).toBeGreaterThan(0);
  });
  test(`${name} moves on to the next configured provider (stream)`, async () => {
    const { manager, calls } = pair(failure);
    const events: LLMStreamEvent[] = [];
    for await (const event of manager.streamTier('high', 't', messages)) events.push(event);
    expect(events.map(e => e.type)).toEqual(['text', 'done']);
    expect(calls.fallback).toBe(1);
  });
}

for (const code of ['bad_request', 'content_policy'] as LLMErrorCode[]) {
  test(`${code} never moves to another provider`, async () => {
    const { manager, calls } = pair(() => new LLMProviderError('refused the request', code));
    await expect(manager.chatTier('high', 't', messages)).rejects.toThrow();
    expect(calls.fallback).toBe(0);
  });
}

test('a reset connection or a malformed reply is retried once, not three times', async () => {
  for (const failure of [() => new Error('ECONNRESET: The socket connection was closed unexpectedly'), () => new Error('Malformed_HTTP_Response')]) {
    const { manager, calls } = pair(failure);
    await manager.chatTier('high', 't', messages);
    expect(calls.primary).toBe(2);
  }
});

test('a 500 is retried three times with a pause between the attempts', async () => {
  statics.RETRY_BACKOFF_MS = [40, 80];
  const calls = { n: 0 };
  const manager = new LLMManager();
  manager.registerProvider({ name: 'only', async chat() { calls.n++; throw new LLMProviderError('API error: 500', 'server'); },
    async *stream() {}, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'only' } });
  const started = Date.now();
  await expect(manager.chatTier('high', 't', messages)).rejects.toThrow();
  expect(calls.n).toBe(3);
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);
});

test('a 5xx is reported as the provider returning an error, a refused connection as unreachable', () => {
  const text = (error: Error) => failureText(projectFailure(failureEvidence(error), { label: 'The Ask step', sideEffects: false }));
  const server = projectFailure(failureEvidence(new LLMProviderError('x', 'server')), { label: 'The Ask step', sideEffects: false });
  expect(text(new LLMProviderError('x', 'server'))).toContain('returned an error');
  expect(text(new LLMProviderError('x', 'server'))).not.toContain('could not be reached');
  expect(server.category).not.toBe('target_offline');
  expect(text(new LLMProviderError('x', 'network'))).toContain('could not be reached');
});

test('an OpenAI-compatible server that answers 200 with a page that is not JSON is a provider error', async () => {
  globalThis.fetch = (async () => new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const error = await new OpenAIProvider('k').chat(messages).catch(e => e);
  expect(error).toBeInstanceOf(LLMProviderError);
  expect(error.code).toBe('server');
  expect(error.message).toContain('not valid JSON');
  expect(error.message).not.toContain('captive portal');
  globalThis.fetch = (async () => new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  expect((await new OpenAIProvider('k').chat(messages).catch(e => e)).code).toBe('server');
});

for (const code of ['auth', 'forbidden'] as LLMErrorCode[]) {
  test(`${code} never moves to another provider`, async () => {
    const { manager, calls } = pair(() => new LLMProviderError('refused the key', code));
    await expect(manager.chatTier('high', 't', messages)).rejects.toThrow();
    expect(calls.fallback).toBe(0);
  });
}

test('a stated 4xx whose body mentions a timeout or a 5xx number is a request error and stays put', async () => {
  for (const message of [
    'Anthropic API error (400): max_tokens: 512 is below the thinking budget',
    'Gemini API error (400): invalid value for field "timeout"',
    'OpenRouter API error (422): upstream said 503 for this payload',
  ]) {
    expect(classifyErrorString(message)).not.toBe('server');
    expect(classifyErrorString(message)).not.toBe('network');
    const { manager, calls } = pair(() => new Error(message));
    await expect(manager.chatTier('high', 't', messages)).rejects.toThrow();
    expect(calls.primary).toBe(1);
    expect(calls.fallback).toBe(0);
  }
  // A stated 5xx and a 408 still read as outages.
  expect(classifyErrorString('Anthropic API error (529): overloaded')).toBe('server');
  expect(classifyErrorString('Gemini API error (408): request timeout')).toBe('network');
});

test('an outage never reaches a provider that is registered but not mapped to a tier', async () => {
  const calls = { primary: 0, stray: 0 };
  const manager = new LLMManager();
  manager.registerProvider({ name: 'primary', async chat() { calls.primary++; throw new LLMProviderError('API error: 503', 'server'); },
    async *stream() { calls.primary++; yield { type: 'error', error: 'API error: 503', code: 'server' }; }, async listModels() { return []; } });
  manager.registerProvider({ name: 'stray', async chat() { calls.stray++; return reply; },
    async *stream() { calls.stray++; yield { type: 'done', response: reply }; }, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'primary' } });
  await expect(manager.chatTier('high', 't', messages)).rejects.toThrow();
  const events: LLMStreamEvent[] = [];
  for await (const event of manager.streamTier('high', 't', messages)) events.push(event);
  expect(events.map(e => e.type)).toEqual(['error']);
  expect(calls.stray).toBe(0);
  // Bounded: three attempts per call, no loop back to the failed provider.
  expect(calls.primary).toBe(6);
});

test('every configured provider down ends in one error after a bounded number of attempts', async () => {
  const calls: Record<string, number> = {};
  const manager = new LLMManager();
  for (const name of ['a', 'b', 'c']) {
    manager.registerProvider({ name, async chat() { calls[name] = (calls[name] ?? 0) + 1; throw new LLMProviderError('API error: 502', 'server'); },
      async *stream() {}, async listModels() { return []; } });
  }
  // `a` is mapped twice: it must not be tried again under the second tier.
  manager.setTierMap({ high: { provider: 'a' }, medium: { provider: 'b' }, low: { provider: 'a', model: 'other' } });
  const error = await manager.chatTier('high', 't', messages).catch(e => e);
  expect(error).toBeInstanceOf(LLMProviderError);
  expect(error.code).toBe('server');
  expect(calls).toEqual({ a: 3, b: 3 });
});

test('a stream that produced text before the provider failed is not resent to the next provider', async () => {
  const calls = { primary: 0, fallback: 0 };
  const manager = new LLMManager();
  manager.registerProvider({ name: 'primary', async chat() { return reply; },
    async *stream() { calls.primary++; yield { type: 'text', text: 'half an ans' }; yield { type: 'error', error: 'API error: 503', code: 'server' }; },
    async listModels() { return []; } });
  manager.registerProvider({ name: 'fallback', async chat() { return reply; },
    async *stream() { calls.fallback++; yield { type: 'text', text: 'from fallback' }; yield { type: 'done', response: reply }; }, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'primary' }, medium: { provider: 'fallback' } });
  const events: LLMStreamEvent[] = [];
  for await (const event of manager.streamTier('high', 't', messages)) events.push(event);
  expect(events.map(e => e.type)).toEqual(['text', 'error']);
  expect(events.filter(e => e.type === 'text').map(e => (e as { text: string }).text)).toEqual(['half an ans']);
  expect(calls).toEqual({ primary: 1, fallback: 0 });
});

test('a stream stopped by the caller does not move on to the next provider', async () => {
  const controller = new AbortController();
  const calls = { primary: 0, fallback: 0 };
  const manager = new LLMManager();
  manager.registerProvider({ name: 'primary', async chat() { return reply; },
    // A provider whose stream reports the abort as a dropped connection, on
    // its last attempt (a reset gets two).
    async *stream() { calls.primary++; if (calls.primary === 2) controller.abort(); yield { type: 'error', error: 'Stream error: ECONNRESET', code: 'network' }; },
    async listModels() { return []; } });
  manager.registerProvider({ name: 'fallback', async chat() { return reply; },
    async *stream() { calls.fallback++; yield { type: 'done', response: reply }; }, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'primary' }, medium: { provider: 'fallback' } });
  const events: LLMStreamEvent[] = [];
  for await (const event of manager.streamTier('high', 't', messages, { signal: controller.signal })) events.push(event);
  expect(events.map(e => e.type)).toEqual(['error']);
  // The turn ends on the provider it was stopped on: no second provider's
  // failure is added to what it reports.
  expect((events[0] as { code?: string }).code).toBe('network');
  expect((events[0] as { error: string }).error).not.toContain('fallback');
  expect(calls).toEqual({ primary: 2, fallback: 0 });
});

test('an error raised while reading a 200 body keeps its own code instead of becoming a bad reply', async () => {
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) { controller.error(new LLMProviderError('LLM request to openai timed out after 90000ms', 'network')); },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const error = await new OpenAIProvider('k').chat(messages).catch(e => e);
  expect(error.message).not.toContain('not valid JSON');
  expect(getLLMErrorCode(error)).toBe('network');
});
