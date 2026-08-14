import { afterEach, describe, expect, it } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { mergeLLMSettingsIntoConfig, saveLLMSettings } from './llm-settings.ts';

afterEach(() => closeDb());

describe('LLM provider deletion', () => {
  it('clears every model ref the deleted provider owned', () => {
    initDatabase(':memory:');
    const config: JarvisConfig = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = {
      'test-anthropic': { kind: 'anthropic' },
      'test-omniroute': { kind: 'omniroute', base_url: 'http://router.test/v1' },
    };
    config.llm.default = 'test-anthropic:claude-sonnet';
    config.llm.tiers = {
      conversation: 'test-anthropic:claude-haiku',
      high: 'test-omniroute:auto',
      medium: 'test-anthropic:claude-sonnet',
    };

    saveLLMSettings(config, { providers: { 'test-anthropic': null } });

    expect(config.llm.default).toBeUndefined();
    expect(config.llm.tiers).toEqual({ high: 'test-omniroute:auto' });
    // The settings table is the authority on cold start - the dead refs must
    // be gone from there too, not just from the in-memory config.
    expect(getSetting('llm.default')).toBe('');
    expect(getSetting('llm.tiers.conversation')).toBe('');
    expect(getSetting('llm.tiers.medium')).toBe('');
    expect(getSetting('llm.tiers.high')).toBe('test-omniroute:auto');
  });

  it('leaves refs owned by other providers untouched', () => {
    initDatabase(':memory:');
    const config: JarvisConfig = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = {
      'test-anthropic': { kind: 'anthropic' },
      'test-groq': { kind: 'groq' },
    };
    config.llm.default = 'test-groq:openai/gpt-oss-120b';
    config.llm.tiers = { medium: 'test-groq:openai/gpt-oss-20b' };

    saveLLMSettings(config, { providers: { 'test-anthropic': null } });

    expect(config.llm.default).toBe('test-groq:openai/gpt-oss-120b');
    expect(config.llm.tiers).toEqual({ medium: 'test-groq:openai/gpt-oss-20b' });
  });
});

describe('LLM settings model migrations', () => {
  it('replaces saved decommissioned Groq IDs and persists the repair', () => {
    initDatabase(':memory:');
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
    initDatabase(':memory:');
    setSetting('llm.providers', JSON.stringify({ groq: { kind: 'groq' } }));
    setSetting('llm.default', 'groq:deepseek-r1-distill-llama-70b');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config, { persistMigrations: false });

    expect(config.llm.default).toBe('groq:openai/gpt-oss-120b');
    expect(getSetting('llm.default')).toBe('groq:deepseek-r1-distill-llama-70b');
  });
});
