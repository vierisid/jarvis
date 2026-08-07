import { afterEach, describe, expect, it } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { mergeLLMSettingsIntoConfig } from './llm-settings.ts';

afterEach(() => closeDb());

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
