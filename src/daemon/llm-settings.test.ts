import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { getLLMSettings, mergeLLMSettingsIntoConfig, saveLLMSettings } from './llm-settings.ts';

function configWithProviders(): JarvisConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.llm.providers = {
    'test-anthropic': { kind: 'anthropic' },
    'test-omniroute': { kind: 'omniroute', base_url: 'http://router.test/v1' },
  };
  config.llm.tiers = {};
  return config;
}

describe('LLM default provider settings', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  it('persists and reloads the provider separately from its model', () => {
    const config = configWithProviders();
    saveLLMSettings(config, { default_provider: 'test-omniroute' });

    expect(config.llm.default_provider).toBe('test-omniroute');
    expect(config.llm.default).toBeUndefined();
    expect(getSetting('llm.default_provider')).toBe('test-omniroute');
    expect(getLLMSettings(config).default_provider).toBe('test-omniroute');

    const reloaded = structuredClone(DEFAULT_CONFIG);
    mergeLLMSettingsIntoConfig(reloaded);
    expect(reloaded.llm.default_provider).toBe('test-omniroute');
  });

  it('clears a stale model override when switching providers', () => {
    const config = configWithProviders();
    config.llm.default = 'test-anthropic:claude-sonnet';

    saveLLMSettings(config, { default_provider: 'test-omniroute' });

    expect(config.llm.default_provider).toBe('test-omniroute');
    expect(config.llm.default).toBeUndefined();
    expect(getSetting('llm.default')).toBe('');
  });

  it('keeps model selection and provider selection synchronized', () => {
    const config = configWithProviders();
    saveLLMSettings(config, { default: 'test-anthropic:claude-sonnet' });

    expect(config.llm.default_provider).toBe('test-anthropic');
    expect(config.llm.default).toBe('test-anthropic:claude-sonnet');
  });

  it('rejects a provider that is not configured', () => {
    const config = configWithProviders();
    expect(() => saveLLMSettings(config, { default_provider: 'missing' }))
      .toThrow("Default provider 'missing' is not configured");
  });

  it('does not derive a provider from a model ref with an empty model id', () => {
    const config = configWithProviders();
    config.llm.default = 'test-anthropic:';

    expect(getLLMSettings(config).default_provider).toBeNull();
  });

  it('clears every model assignment owned by a deleted provider', () => {
    const config = configWithProviders();
    config.llm.default_provider = 'test-anthropic';
    config.llm.default = 'test-anthropic:claude-sonnet';
    config.llm.tiers = {
      conversation: 'test-anthropic:claude-haiku',
      high: 'test-omniroute:auto',
      medium: 'test-anthropic:claude-sonnet',
    };

    saveLLMSettings(config, { providers: { 'test-anthropic': null } });

    expect(config.llm.default_provider).toBeUndefined();
    expect(config.llm.default).toBeUndefined();
    expect(config.llm.tiers).toEqual({ high: 'test-omniroute:auto' });
    expect(getSetting('llm.tiers.conversation')).toBe('');
    expect(getSetting('llm.tiers.medium')).toBe('');
  });
});

describe('LLM settings model migrations', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  it('replaces saved decommissioned Groq IDs and persists the repair', () => {
    setSetting('llm.providers', JSON.stringify({ groq: { kind: 'groq' } }));
    setSetting('llm.default', 'groq:deepseek-r1-distill-llama-70b');
    setSetting('llm.tiers.medium', 'groq:llama-3.1-8b-instant');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config);

    expect(config.llm.default).toBe('groq:openai/gpt-oss-120b');
    expect(config.llm.tiers?.medium).toBe('groq:openai/gpt-oss-20b');
    expect(getSetting('llm.default')).toBe('groq:openai/gpt-oss-120b');
    expect(getSetting('llm.tiers.medium')).toBe('groq:openai/gpt-oss-20b');
  });

  it('can hydrate repaired references without mutating settings', () => {
    setSetting('llm.providers', JSON.stringify({ groq: { kind: 'groq' } }));
    setSetting('llm.default', 'groq:deepseek-r1-distill-llama-70b');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config, { persistMigrations: false });

    expect(config.llm.default).toBe('groq:openai/gpt-oss-120b');
    expect(getSetting('llm.default')).toBe('groq:deepseek-r1-distill-llama-70b');
  });
});
