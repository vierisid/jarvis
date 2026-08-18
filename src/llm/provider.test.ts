import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider, modelRejectsCustomTemperature } from './openai.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { GroqProvider, isGroqJarvisModel, relaxOptionalFieldsToNullable } from './groq.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { NVIDIAProvider } from './nvidia.ts';
import { LiteLLMProvider } from './litellm.ts';
import { LLMManager } from './manager.ts';
import { guardImageSize, classifyHttpStatus, classifyErrorString, LLMProviderError, type LLMMessage, type ContentBlock } from './provider.ts';
import { setUsageDatabase } from './usage.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { isToolResult, type ToolResult } from '../actions/tools/registry.ts';

describe('LLM Provider Types', () => {
  test('AnthropicProvider can be instantiated', () => {
    const provider = new AnthropicProvider('test-key', 'test-model');
    expect(provider.name).toBe('anthropic');
  });

  test('OpenAIProvider can be instantiated', () => {
    const provider = new OpenAIProvider('test-key', 'test-model');
    expect(provider.name).toBe('openai');
  });

  test('GroqProvider can be instantiated', () => {
    const provider = new GroqProvider('test-key', 'test-model');
    expect(provider.name).toBe('groq');
  });

  test('OllamaProvider can be instantiated', () => {
    const provider = new OllamaProvider('http://localhost:11434', 'llama3');
    expect(provider.name).toBe('ollama');
  });

  test('OpenRouterProvider can be instantiated', () => {
    const provider = new OpenRouterProvider('test-key', 'anthropic/claude-sonnet-4');
    expect(provider.name).toBe('openrouter');
  });

  test('NVIDIAProvider can be instantiated', () => {
    const provider = new NVIDIAProvider('test-key');
    expect(provider.name).toBe('nvidia');
  });

  test('LiteLLMProvider can be instantiated', () => {
    const provider = new LiteLLMProvider('http://localhost:4000/v1', 'gpt-4o', 'sk-test');
    expect(provider.name).toBe('litellm');
  });

  test('LiteLLMProvider defaults to localhost:4000', () => {
    const provider = new LiteLLMProvider();
    expect(provider.name).toBe('litellm');
  });
});

describe('LLMManager', () => {
  const sampleMessages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

  test('can register providers', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    expect(manager.getProvider('anthropic')).toBe(anthropic);
  });

  test('sets first registered provider as primary', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    // Primary is set automatically
    expect(manager.getProvider('anthropic')).toBeDefined();
  });

  test('can change primary provider', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key-1');
    const openai = new OpenAIProvider('test-key-2');

    manager.registerProvider(anthropic);
    manager.registerProvider(openai);
    manager.setPrimary('openai');

    // Should not throw
    expect(manager.getProvider('openai')).toBeDefined();
  });

  test('throws when setting non-existent provider as primary', () => {
    const manager = new LLMManager();
    expect(() => manager.setPrimary('nonexistent')).toThrow();
  });

  test('can set fallback chain', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key-1');
    const openai = new OpenAIProvider('test-key-2');

    manager.registerProvider(anthropic);
    manager.registerProvider(openai);
    manager.setPrimary('anthropic');
    manager.setFallbackChain(['openai']);

    // Should not throw
    expect(manager.getProvider('anthropic')).toBeDefined();
    expect(manager.getProvider('openai')).toBeDefined();
  });

  test('throws when setting non-existent fallback provider', () => {
    const manager = new LLMManager();
    const anthropic = new AnthropicProvider('test-key');

    manager.registerProvider(anthropic);
    expect(() => manager.setFallbackChain(['nonexistent'])).toThrow();
  });

  test('falls back to the next provider for chat failures', async () => {
    const manager = new LLMManager();
    const primary = {
      name: 'primary',
      listModels: async () => ['primary-model'],
      chat: async () => {
        throw new Error('401 invalid_api_key');
      },
      async *stream() {
        yield { type: 'error' as const, error: '401 invalid_api_key' };
      },
    };
    const fallback = {
      name: 'fallback',
      listModels: async () => ['fallback-model'],
      chat: async () => ({
        content: 'fallback ok',
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'fallback-model',
        finish_reason: 'stop' as const,
      }),
      async *stream() {
        yield { type: 'text' as const, text: 'fallback ok' };
        yield {
          type: 'done' as const,
          response: {
            content: 'fallback ok',
            tool_calls: [],
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'fallback-model',
            finish_reason: 'stop' as const,
          },
        };
      },
    };

    manager.registerProvider(primary);
    manager.registerProvider(fallback);
    manager.setPrimary('primary');
    manager.setFallbackChain(['fallback']);

    const response = await manager.chat(sampleMessages);
    expect(response.content).toBe('fallback ok');
    expect(response.model).toBe('fallback-model');
  });

  test('falls back to the next provider for stream failures before output', async () => {
    const manager = new LLMManager();
    const primary = {
      name: 'primary',
      listModels: async () => ['primary-model'],
      chat: async () => {
        throw new Error('503 temporarily unavailable');
      },
      async *stream() {
        yield { type: 'error' as const, error: '503 temporarily unavailable' };
      },
    };
    const fallback = {
      name: 'fallback',
      listModels: async () => ['fallback-model'],
      chat: async () => ({
        content: 'fallback stream ok',
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'fallback-model',
        finish_reason: 'stop' as const,
      }),
      async *stream() {
        yield { type: 'text' as const, text: 'fallback stream ok' };
        yield {
          type: 'done' as const,
          response: {
            content: 'fallback stream ok',
            tool_calls: [],
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'fallback-model',
            finish_reason: 'stop' as const,
          },
        };
      },
    };

    manager.registerProvider(primary);
    manager.registerProvider(fallback);
    manager.setPrimary('primary');
    manager.setFallbackChain(['fallback']);

    const events = [];
    for await (const event of manager.stream(sampleMessages)) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'text' && event.text === 'fallback stream ok')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  test('does not retry a permanent streamed 400 before falling back', async () => {
    const manager = new LLMManager();
    let badCalls = 0;
    const bad = {
      name: 'bad',
      listModels: async () => [],
      async chat() { throw new Error('unused'); },
      async *stream() {
        badCalls++;
        yield { type: 'error' as const, error: 'Groq API error (400): model_decommissioned', code: 'bad_request' as const };
      },
    };
    const good = {
      name: 'good',
      listModels: async () => ['current'],
      async chat() { throw new Error('unused'); },
      async *stream() {
        yield { type: 'text' as const, text: 'recovered' };
        yield { type: 'done' as const, response: {
          content: 'recovered', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'current', finish_reason: 'stop' as const,
        } };
      },
    };
    manager.registerProvider(bad);
    manager.registerProvider(good);
    manager.setFallbackChain(['good']);

    const events = [];
    for await (const event of manager.stream(sampleMessages)) events.push(event);
    expect(badCalls).toBe(1);
    expect(events.some((event) => event.type === 'text' && event.text === 'recovered')).toBe(true);
  });

  test('tier routing recovers a decommissioned saved model with the provider default', async () => {
    const manager = new LLMManager();
    const seenModels: Array<string | undefined> = [];
    const groq = {
      name: 'groq',
      listModels: async () => ['openai/gpt-oss-20b'],
      async chat(_messages: LLMMessage[], options?: { model?: string }) {
        seenModels.push(options?.model);
        if (options?.model === 'deepseek-r1-distill-llama-70b') {
          throw new LLMProviderError('Groq API error (400): model_decommissioned', 'bad_request');
        }
        return {
          content: 'current model ok', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'openai/gpt-oss-20b', finish_reason: 'stop' as const,
        };
      },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(groq);
    manager.setTierMap({ medium: { provider: 'groq', model: 'deepseek-r1-distill-llama-70b' } });

    const response = await manager.chatTier('medium', 'test', sampleMessages);
    expect(response.content).toBe('current model ok');
    expect(seenModels).toEqual(['deepseek-r1-distill-llama-70b', undefined]);
  });

  test('tier routing skips a rate-limited provider and fails over immediately', async () => {
    const manager = new LLMManager();
    let groqCalls = 0;
    const groq = {
      name: 'groq', listModels: async () => ['openai/gpt-oss-20b'],
      async chat() {
        groqCalls++;
        throw new LLMProviderError('Groq API error (429): rate limit', 'rate_limit', 120_000);
      },
      async *stream() { /* not used */ },
    };
    const fallback = {
      name: 'openai', listModels: async () => ['gpt-5-mini'],
      async chat() { return {
        content: 'provider fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
        model: 'gpt-5-mini', finish_reason: 'stop' as const,
      }; },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(groq);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'groq', model: 'openai/gpt-oss-20b' },
      high: { provider: 'openai', model: 'gpt-5-mini' },
    });

    const response = await manager.chatTier('medium', 'test', sampleMessages);
    expect(response.content).toBe('provider fallback');
    expect(groqCalls).toBe(1);
  });

  test('tier routing does not send content to providers that have no tier assignment', async () => {
    const manager = new LLMManager();
    let unmappedCalls = 0;
    const mapped = {
      name: 'mapped', listModels: async () => ['retired'],
      async chat() { throw new LLMProviderError('model_not_found', 'not_found'); },
      async *stream() { /* not used */ },
    };
    const unmapped = {
      name: 'unmapped', listModels: async () => ['available'],
      async chat() {
        unmappedCalls++;
        return {
          content: 'must not run', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'available', finish_reason: 'stop' as const,
        };
      },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(mapped);
    manager.registerProvider(unmapped);
    manager.setTierMap({ medium: { provider: 'mapped', model: 'retired' } });

    await expect(manager.chatTier('medium', 'test', sampleMessages)).rejects.toBeInstanceOf(LLMProviderError);
    expect(unmappedCalls).toBe(0);
  });

  test('background tier failover never crosses into the conversation tier', async () => {
    const manager = new LLMManager();
    let conversationCalls = 0;
    const background = {
      name: 'background', listModels: async () => ['retired'],
      async chat() { throw new LLMProviderError('model_not_found', 'not_found'); },
      async *stream() { /* not used */ },
    };
    const conversation = {
      name: 'conversation', listModels: async () => ['expensive'],
      async chat() {
        conversationCalls++;
        return {
          content: 'must not run', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'expensive', finish_reason: 'stop' as const,
        };
      },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(background);
    manager.registerProvider(conversation);
    manager.setTierMap({
      low: { provider: 'background', model: 'retired' },
      conversation: { provider: 'conversation', model: 'expensive' },
    });

    await expect(manager.chatTier('low', 'background-test', sampleMessages))
      .rejects.toBeInstanceOf(LLMProviderError);
    expect(conversationCalls).toBe(0);
  });

  test('tier routing does not fail over malformed requests', async () => {
    const manager = new LLMManager();
    let fallbackCalls = 0;
    const malformed = {
      name: 'malformed', listModels: async () => ['model-a'],
      async chat() { throw new LLMProviderError('invalid tool schema', 'bad_request'); },
      async *stream() { /* not used */ },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() {
        fallbackCalls++;
        return {
          content: 'must not run', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'model-b', finish_reason: 'stop' as const,
        };
      },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(malformed);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'malformed', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    await expect(manager.chatTier('medium', 'test', sampleMessages)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(fallbackCalls).toBe(0);
  });

  test('tier routing does not treat an unrelated 404 as model failover', async () => {
    const manager = new LLMManager();
    let fallbackCalls = 0;
    const missingEndpoint = {
      name: 'missing-endpoint', listModels: async () => ['model-a'],
      async chat() { throw new LLMProviderError('POST /chat route not found', 'not_found'); },
      async *stream() { /* not used */ },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() {
        fallbackCalls++;
        return {
          content: 'must not run', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'model-b', finish_reason: 'stop' as const,
        };
      },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(missingEndpoint);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'missing-endpoint', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    await expect(manager.chatTier('medium', 'test', sampleMessages)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(fallbackCalls).toBe(0);
  });

  test('tier routing fails over before a short Retry-After sleep', async () => {
    const manager = new LLMManager();
    let limitedCalls = 0;
    const limited = {
      name: 'limited', listModels: async () => ['model-a'],
      async chat() {
        limitedCalls++;
        throw new LLMProviderError('quota exhausted', 'rate_limit', 30_000);
      },
      async *stream() { /* not used */ },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() { return {
        content: 'immediate fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
        model: 'model-b', finish_reason: 'stop' as const,
      }; },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(limited);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'limited', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    const started = Date.now();
    const response = await manager.chatTier('medium', 'test', sampleMessages);
    expect(response.content).toBe('immediate fallback');
    expect(limitedCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('tier routing fails over immediately on quota errors without Retry-After', async () => {
    const manager = new LLMManager();
    let limitedCalls = 0;
    const limited = {
      name: 'limited', listModels: async () => ['model-a'],
      async chat() {
        limitedCalls++;
        throw new LLMProviderError('quota exhausted', 'rate_limit');
      },
      async *stream() { /* not used */ },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() { return {
        content: 'immediate fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
        model: 'model-b', finish_reason: 'stop' as const,
      }; },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(limited);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'limited', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    const response = await manager.chatTier('medium', 'test', sampleMessages);
    expect(response.content).toBe('immediate fallback');
    expect(limitedCalls).toBe(1);
  });

  test('tier chat preserves Retry-After when every candidate is exhausted', async () => {
    const manager = new LLMManager();
    const groq = {
      name: 'groq', listModels: async () => ['openai/gpt-oss-20b'],
      async chat() { throw new LLMProviderError('quota exhausted', 'rate_limit', 120_000); },
      async *stream() { /* not used */ },
    };
    manager.registerProvider(groq);
    manager.setTierMap({ medium: { provider: 'groq', model: 'openai/gpt-oss-20b' } });

    await expect(manager.chatTier('medium', 'test', sampleMessages)).rejects.toMatchObject({
      code: 'rate_limit',
      retryAfterMs: 120_000,
    });
  });

  test('tier streaming preserves typed codes from thrown provider errors', async () => {
    const manager = new LLMManager();
    let fallbackCalls = 0;
    const primary = {
      name: 'primary', listModels: async () => ['model-a'],
      async chat() { throw new Error('not used'); },
      async *stream() { throw new LLMProviderError('opaque failure', 'auth'); },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() { throw new Error('not used'); },
      async *stream() { fallbackCalls++; },
    };
    manager.registerProvider(primary);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'primary', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    const events = [];
    for await (const event of manager.streamTier('medium', 'test', sampleMessages)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'auth' });
    expect(fallbackCalls).toBe(0);
  });

  test('tier streaming fails over before a short Retry-After sleep', async () => {
    const manager = new LLMManager();
    let limitedCalls = 0;
    const limited = {
      name: 'limited', listModels: async () => ['model-a'],
      async chat() { throw new Error('not used'); },
      async *stream() {
        limitedCalls++;
        yield {
          type: 'error' as const,
          error: 'quota exhausted',
          code: 'rate_limit' as const,
          retry_after_ms: 30_000,
        };
      },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() { throw new Error('not used'); },
      async *stream() {
        yield { type: 'text' as const, text: 'immediate fallback' };
        yield { type: 'done' as const, response: {
          content: 'immediate fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'model-b', finish_reason: 'stop' as const,
        } };
      },
    };
    manager.registerProvider(limited);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'limited', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    const started = Date.now();
    const events = [];
    for await (const event of manager.streamTier('medium', 'test', sampleMessages)) events.push(event);
    expect(events.some((event) => event.type === 'text' && event.text === 'immediate fallback')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(limitedCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('tier streaming fails over immediately on quota errors without Retry-After', async () => {
    const manager = new LLMManager();
    let limitedCalls = 0;
    const limited = {
      name: 'limited', listModels: async () => ['model-a'],
      async chat() { throw new Error('not used'); },
      async *stream() {
        limitedCalls++;
        yield { type: 'error' as const, error: 'quota exhausted', code: 'rate_limit' as const };
      },
    };
    const fallback = {
      name: 'fallback', listModels: async () => ['model-b'],
      async chat() { throw new Error('not used'); },
      async *stream() {
        yield { type: 'text' as const, text: 'immediate fallback' };
        yield { type: 'done' as const, response: {
          content: 'immediate fallback', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 },
          model: 'model-b', finish_reason: 'stop' as const,
        } };
      },
    };
    manager.registerProvider(limited);
    manager.registerProvider(fallback);
    manager.setTierMap({
      medium: { provider: 'limited', model: 'model-a' },
      high: { provider: 'fallback', model: 'model-b' },
    });

    const events = [];
    for await (const event of manager.streamTier('medium', 'test', sampleMessages)) events.push(event);
    expect(events.some((event) => event.type === 'text' && event.text === 'immediate fallback')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(limitedCalls).toBe(1);
  });

  test('tier streaming preserves Retry-After when every candidate is exhausted', async () => {
    const manager = new LLMManager();
    const groq = {
      name: 'groq', listModels: async () => ['openai/gpt-oss-20b'],
      async chat() { throw new Error('not used'); },
      async *stream() {
        yield {
          type: 'error' as const,
          error: 'Groq API error (429): rate limit',
          code: 'rate_limit' as const,
          retry_after_ms: 120_000,
        };
      },
    };
    manager.registerProvider(groq);
    manager.setTierMap({ medium: { provider: 'groq', model: 'openai/gpt-oss-20b' } });

    const events = [];
    for await (const event of manager.streamTier('medium', 'test', sampleMessages)) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'rate_limit',
      retry_after_ms: 120_000,
    });
  });

  test('Retry-After sleeps draw down a shared per-provider budget', async () => {
    const manager = new LLMManager() as unknown as {
      waitForRetry(retryAfterMs: number | undefined, budget: { remainingMs: number }): Promise<boolean>;
    };
    const budget = { remainingMs: 100 };
    expect(await manager.waitForRetry(60, budget)).toBe(true);
    expect(budget.remainingMs).toBe(40);
    // A second wait that would overrun the remaining budget fails over
    // instead of stacking sleeps past the cap.
    expect(await manager.waitForRetry(60, budget)).toBe(false);
    // No Retry-After: retry immediately without drawing down the budget.
    expect(await manager.waitForRetry(undefined, budget)).toBe(true);
    expect(budget.remainingMs).toBe(40);
  });

  test('tier streaming records usage when the consumer stops mid-stream', async () => {
    closeDb();
    const db = initDatabase(':memory:');
    setUsageDatabase(() => db);
    try {
      const manager = new LLMManager();
      const streamer = {
        name: 'streamer', listModels: async () => ['model-a'],
        async chat(): Promise<never> { throw new Error('not used'); },
        async *stream() {
          yield { type: 'text' as const, text: 'first chunk' };
          yield { type: 'text' as const, text: 'never consumed' };
        },
      };
      manager.registerProvider(streamer);
      manager.setTierMap({ medium: { provider: 'streamer', model: 'model-a' } });

      for await (const event of manager.streamTier('medium', 'abort-test', sampleMessages)) {
        if (event.type === 'text') break; // consumer disconnects mid-stream
      }

      const rows = db.query('SELECT provider, subsystem FROM llm_usage').all() as
        Array<{ provider: string; subsystem: string }>;
      expect(rows).toEqual([{ provider: 'streamer', subsystem: 'abort-test' }]);
    } finally {
      setUsageDatabase(() => null);
      closeDb();
    }
  });
});

describe('Message Types', () => {
  test('LLMMessage has correct structure', () => {
    const message: LLMMessage = {
      role: 'user',
      content: 'Hello',
    };

    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });

  test('supports all message roles', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('assistant');
  });
});

describe('Provider URLs', () => {
  test('AnthropicProvider uses correct API URL', () => {
    const provider = new AnthropicProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  test('OpenAIProvider uses correct API URL', () => {
    const provider = new OpenAIProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('OpenAICompatibleProvider adds a version root to gateway URLs', () => {
    const provider = new OpenAICompatibleProvider('https://gateway.example/api', '', 'test-key') as any;
    expect(provider.apiUrl).toBe('https://gateway.example/api/v1/chat/completions');
    expect(provider.modelsUrl).toBe('https://gateway.example/api/v1/models');
  });

  test('OpenAICompatibleProvider preserves an explicit version root', () => {
    const provider = new OpenAICompatibleProvider('https://gateway.example/api/v1/', '', 'test-key') as any;
    expect(provider.apiUrl).toBe('https://gateway.example/api/v1/chat/completions');
  });

  test('OpenRouterProvider uses correct API URL', () => {
    const provider = new OpenRouterProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  test('GroqProvider uses correct API URL', () => {
    const provider = new GroqProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  test('OllamaProvider uses correct base URL', () => {
    const provider = new OllamaProvider() as any;
    expect(provider.baseUrl).toBe('http://localhost:11434');
  });

  test('OllamaProvider removes trailing slash from base URL', () => {
    const provider = new OllamaProvider('http://localhost:11434/') as any;
    expect(provider.baseUrl).toBe('http://localhost:11434');
  });

  test('NVIDIAProvider uses correct API URL', () => {
    const provider = new NVIDIAProvider('test-key') as any;
    expect(provider.apiUrl).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });
});

describe('Default Models', () => {
  test('AnthropicProvider has correct default model', () => {
    const provider = new AnthropicProvider('test-key') as any;
    expect(provider.defaultModel).toBe('claude-sonnet-4-5-20250929');
  });

  test('OpenAIProvider has correct default model', () => {
    const provider = new OpenAIProvider('test-key') as any;
    expect(provider.defaultModel).toBe('gpt-4o');
  });

  test('OllamaProvider has correct default model', () => {
    const provider = new OllamaProvider() as any;
    expect(provider.defaultModel).toBe('llama3');
  });

  test('GroqProvider has correct default model', () => {
    const provider = new GroqProvider('test-key') as any;
    expect(provider.defaultModel).toBe('openai/gpt-oss-20b');
  });

  test('OpenRouterProvider has correct default model', () => {
    const provider = new OpenRouterProvider('test-key') as any;
    expect(provider.defaultModel).toBe('anthropic/claude-sonnet-4');
  });

  test('NVIDIAProvider has correct default model', () => {
    const provider = new NVIDIAProvider('test-key') as any;
    expect(provider.defaultModel).toBe('meta/llama-3.3-70b-instruct');
  });

  test('can override default models', () => {
    const anthropic = new AnthropicProvider('key', 'custom-model') as any;
    const openai = new OpenAIProvider('key', 'custom-model') as any;
    const groq = new GroqProvider('key', 'custom-model') as any;
    const ollama = new OllamaProvider('http://localhost:11434', 'custom-model') as any;
    const openrouter = new OpenRouterProvider('key', 'custom-model') as any;

    expect(anthropic.defaultModel).toBe('custom-model');
    expect(openai.defaultModel).toBe('custom-model');
    expect(groq.defaultModel).toBe('custom-model');
    expect(ollama.defaultModel).toBe('custom-model');
    expect(openrouter.defaultModel).toBe('custom-model');
  });
});

describe('Vision Support', () => {
  describe('guardImageSize', () => {
    test('passes text blocks through unchanged', () => {
      const block: ContentBlock = { type: 'text', text: 'hello' };
      expect(guardImageSize(block)).toBe(block);
    });

    test('passes small images through unchanged', () => {
      const block: ContentBlock = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      };
      expect(guardImageSize(block)).toBe(block);
    });

    test('replaces oversized images with text warning', () => {
      const bigData = 'x'.repeat(6 * 1024 * 1024); // 6 MB
      const block: ContentBlock = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bigData },
      };
      const result = guardImageSize(block);
      expect(result.type).toBe('text');
      expect((result as { type: 'text'; text: string }).text).toContain('too large');
    });
  });

  describe('isToolResult', () => {
    test('returns true for valid ToolResult', () => {
      const tr: ToolResult = {
        content: [{ type: 'text', text: 'hello' }],
      };
      expect(isToolResult(tr)).toBe(true);
    });

    test('returns false for plain string', () => {
      expect(isToolResult('hello')).toBe(false);
    });

    test('returns false for null', () => {
      expect(isToolResult(null)).toBe(false);
    });

    test('returns false for object without content array', () => {
      expect(isToolResult({ content: 'not an array' })).toBe(false);
    });

    test('returns false for object with no content field', () => {
      expect(isToolResult({ data: 'something' })).toBe(false);
    });
  });

  describe('ContentBlock in LLMMessage', () => {
    test('LLMMessage accepts string content', () => {
      const msg: LLMMessage = { role: 'user', content: 'Hello' };
      expect(typeof msg.content).toBe('string');
    });

    test('LLMMessage accepts ContentBlock[] content', () => {
      const msg: LLMMessage = {
        role: 'tool',
        content: [
          { type: 'text', text: 'Screenshot captured' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
        tool_call_id: 'test-id',
      };
      expect(Array.isArray(msg.content)).toBe(true);
      expect((msg.content as ContentBlock[]).length).toBe(2);
    });
  });
});

describe('Tool Call Conversion', () => {
  const toolUseConversation: LLMMessage[] = [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'What time is it?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'get_time', arguments: { timezone: 'UTC' } },
      ],
    },
    {
      role: 'tool',
      content: '2026-03-30T12:00:00Z',
      tool_call_id: 'call_1',
    },
  ];

  test('OpenAIProvider preserves tool_calls on assistant messages', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const assistant = converted[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('get_time');
    expect(assistant.tool_calls[0].function.arguments).toBe('{"timezone":"UTC"}');
  });

  test('OpenAIProvider preserves tool_call_id on tool messages', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const tool = converted[3];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('2026-03-30T12:00:00Z');
  });

  test('GroqProvider preserves tool_calls on assistant messages', () => {
    const provider = new GroqProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const assistant = converted[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('get_time');
    expect(assistant.tool_calls[0].function.arguments).toBe('{"timezone":"UTC"}');
    expect(assistant.content).toBeNull();
  });

  test('GroqProvider preserves tool_call_id on tool messages', () => {
    const provider = new GroqProvider('test-key') as any;
    const converted = provider.convertMessages(toolUseConversation);

    const tool = converted[3];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('2026-03-30T12:00:00Z');
  });

  test('Messages without tool_calls omit the field', () => {
    const provider = new OpenAIProvider('test-key') as any;
    const converted = provider.convertMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
    expect(converted[0].tool_calls).toBeUndefined();
    expect(converted[1].tool_calls).toBeUndefined();
    expect(converted[0].tool_call_id).toBeUndefined();
  });
});

describe('Groq request shaping', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'cmpl_test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'llama-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-test-body': typeof init?.body === 'string' ? init.body : '',
        },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('relaxOptionalFieldsToNullable makes optional fields accept null', () => {
    const schema = {
      type: 'object',
      properties: {
        city: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: {
            required_inner: { type: 'string' },
            optional_inner: { type: 'number' },
          },
          required: ['required_inner'],
        },
      },
      required: ['city'],
    };
    const out = relaxOptionalFieldsToNullable(schema) as any;
    expect(out.properties.city.type).toBe('string');
    expect(out.properties.notes.type).toEqual(['string', 'null']);
    expect(out.properties.tags.type).toEqual(['array', 'null']);
    expect(out.properties.nested.type).toEqual(['object', 'null']);
    expect(out.properties.nested.properties.required_inner.type).toBe('string');
    expect(out.properties.nested.properties.optional_inner.type).toEqual(['number', 'null']);
  });

  test('live catalog filtering excludes non-chat routes', () => {
    expect(isGroqJarvisModel('openai/gpt-oss-20b')).toBe(true);
    expect(isGroqJarvisModel('qwen/qwen3.6-27b')).toBe(true);
    expect(isGroqJarvisModel('minimaxai/minimax-m2.7')).toBe(true);
    expect(isGroqJarvisModel('whisper-large-v3')).toBe(false);
    expect(isGroqJarvisModel('canopylabs/orpheus-v1-english')).toBe(false);
    expect(isGroqJarvisModel('groq/compound')).toBe(false);
    expect(isGroqJarvisModel('groq/compound-mini')).toBe(false);
    expect(isGroqJarvisModel('meta-llama/llama-guard-4-12b')).toBe(false);
    expect(isGroqJarvisModel('openai/gpt-oss-safeguard-20b')).toBe(false);
    expect(isGroqJarvisModel('playai-tts')).toBe(false);
  });

  // Groq answers /models per account: a committed-spend contract keeps
  // serving IDs that are retired on the free and developer tiers. Since boot
  // migration has already rewritten the saved reference, filtering these out
  // of the picker would leave no way back to a model the account still owns.
  test('live catalog keeps deprecated models the account can still reach', () => {
    expect(isGroqJarvisModel('llama-3.3-70b-versatile')).toBe(true);
    expect(isGroqJarvisModel('llama-3.1-8b-instant')).toBe(true);
    expect(isGroqJarvisModel('deepseek-r1-distill-llama-70b')).toBe(true);
  });

  test('GroqProvider relaxes optional tool params to accept null before sending', async () => {
    const provider = new GroqProvider('test-key') as any;
    await provider.chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      {
        tools: [
          {
            name: 'record_profile_facts',
            description: 'd',
            parameters: {
              type: 'object',
              properties: {
                facts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      theme: { type: 'string' },
                      summary: { type: 'string' },
                      raw_quote: { type: 'string' },
                    },
                    required: ['theme', 'summary'],
                  },
                },
              },
              required: ['facts'],
            },
          },
        ],
      },
    );
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const itemProps = body.tools[0].function.parameters.properties.facts.items.properties;
    expect(itemProps.theme.type).toBe('string');
    expect(itemProps.summary.type).toBe('string');
    expect(itemProps.raw_quote.type).toEqual(['string', 'null']);
  });

  test('GroqProvider uses Groq-compatible tool fields', async () => {
    const provider = new GroqProvider('test-key') as any;
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Use the weather tool.' },
    ];

    await provider.chat(messages, {
      max_tokens: 321,
      tools: [
        {
          name: 'weather_lookup',
          description: 'Look up weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      ],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.max_completion_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.tools).toHaveLength(1);
  });

  test('GroqProvider trims oversized history but keeps system and latest turn', async () => {
    const provider = new GroqProvider('test-key') as any;
    const long = 'x'.repeat(12_000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'latest question' },
    ];

    await provider.chat(messages, {
      tools: [
        {
          name: 'delegate_task',
          description: 'Delegate focused work',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const originalSize = JSON.stringify(messages).length;
    const compactedSize = JSON.stringify(body.messages).length;

    expect(body.messages[0].role).toBe('system');
    expect(body.messages.at(-1).content).toBe('latest question');
    expect(compactedSize).toBeLessThan(originalSize);
  });

  test('GroqProvider retries with a tighter payload when Groq rejects an oversized request', async () => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const callCount = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;

      if (callCount === 1) {
        return new Response('message is too large', { status: 413 });
      }

      return new Response(JSON.stringify({
        id: 'cmpl_retry',
        object: 'chat.completion',
        created: Date.now(),
        model: 'llama-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `retry ok ${body.messages.length}` },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const provider = new GroqProvider('test-key');
    const messages: LLMMessage[] = [
      { role: 'system', content: 'S'.repeat(14_000) },
      { role: 'user', content: 'U'.repeat(10_000) },
      { role: 'assistant', content: 'A'.repeat(10_000) },
      { role: 'user', content: 'Can you still answer?' },
    ];

    const response = await provider.chat(messages);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    expect(response.content).toContain('retry ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(secondBody).length).toBeLessThan(JSON.stringify(firstBody).length);
  });

  test('GroqProvider preserves Retry-After on 429 errors', async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      { status: 429, headers: { 'retry-after': '2.5' } },
    )) as unknown as typeof fetch;

    const provider = new GroqProvider('test-key');
    try {
      await provider.chat([{ role: 'user', content: 'hi' }]);
      throw new Error('expected Groq to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMProviderError);
      expect((error as LLMProviderError).code).toBe('rate_limit');
      expect((error as LLMProviderError).retryAfterMs).toBe(2500);
    }
  });

  test('GroqProvider compaction never orphans a tool message from its assistant tool_call', async () => {
    let captured: any = null;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cmpl', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    // Pad the assistant content so the assistant+tool group is large enough
    // that a per-message budget would tempt the compactor to keep one and
    // drop the other if pairing weren't enforced.
    const provider = new GroqProvider('test-key');
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'U'.repeat(20_000) },
      { role: 'user', content: 'U'.repeat(20_000) },
      {
        role: 'assistant',
        content: 'A'.repeat(2_000),
        tool_calls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
      },
      { role: 'tool', tool_call_id: 'tc_1', content: 'T'.repeat(2_000) },
      { role: 'user', content: 'follow up' },
    ];

    await provider.chat(messages);

    const assistants = (captured.messages as Array<{ role: string; tool_calls?: unknown[] }>)
      .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    const tools = (captured.messages as Array<{ role: string; tool_call_id?: string }>)
      .filter((m) => m.role === 'tool');

    // Either both survive together, or neither does — but a tool message
    // must never appear without its originating assistant tool_call.
    if (tools.length > 0) {
      expect(assistants.length).toBeGreaterThan(0);
    }
  });

  test('GroqProvider streams successfully after retrying an oversized request', async () => {
    function makeSseStream(): ReadableStream<Uint8Array> {
      const enc = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({
          id: 'c', object: 'chat.completion.chunk', created: 0, model: 'llama-test',
          choices: [{ index: 0, delta: { content: 'retry-stream ok' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'c', object: 'chat.completion.chunk', created: 0, model: 'llama-test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ];
      return new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
    }

    globalThis.fetch = mock(async () => {
      const callCount = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;
      if (callCount === 1) {
        return new Response('message is too large', { status: 413 });
      }
      return new Response(makeSseStream(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const provider = new GroqProvider('test-key');
    const messages: LLMMessage[] = [
      { role: 'system', content: 'S'.repeat(14_000) },
      { role: 'user', content: 'U'.repeat(10_000) },
      { role: 'user', content: 'Can you still stream?' },
    ];

    const events: string[] = [];
    let sawError = false;
    for await (const ev of provider.stream(messages)) {
      if (ev.type === 'text') events.push(ev.text);
      if (ev.type === 'error') sawError = true;
    }

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    expect(sawError).toBe(false);
    expect(events.join('')).toBe('retry-stream ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(secondBody).length).toBeLessThan(JSON.stringify(firstBody).length);
  });
});

describe('OpenAI request shaping', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'cmpl_test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-5.4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-test-body': typeof init?.body === 'string' ? init.body : '',
        },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('OpenAIProvider sends max_completion_tokens, not max_tokens', async () => {
    const provider = new OpenAIProvider('test-key') as any;
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
    ];

    await provider.chat(messages, { max_tokens: 321 });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.max_completion_tokens).toBe(321);
    expect(body.max_tokens).toBeUndefined();
  });

  test('OpenAIProvider keeps temperature for chat models that support it', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o') as any;
    await provider.chat([{ role: 'user', content: 'hi' }], { temperature: 0.6 });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.temperature).toBe(0.6);
  });

  test('OpenAIProvider omits temperature for reasoning models that only accept the default', async () => {
    const provider = new OpenAIProvider('test-key', 'o3-mini') as any;
    await provider.chat([{ role: 'user', content: 'hi' }], { temperature: 0.6 });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.temperature).toBeUndefined();
  });
});

describe('modelRejectsCustomTemperature', () => {
  test('rejects o-series and gpt-5 reasoning models', () => {
    for (const m of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'o3-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano']) {
      expect(modelRejectsCustomTemperature(m)).toBe(true);
    }
  });

  test('allows chat models including gpt-5-chat', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-5-chat-latest']) {
      expect(modelRejectsCustomTemperature(m)).toBe(false);
    }
  });
});

describe('classifyHttpStatus', () => {
  test('401 → auth', () => {
    expect(classifyHttpStatus(401)).toBe('auth');
  });

  test('403 → forbidden, not auth — a working key without model access', () => {
    expect(classifyHttpStatus(403)).toBe('forbidden');
  });

  test('429 → rate_limit', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limit');
  });

  test('404 → not_found', () => {
    expect(classifyHttpStatus(404)).toBe('not_found');
  });

  test('400/422 → bad_request', () => {
    expect(classifyHttpStatus(400)).toBe('bad_request');
    expect(classifyHttpStatus(422)).toBe('bad_request');
  });

  test('502/503/504 → network (transient)', () => {
    expect(classifyHttpStatus(502)).toBe('network');
    expect(classifyHttpStatus(503)).toBe('network');
    expect(classifyHttpStatus(504)).toBe('network');
  });

  test('non-standard 498 (gateway upstream expiry) → network (transient)', () => {
    expect(classifyHttpStatus(498)).toBe('network');
  });

  test('other 5xx → server', () => {
    expect(classifyHttpStatus(500)).toBe('server');
    expect(classifyHttpStatus(501)).toBe('server');
  });

  test('200 and unknowns → unknown', () => {
    expect(classifyHttpStatus(200)).toBe('unknown');
    expect(classifyHttpStatus(418)).toBe('unknown');
  });
});

describe('classifyErrorString', () => {
  test('auth via 401 / unauthorized / api key', () => {
    expect(classifyErrorString('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyErrorString('invalid x-api-key')).toBe('auth');
    expect(classifyErrorString('Incorrect API key provided')).toBe('auth');
  });

  test('forbidden via 403 / permission markers', () => {
    expect(classifyErrorString('HTTP 403 Forbidden')).toBe('forbidden');
    expect(classifyErrorString('permission_error: not allowed to use this model')).toBe('forbidden');
    expect(classifyErrorString('You do not have access to model gpt-5')).toBe('forbidden');
  });

  test('403 wins over the auth keywords it ships with', () => {
    // Providers word 403s with auth-adjacent language; the status decides.
    expect(classifyErrorString('403: authentication succeeded but access is denied')).toBe('forbidden');
  });

  test('a stated 401 keeps permission wording in the auth bucket', () => {
    expect(classifyErrorString('401 Unauthorized: you do not have access')).toBe('auth');
  });

  test('permission wording alone, with no status, is forbidden', () => {
    expect(classifyErrorString('permission denied for this model')).toBe('forbidden');
    // Both wordings providers use for a model the caller can't reach.
    expect(classifyErrorString('You do not have access to model gpt-5')).toBe('forbidden');
    expect(classifyErrorString('Project `proj_a` does not have access to model `o3`')).toBe('forbidden');
    // Google's canonical status uses an underscore, not a space.
    expect(classifyErrorString('PERMISSION_DENIED: the API is not enabled')).toBe('forbidden');
  });

  test('word-boundary: 4030 does not collide with 403', () => {
    expect(classifyErrorString('prompt has 4030 tokens')).not.toBe('forbidden');
  });

  test('rate_limit via 429 / quota / rate limit', () => {
    expect(classifyErrorString('OpenAI API error (429): rate_limit_exceeded')).toBe('rate_limit');
    expect(classifyErrorString('You exceeded your current quota')).toBe('rate_limit');
    expect(classifyErrorString('Too Many Requests')).toBe('rate_limit');
  });

  test('network via 503 / timeout / econnrefused', () => {
    expect(classifyErrorString('Service temporarily unavailable (503)')).toBe('network');
    expect(classifyErrorString('fetch failed: ECONNREFUSED')).toBe('network');
    expect(classifyErrorString('Request timeout')).toBe('network');
  });

  test('word-boundary: 4295 does not collide with 429', () => {
    expect(classifyErrorString('prompt has 4295 tokens')).not.toBe('rate_limit');
  });

  test('word-boundary: 14018 does not collide with 401', () => {
    expect(classifyErrorString('context at 14018 tokens')).not.toBe('auth');
  });

  test('unknown when nothing matches', () => {
    expect(classifyErrorString('something unexpected happened')).toBe('unknown');
    expect(classifyErrorString(undefined)).toBe('unknown');
    expect(classifyErrorString('')).toBe('unknown');
  });
});
