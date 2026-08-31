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

  // The ws derivation is a prefix rewrite, so a case-SENSITIVE one turns
  // HTTPS://… into HTTPS://…/realtime — never dialable, and the failure reads
  // as "realtime is broken" rather than "the scheme is wrong".
  test('an uppercase scheme in the provisioned block still yields a ws(s) URL', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'HTTPS://LLM.Usejarvis.Host', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true, model: 'gpt-realtime-2' };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.url.startsWith('wss://')).toBe(true);
    expect(res.resolved.modelsUrl!.startsWith('https://')).toBe(true);
  });

  // Provisioner typo classes the URL-based normalization must absorb: a
  // scheme-less host previously left `replace(/^http/,'ws')` a no-op (the
  // "URL" wasn't dialable at all), and an uppercase /V1 failed the
  // case-sensitive suffix test, doubling into /V1/v1/realtime.
  test('a scheme-less base_url reads as https and derives wss://', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'llm.usejarvis.host', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.url).toBe('wss://llm.usejarvis.host/v1/realtime');
      expect(res.resolved.modelsUrl).toBe('https://llm.usejarvis.host/v1/models');
    }
  });

  test('an uppercase /V1 suffix is recognized, not doubled', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host/V1', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.url).toBe('wss://llm.usejarvis.host/V1/realtime');
      expect(res.resolved.modelsUrl).toBe('https://llm.usejarvis.host/V1/models');
    }
  });

  test('trailing slashes are stripped before the /v1 suffix check', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host/v1///', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.url).toBe('wss://llm.usejarvis.host/v1/realtime');
  });

  test('an unparseable or non-http base_url refuses instead of dialing garbage', () => {
    const bad = makeConfig();
    bad.usejarvis_ai = { base_url: 'ftp://llm.usejarvis.host', api_key: 'sk-uj-abc' };
    bad.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('scheme');
  });

  test('hosted fallback: no BYO key + usejarvis_ai block resolves the proxy session', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true, model: 'gpt-realtime-2', monthly_budget_usd: 25 };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.provider).toBe('usejarvis_ai');
      expect(res.resolved.url).toBe('wss://llm.usejarvis.host/v1/realtime');
      expect(res.resolved.modelsUrl).toBe('https://llm.usejarvis.host/v1/models');
      // The alias is fixed regardless of the configured model — the proxy
      // resolves the actual model per plan.
      expect(res.resolved.model).toBe('uj-realtime');
      // The LOCAL estimate guard must not double-block hosted sessions.
      expect(res.resolved.monthlyBudgetUsd).toBeUndefined();
    }
  });

  test('hosted block with realtime disabled stays off; partial block falls to no-key', () => {
    const disabled = makeConfig();
    disabled.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' };
    disabled.voice!.realtime = { enabled: false };
    expect(resolveRealtimeVoice(disabled).ok).toBe(false);

    const partial = makeConfig();
    partial.usejarvis_ai = { base_url: 'https://llm.usejarvis.host' }; // no key
    partial.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(partial);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('no OpenAI key');
  });

  test('http dev proxy derives ws:// (not wss://)', () => {
    const config = makeConfig();
    config.usejarvis_ai = { base_url: 'http://dev-llm.usejarvis.dev:4000', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.url).toBe('ws://dev-llm.usejarvis.dev:4000/v1/realtime');
      expect(res.resolved.modelsUrl).toBe('http://dev-llm.usejarvis.dev:4000/v1/models');
    }
  });

  test('on a HOSTED install the plan serves realtime, not the user\'s own key', () => {
    // This precedence was deliberately inverted. It used to be "the user's own
    // key wins", which was safe only while realtime needed an opt-in almost
    // nobody had. Now that hosted tenants get it by default, that rule billed
    // a personal OpenAI account at ~$0.30/min — ungated, since a BYO session
    // carries no modelsUrl and the plan gate skips it, and unbudgeted — for
    // someone who had merely toggled the feature on.
    const config = withOpenAIProvider(makeConfig(), 'sk-user-own');
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' };
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.provider).toBe('usejarvis_ai');
      expect(res.resolved.apiKey).not.toBe('sk-user-own');
      expect(res.resolved.modelsUrl).toBeTruthy(); // so the plan gate applies
    }
  });

  test("a SELF-HOSTED install still uses the user's own OpenAI key", () => {
    // Nothing else can serve it there, and it is their explicit choice.
    const config = withOpenAIProvider(makeConfig(), 'sk-user-own');
    config.voice!.realtime = { enabled: true };
    const res = resolveRealtimeVoice(config);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.provider).toBe('openai');
      expect(res.resolved.apiKey).toBe('sk-user-own');
      expect(res.resolved.url).toBe('wss://api.openai.com/v1/realtime');
    }
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
