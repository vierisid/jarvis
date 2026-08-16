import { afterEach, describe, expect, it } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { mergeLLMSettingsIntoConfig, saveLLMSettings } from './llm-settings.ts';

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

/**
 * `auth_header` is the one part of a provider credential that is NOT a secret,
 * so it rides in the config rather than the keychain. These pin the boundary
 * rules: a legal name persists, a blank clears, and an illegal one is refused
 * before it can reach fetch.
 */
describe('LLM settings auth header', () => {
  const withDb = (fn: () => void) => { initDatabase(':memory:'); fn(); };

  it('persists a valid header name and exposes it back', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    saveLLMSettings(config, {
      providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: 'x-api-key' } },
    });

    expect(config.llm.providers?.['gw']?.auth_header).toBe('x-api-key');
    const stored = JSON.parse(getSetting('llm.providers') ?? '{}') as Record<string, { auth_header?: string }>;
    expect(stored['gw']?.auth_header).toBe('x-api-key');
  }));

  it('trims surrounding whitespace', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    saveLLMSettings(config, {
      providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: '  x-api-key  ' } },
    });

    expect(config.llm.providers?.['gw']?.auth_header).toBe('x-api-key');
  }));

  it('clears the field on a blank value so the provider default applies', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    saveLLMSettings(config, {
      providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: 'x-api-key' } },
    });
    saveLLMSettings(config, { providers: { gw: { auth_header: '' } } });

    expect(config.llm.providers?.['gw']?.auth_header).toBeUndefined();
  }));

  it('leaves the stored header alone when the update omits it', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    saveLLMSettings(config, {
      providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: 'x-api-key' } },
    });
    saveLLMSettings(config, { providers: { gw: { base_url: 'http://gw.local/v1' } } });

    expect(config.llm.providers?.['gw']?.auth_header).toBe('x-api-key');
  }));

  it('refuses a header name containing CRLF', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(() => saveLLMSettings(config, {
      providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: 'X-Bad\r\nX-Evil: 1' } },
    })).toThrow(/invalid auth header name/);
    expect(config.llm.providers?.['gw']).toBeUndefined();
  }));

  it('refuses a header name with spaces or a colon', () => withDb(() => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const bad of ['has space', 'has:colon']) {
      expect(() => saveLLMSettings(config, {
        providers: { gw: { kind: 'litellm', base_url: 'http://gw.local/v1', auth_header: bad } },
      })).toThrow(/invalid auth header name/);
    }
  }));
});
