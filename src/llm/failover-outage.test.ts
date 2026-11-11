import { afterEach, beforeEach, expect, test } from 'bun:test';
import { LLMManager } from './manager';
import { OpenAIProvider } from './openai';
import { LLMProviderError, type LLMErrorCode, type LLMProvider, type LLMStreamEvent } from './provider';
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
