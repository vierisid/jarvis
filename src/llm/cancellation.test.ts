import { afterEach, expect, test } from 'bun:test';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { OpenAICompatibleProvider } from './openai-compatible';
import { GroqProvider } from './groq';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';
import { NVIDIAProvider } from './nvidia';
import { LLMManager } from './manager';
import { LLMProviderError, type LLMOptions, type LLMResponse } from './provider';
import { composeFlow, type ComposerLlmClient } from '../actions/tools/workflow-composer';
import { createComposerLlmClient } from '../actions/tools/composer-llm';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const provider of [new AnthropicProvider('test'), new OpenAIProvider('test'),
  new OpenAICompatibleProvider('http://localhost/test'), new GroqProvider('test'), new GeminiProvider('test'),
  new OllamaProvider(), new OpenRouterProvider('test'), new NVIDIAProvider('test')]) {
  test(`${provider.name} aborts the in-flight transport`, async () => {
    const abort = new AbortController();
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url, options) => {
      seen = options?.signal;
      return new Promise<Response>((_, reject) => seen?.addEventListener('abort', () => reject(seen!.reason), { once: true }));
    }) as typeof fetch;
    const pending = provider.chat([{ role: 'user', content: 'Compose a routine' }], { signal: abort.signal });
    expect(seen).toBe(abort.signal);
    abort.abort(new Error('Composition stopped'));
    await expect(pending).rejects.toThrow('Composition stopped');
  });
}

test('cancellation reaches transport through the composer and tier router', async () => {
  const abort = new AbortController();
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url, options) => {
    seen = options?.signal;
    return new Promise<Response>((_, reject) => seen?.addEventListener('abort', () => reject(seen!.reason), { once: true }));
  }) as typeof fetch;
  const manager = new LLMManager(); manager.registerProvider(new OpenAIProvider('test'));
  manager.setTierMap({ high: { provider: 'openai' } });
  const pending = composeFlow({ llm: createComposerLlmClient(manager), pieceRegistry: sampleCatalog() },
    { name: 'Test', description: 'Check my invoices', signal: abort.signal });
  // The manager composes the caller's signal with its own request timeout, so
  // the transport gets a derived signal rather than this exact object.
  expect(seen?.aborted).toBe(false);
  abort.abort(new Error('Composition stopped'));
  expect(seen?.aborted).toBe(true);
  await expect(pending).rejects.toThrow('Composition stopped');
});

test('aborted provider failures cannot trigger a retry or tier failover', async () => {
  const abort = new AbortController();
  let calls = 0;
  const manager = new LLMManager();
  for (const name of ['primary', 'fallback']) manager.registerProvider({ name,
    async chat(_messages, options?: LLMOptions): Promise<LLMResponse> {
      calls++;
      const signal = options?.signal;
      expect(signal?.aborted).toBe(false);
      abort.abort(new Error('Composition stopped'));
      expect(signal?.aborted).toBe(true);
      throw new LLMProviderError('Rate limited', 'rate_limit');
    }, async *stream() {}, async listModels() { return []; } });
  manager.setTierMap({ high: { provider: 'primary' }, medium: { provider: 'fallback' } });
  await expect(manager.chatTier('high', 'test', [], { signal: abort.signal })).rejects.toThrow('Composition stopped');
  expect(calls).toBe(1);
});

for (const path of ['tools', 'text', 'fallback'] as const) {
  test(`late ${path} replies cannot start another composer turn after cancellation`, async () => {
    const abort = new AbortController(); let calls = 0;
    const reply = () => { calls++; abort.abort(new Error('Composition stopped')); };
    const llm: ComposerLlmClient = {
      async chat(input) { expect(input.signal).toBe(abort.signal); reply(); return { text: 'invalid JSON' }; },
      ...(path !== 'text' ? { async chatTools(_messages: unknown, _tools: unknown, signal?: AbortSignal) {
        expect(signal).toBe(abort.signal); reply();
        if (path === 'fallback') throw new Error('tools unsupported');
        return { content: '', tool_calls: [{ id: '1', name: 'list_pieces', arguments: {} }] };
      } } : {}),
    };
    await expect(composeFlow({ llm, pieceRegistry: sampleCatalog() },
      { name: 'Test', description: 'Review invoices', signal: abort.signal })).rejects.toThrow('Composition stopped');
    expect(calls).toBe(1);
  });
}
