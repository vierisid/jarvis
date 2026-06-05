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
    const res = resolveRealtimeVoice(makeConfig(), {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('disabled');
  });

  test('enabled but no key resolves -> not ok, never throws', () => {
    const config = makeConfig();
    config.voice!.realtime!.enabled = true;
    const res = resolveRealtimeVoice(config, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no OpenAI key');
  });

  test('uses the OpenAI provider key from llm.providers', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    withOpenAIProvider(config, 'provider-key');
    const res = resolveRealtimeVoice(config, { JARVIS_OPENAI_KEY: 'env-key' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.apiKey).toBe('provider-key');
  });

  test('matches a custom-named provider whose kind is openai', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true };
    config.llm.providers = { 'openai-personal': { kind: 'openai', api_key: 'custom' } };
    const res = resolveRealtimeVoice(config, {});
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
    const res = resolveRealtimeVoice(config, {});
    expect(res.ok).toBe(false);
  });

  test('falls back to legacy llm.openai then env', () => {
    const c1 = makeConfig();
    c1.voice!.realtime = { enabled: true };
    c1.llm.openai = { api_key: 'legacy-key' };
    const r1 = resolveRealtimeVoice(c1, { JARVIS_OPENAI_KEY: 'env-key' });
    expect(r1.ok && r1.resolved.apiKey).toBe('legacy-key');

    const c2 = makeConfig();
    c2.voice!.realtime = { enabled: true };
    c2.llm.openai = undefined;
    const r2 = resolveRealtimeVoice(c2, { OPENAI_API_KEY: 'env-key' });
    expect(r2.ok && r2.resolved.apiKey).toBe('env-key');
  });

  test('applies defaults for model / effort / session cap', () => {
    const config = withOpenAIProvider(makeConfig(), 'k');
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config, {});
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
    const res = resolveRealtimeVoice(config, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.blockedCategories).toEqual([]);
  });

  test('honors user-selected reasoning effort and rejects invalid', () => {
    const valid = withOpenAIProvider(makeConfig(), 'k');
    valid.voice!.realtime = { enabled: true, reasoning_effort: 'xhigh' };
    const r1 = resolveRealtimeVoice(valid, {});
    expect(r1.ok && r1.resolved.reasoningEffort).toBe('xhigh');

    const invalid = withOpenAIProvider(makeConfig(), 'k');
    // @ts-expect-error testing invalid runtime value
    invalid.voice!.realtime = { enabled: true, reasoning_effort: 'bogus' };
    const r2 = resolveRealtimeVoice(invalid, {});
    expect(r2.ok && r2.resolved.reasoningEffort).toBe('low');
  });

  test('passes through blocked_categories and budget', () => {
    const config = withOpenAIProvider(makeConfig(), 'k');
    config.voice!.realtime = {
      enabled: true,
      blocked_categories: ['file_delete', 'shell'],
      monthly_budget_usd: 25,
    };
    const res = resolveRealtimeVoice(config, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.blockedCategories).toEqual(['file_delete', 'shell']);
      expect(res.resolved.monthlyBudgetUsd).toBe(25);
    }
  });
});
