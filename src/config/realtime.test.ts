import { test, expect, describe } from 'bun:test';
import { resolveRealtimeVoice, DEFAULT_BLOCKED_CATEGORIES } from './realtime.ts';
import { DEFAULT_CONFIG } from './types.ts';
import type { JarvisConfig } from './types.ts';

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}

function withOpenAIProvider(config: JarvisConfig, key: string): JarvisConfig {
  config.llm.providers = { ...(config.llm.providers ?? {}), openai: { api_key: key } };
  return config;
}

describe('resolveRealtimeVoice', () => {
  test('disabled by default', () => {
    const res = resolveRealtimeVoice(makeConfig());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('disabled');
  });

  test('enabled but no key resolves -> not ok, never throws', () => {
    const config = makeConfig();
    config.voice!.realtime!.enabled = true;
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no OpenAI key');
  });

  test('uses the OpenAI provider key from llm.providers', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    withOpenAIProvider(config, 'provider-key');
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.apiKey).toBe('provider-key');
  });

  test('matches a custom-named provider whose kind is openai', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    config.llm.providers = { 'openai-personal': { kind: 'openai', api_key: 'custom' } };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.apiKey).toBe('custom');
  });

  test('skips non-openai providers', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    config.llm.providers = {
      anthropic: { api_key: 'sk-ant' },
      groq: { kind: 'groq', api_key: 'gsk' },
    };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(false);
  });

  test('does not fall back to env vars - key must come from a configured provider', () => {
    // LLM credentials live only in the DB + keychain (surfaced on
    // config.llm.providers at runtime). There is no config.yaml or env fallback.
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    const prevJarvis = process.env.JARVIS_OPENAI_KEY;
    const prevOpenAI = process.env.OPENAI_API_KEY;
    process.env.JARVIS_OPENAI_KEY = 'env-key';
    process.env.OPENAI_API_KEY = 'env-key';
    try {
      const res = resolveRealtimeVoice(config);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain('no OpenAI key');
    } finally {
      if (prevJarvis === undefined) delete process.env.JARVIS_OPENAI_KEY; else process.env.JARVIS_OPENAI_KEY = prevJarvis;
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAI;
    }
  });

  test('applies defaults for model / effort / session cap', () => {
    const config = withOpenAIProvider(makeConfig(), 'k');
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.model).toBe('gpt-realtime-2');
      expect(res.resolved.reasoningEffort).toBe('low');
      expect(res.resolved.maxSessionMinutes).toBe(10);
      // Safe-by-default: destructive categories blocked when unconfigured.
      expect(res.resolved.blockedCategories).toEqual(DEFAULT_BLOCKED_CATEGORIES);
      expect(res.resolved.blockedCategories).toContain('make_payment');
      expect(res.resolved.blockedCategories).toContain('delete_data');
      expect(res.resolved.blockedCategories).toContain('execute_command');
    }
  });

  test('an explicit blocked_categories array (even empty) overrides the default', () => {
    const config = withOpenAIProvider(makeConfig(), 'k');
    config.voice!.realtime = { enabled: true, blocked_categories: [] };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.blockedCategories).toEqual([]);
  });

  test('honors user-selected reasoning effort and rejects invalid', () => {
    const valid = withOpenAIProvider(makeConfig(), 'k');
    valid.voice!.realtime = { enabled: true, reasoning_effort: 'xhigh' };
    const r1 = resolveRealtimeVoice(valid);
    expect(r1.ok && r1.resolved.reasoningEffort).toBe('xhigh');

    const invalid = withOpenAIProvider(makeConfig(), 'k');
    // @ts-expect-error testing invalid runtime value
    invalid.voice!.realtime = { enabled: true, reasoning_effort: 'bogus' };
    const r2 = resolveRealtimeVoice(invalid);
    expect(r2.ok && r2.resolved.reasoningEffort).toBe('low');
  });

  test('passes through blocked_categories and budget', () => {
    const config = withOpenAIProvider(makeConfig(), 'k');
    config.voice!.realtime = {
      enabled: true,
      blocked_categories: ['file_delete', 'shell'],
      monthly_budget_usd: 25,
    };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.blockedCategories).toEqual(['file_delete', 'shell']);
      expect(res.resolved.monthlyBudgetUsd).toBe(25);
    }
  });
});
