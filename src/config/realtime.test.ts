import { test, expect, describe } from 'bun:test';
import { resolveRealtimeVoice, DEFAULT_BLOCKED_CATEGORIES } from './realtime.ts';
import { DEFAULT_CONFIG } from './types.ts';
import type { JarvisConfig } from './types.ts';

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
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
    if (!res.ok) expect(res.reason).toContain('no OpenAI API key');
  });

  test('uses explicit realtime api_key first', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true, api_key: 'rt-key' };
    config.llm.openai = { api_key: 'llm-key' };
    const res = resolveRealtimeVoice(config, { JARVIS_OPENAI_KEY: 'env-key' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.apiKey).toBe('rt-key');
  });

  test('falls back to llm.openai key then env', () => {
    const c1 = makeConfig();
    c1.voice!.realtime = { enabled: true };
    c1.llm.openai = { api_key: 'llm-key' };
    const r1 = resolveRealtimeVoice(c1, { JARVIS_OPENAI_KEY: 'env-key' });
    expect(r1.ok && r1.resolved.apiKey).toBe('llm-key');

    const c2 = makeConfig();
    c2.voice!.realtime = { enabled: true };
    c2.llm.openai = undefined;
    const r2 = resolveRealtimeVoice(c2, { OPENAI_API_KEY: 'env-key' });
    expect(r2.ok && r2.resolved.apiKey).toBe('env-key');
  });

  test('applies defaults for model / effort / session cap', () => {
    const config = makeConfig();
    config.voice!.realtime = { enabled: true, api_key: 'k' };
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
    const config = makeConfig();
    config.voice!.realtime = { enabled: true, api_key: 'k', blocked_categories: [] };
    const res = resolveRealtimeVoice(config, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.blockedCategories).toEqual([]);
  });

  test('honors user-selected reasoning effort and rejects invalid', () => {
    const valid = makeConfig();
    valid.voice!.realtime = { enabled: true, api_key: 'k', reasoning_effort: 'xhigh' };
    const r1 = resolveRealtimeVoice(valid, {});
    expect(r1.ok && r1.resolved.reasoningEffort).toBe('xhigh');

    const invalid = makeConfig();
    // @ts-expect-error testing invalid runtime value
    invalid.voice!.realtime = { enabled: true, api_key: 'k', reasoning_effort: 'bogus' };
    const r2 = resolveRealtimeVoice(invalid, {});
    expect(r2.ok && r2.resolved.reasoningEffort).toBe('low');
  });

  test('passes through blocked_categories and budget', () => {
    const config = makeConfig();
    config.voice!.realtime = {
      enabled: true,
      api_key: 'k',
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
