import { describe, expect, it } from 'bun:test';
import type { LLMConfig } from '../config/types.ts';
import { configureLLMTiers } from './config-binding.ts';
import { LLMManager } from './manager.ts';
import type { LLMProvider } from './provider.ts';

function fakeProvider(name: string): LLMProvider {
  return {
    name,
    async chat() {
      return {
        content: name,
        tool_calls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'provider-default',
        finish_reason: 'stop',
      };
    },
    async *stream() {},
    async listModels() { return []; },
  };
}

describe('configureLLMTiers default provider', () => {
  it('sets the actual manager primary and routes single-mode calls through it', async () => {
    const manager = new LLMManager();
    manager.registerProvider(fakeProvider('anthropic'));
    manager.registerProvider(fakeProvider('omniroute'));

    configureLLMTiers(manager, {
      default_provider: 'omniroute',
      tiers: {},
    } satisfies LLMConfig);

    expect(manager.getPrimary()).toBe('omniroute');
    expect(manager.getTierMap()).toEqual({
      low: { provider: 'omniroute' },
      medium: { provider: 'omniroute' },
      high: { provider: 'omniroute' },
    });
    const response = await manager.chat([{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('omniroute');
  });

  it('does not carry another provider model across a provider switch', () => {
    const manager = new LLMManager();
    manager.registerProvider(fakeProvider('anthropic'));
    manager.registerProvider(fakeProvider('omniroute'));

    configureLLMTiers(manager, {
      default_provider: 'omniroute',
      default: 'anthropic:claude-sonnet',
      tiers: {},
    } satisfies LLMConfig);

    expect(manager.getTierMap().medium).toEqual({ provider: 'omniroute' });
  });

  it('keeps old model-only configs backward compatible', () => {
    const manager = new LLMManager();
    manager.registerProvider(fakeProvider('omniroute'));
    manager.registerProvider(fakeProvider('anthropic'));

    configureLLMTiers(manager, {
      default: 'anthropic:claude-sonnet',
      tiers: {},
    } satisfies LLMConfig);

    expect(manager.getPrimary()).toBe('anthropic');
    expect(manager.getTierMap().medium).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
  });

  it('still lets explicit tier routes override the provider default', () => {
    const manager = new LLMManager();
    manager.registerProvider(fakeProvider('omniroute'));
    manager.registerProvider(fakeProvider('groq'));

    configureLLMTiers(manager, {
      default_provider: 'omniroute',
      tiers: { conversation: 'groq:llama', medium: 'groq:llama' },
    } satisfies LLMConfig);

    expect(manager.getPrimary()).toBe('omniroute');
    expect(manager.getTierMap().conversation).toEqual({ provider: 'groq', model: 'llama' });
    expect(manager.getTierMap().medium).toEqual({ provider: 'groq', model: 'llama' });
    expect(manager.getTierMap().low).toEqual({ provider: 'omniroute' });
  });
});
