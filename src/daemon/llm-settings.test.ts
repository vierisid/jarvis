import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { getLLMSettings, mergeLLMSettingsIntoConfig, saveLLMSettings } from './llm-settings.ts';
import {
  applyUsejarvisAi,
  clearHostedCatalogForTest,
  noteHostedCatalog,
  USEJARVIS_PROVIDER_NAME,
} from './usejarvis-ai.ts';

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

  it('does not resurrect the deleted routes on the next cold start', () => {
    initDatabase(':memory:');
    const config: JarvisConfig = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = {
      'test-anthropic': { kind: 'anthropic' },
      'test-groq': { kind: 'groq' },
    };
    config.llm.tiers = {
      conversation: 'test-anthropic:claude-haiku',
      medium: 'test-groq:openai/gpt-oss-20b',
    };

    saveLLMSettings(config, { providers: { 'test-anthropic': null } });

    const restarted = structuredClone(DEFAULT_CONFIG);
    mergeLLMSettingsIntoConfig(restarted);

    expect(restarted.llm.tiers).toEqual({ medium: 'test-groq:openai/gpt-oss-20b' });
  });
});

describe('LLM orphaned model refs', () => {
  it('repairs an install dirtied before deletion cleaned up after itself', () => {
    initDatabase(':memory:');
    setSetting('llm.providers', JSON.stringify({ 'test-groq': { kind: 'groq' } }));
    setSetting('llm.default', 'test-anthropic:claude-sonnet');
    setSetting('llm.tiers.conversation', 'test-anthropic:claude-haiku');
    setSetting('llm.tiers.medium', 'test-groq:openai/gpt-oss-20b');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config);

    expect(config.llm.default).toBeUndefined();
    expect(config.llm.tiers).toEqual({ medium: 'test-groq:openai/gpt-oss-20b' });
    expect(getSetting('llm.default')).toBe('');
    expect(getSetting('llm.tiers.conversation')).toBe('');
    expect(getSetting('llm.tiers.medium')).toBe('test-groq:openai/gpt-oss-20b');
  });

  it('can repair in memory without persisting', () => {
    initDatabase(':memory:');
    setSetting('llm.providers', JSON.stringify({ 'test-groq': { kind: 'groq' } }));
    setSetting('llm.default', 'test-anthropic:claude-sonnet');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config, { persistMigrations: false });

    expect(config.llm.default).toBeUndefined();
    expect(getSetting('llm.default')).toBe('test-anthropic:claude-sonnet');
  });

  it('keeps refs to a configured provider that has no usable credentials', () => {
    initDatabase(':memory:');
    // Present in the providers map but not instantiable without a key. The
    // user may still be about to paste one - the ref must survive.
    setSetting('llm.providers', JSON.stringify({ 'test-anthropic': { kind: 'anthropic' } }));
    setSetting('llm.default', 'test-anthropic:claude-sonnet');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config);

    expect(config.llm.default).toBe('test-anthropic:claude-sonnet');
    expect(getSetting('llm.default')).toBe('test-anthropic:claude-sonnet');
  });

  it('leaves everything alone when the providers row is corrupt', () => {
    initDatabase(':memory:');
    setSetting('llm.providers', '{not json');
    setSetting('llm.default', 'test-groq:openai/gpt-oss-120b');
    setSetting('llm.tiers.medium', 'test-groq:openai/gpt-oss-20b');
    const config = structuredClone(DEFAULT_CONFIG);

    mergeLLMSettingsIntoConfig(config);

    // One bad row must not be read as "no providers exist" and wipe the routes.
    expect(getSetting('llm.default')).toBe('test-groq:openai/gpt-oss-120b');
    expect(getSetting('llm.tiers.medium')).toBe('test-groq:openai/gpt-oss-20b');
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

function hostedConfig(): JarvisConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-LIFETIMEKEY0000000000' };
  applyUsejarvisAi(config); // what boot / every merge does
  return config;
}

describe('saveLLMSettings: hosted model refs pass the server-side allowlist (W8)', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); clearHostedCatalogForTest(); });
  afterEach(() => { closeDb(); clearHostedCatalogForTest(); });

  test('static rule (no catalog seen): non-chat aliases and raw upstream ids are refused, chat aliases save', () => {
    const config = hostedConfig();
    for (const model of ['uj-stt', 'uj-tts-hd', 'uj-realtime', 'gpt-5.5']) {
      expect(() => saveLLMSettings(config, { tiers: { high: `usejarvis_ai:${model}` } }))
        .toThrow(/not (in your plan|a chat alias)/);
    }
    expect(() => saveLLMSettings(config, { default: 'usejarvis_ai:gpt-5.5' })).toThrow();
    saveLLMSettings(config, { tiers: { high: 'usejarvis_ai:uj-high' } });
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:uj-high');
  });

  test('a live catalog narrows the allowlist to exactly the plan; a degraded one never does', () => {
    const config = hostedConfig();
    noteHostedCatalog(['uj-chat', 'uj-pro'], false);
    saveLLMSettings(config, { tiers: { high: 'usejarvis_ai:uj-pro' } });
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:uj-pro');
    // uj-high passes the static rule but is not in THIS plan's catalog:
    expect(() => saveLLMSettings(config, { tiers: { medium: 'usejarvis_ai:uj-high' } }))
      .toThrow(/not in your plan/);
    // Degraded fetches must not shrink the allowlist to the fallback four:
    clearHostedCatalogForTest();
    noteHostedCatalog(['uj-chat'], true);
    saveLLMSettings(config, { tiers: { medium: 'usejarvis_ai:uj-high' } });
    expect(getSetting('llm.tiers.medium')).toBe('usejarvis_ai:uj-high');
  });

  test('a rejected ref mutates nothing (validate-before-mutate)', () => {
    const config = hostedConfig();
    saveLLMSettings(config, { tiers: { high: 'usejarvis_ai:uj-high' } });
    expect(() => saveLLMSettings(config, {
      tiers: { high: 'usejarvis_ai:uj-stt' },
      default: 'anthropic:claude-x',
    })).toThrow();
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:uj-high');
    expect(config.llm.default).toBeUndefined();
    expect(getSetting('llm.default') ?? '').toBe('');
  });

  test('self-hosted installs have no gate: a legacy provider named usejarvis_ai keeps free refs', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = { usejarvis_ai: { kind: 'openai_compatible', base_url: 'https://my.gw/v1' } };
    saveLLMSettings(config, { tiers: { high: 'usejarvis_ai:gpt-5.5' } });
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:gpt-5.5');
  });
});

describe('saveLLMSettings: the hosted provider is not editable', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  // Previously this silently `continue`d and still answered "saved and
  // applied", so a delete appeared to succeed and the card reappeared on the
  // next render — the API reported work it had not done.
  test('refuses an edit rather than silently ignoring it', () => {
    const config = hostedConfig();
    expect(() => saveLLMSettings(config, {
      providers: { [USEJARVIS_PROVIDER_NAME]: { base_url: 'http://attacker/v1' } },
    })).toThrow(/managed by your hosting plan/);
    // The injected entry is untouched by the rejected write.
    expect(config.llm.providers?.[USEJARVIS_PROVIDER_NAME]?.base_url).toBe('https://llm.usejarvis.host');
  });

  test('refuses a delete too', () => {
    const config = hostedConfig();
    expect(() => saveLLMSettings(config, {
      providers: { [USEJARVIS_PROVIDER_NAME]: null },
    })).toThrow(/managed by your hosting plan/);
    expect(config.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeDefined();
  });

  test('an ordinary provider still saves normally', () => {
    const config = hostedConfig();
    // The key rides along with the base_url: main's credential-scoping rule
    // refuses to let a STORED credential follow a provider to a new endpoint,
    // so a URL change must re-supply it in the same request.
    saveLLMSettings(config, {
      providers: { anthropic: { kind: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-ant-user' } },
    });
    expect(config.llm.providers?.anthropic?.kind).toBe('anthropic');
  });

  // The security invariant: the per-account key must never reach the DB.
  test('a save on a hosted install leaves the reserved name out of the settings table', () => {
    const config = hostedConfig();
    saveLLMSettings(config, { prompt_cache: false });
    const stored = getSetting('llm.providers') ?? '{}';
    expect(stored).not.toContain(USEJARVIS_PROVIDER_NAME);
    expect(stored).not.toContain('sk-uj-');
    expect(stored).not.toContain('llm.usejarvis.host');
  });
});

describe('getLLMSettings: the block is reported, never exposed', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('reports hosted_llm without any credential or endpoint material', () => {
    const view = getLLMSettings(hostedConfig());
    expect(view.hosted_llm).toBe(true);
    // Surfaced as a managed flag only — not as an editable provider entry.
    expect(view.providers[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('sk-uj-');
    expect(serialized).not.toContain('llm.usejarvis.host');
  });

  test('a self-hosted install reports hosted_llm false', () => {
    expect(getLLMSettings(structuredClone(DEFAULT_CONFIG)).hosted_llm).toBe(false);
  });
});

describe('getLLMSettings (hosted vs self-hosted surface)', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('hosted: a user provider lists alone, the managed entry stays hidden', () => {
    const config = hostedConfig();
    config.llm.providers!.anthropic = { api_key: 'sk-ant-user' };
    const out = getLLMSettings(config);
    expect(out.hosted_llm).toBe(true);
    expect(out.providers[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
    expect(Object.keys(out.providers)).toEqual(['anthropic']);
  });

  test('self-hosted: providers pass through in display shape', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = { anthropic: { api_key: 'sk-ant-user' } };
    const out = getLLMSettings(config);
    expect(out.hosted_llm).toBe(false);
    expect(out.providers.anthropic).toEqual({ kind: 'anthropic', has_api_key: true });
  });
});

describe('getLLMSettings.effective: the dashboard reads routing reality, not a re-derivation', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('hosted + everything silent: router-first on the four plan aliases, sourced "plan"', () => {
    const config = hostedConfig();
    const { effective } = getLLMSettings(config);
    expect(effective.mode).toBe('router-first');
    expect(effective.tiers.conversation).toEqual({ ref: 'usejarvis_ai:uj-chat', source: 'plan' });
    expect(effective.tiers.high).toEqual({ ref: 'usejarvis_ai:uj-high', source: 'plan' });
    expect(effective.tiers.medium).toEqual({ ref: 'usejarvis_ai:uj-medium', source: 'plan' });
    expect(effective.tiers.low).toEqual({ ref: 'usejarvis_ai:uj-low', source: 'plan' });
    // ...while the persisted view stays pure user intent (all null).
    expect(getLLMSettings(config).tiers.high).toBeNull();
  });

  test('hosted + llm.default set: per-slot D1 resolution, explicit choice wins its slot', () => {
    const config = hostedConfig();
    config.llm.default = 'anthropic:claude-x';
    config.llm.tiers = { high: 'usejarvis_ai:uj-high' };
    const { effective } = getLLMSettings(config);
    expect(effective.tiers.high).toEqual({ ref: 'usejarvis_ai:uj-high', source: 'choice' });
    expect(effective.tiers.medium).toEqual({ ref: 'anthropic:claude-x', source: 'default' });
    expect(effective.tiers.conversation).toEqual({ ref: 'anthropic:claude-x', source: 'default' });
  });

  test('self-hosted: effective mirrors the persisted refs, silent slots stay empty', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm.tiers = { high: 'anthropic:claude-x' };
    const { effective } = getLLMSettings(config);
    expect(effective.mode).toBe('single'); // no conversation tier bound
    expect(effective.tiers.high).toEqual({ ref: 'anthropic:claude-x', source: 'choice' });
    expect(effective.tiers.low).toEqual({ ref: null, source: null });
  });
});

describe('self-hosted installs with a legacy provider literally named usejarvis_ai (W10)', () => {
  beforeEach(() => { closeDb(); initDatabase(':memory:'); });
  afterEach(() => { closeDb(); });

  test('the entry survives an unrelated save, stays listed, and hosted_llm stays false', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.llm.providers = { usejarvis_ai: { kind: 'openai_compatible', base_url: 'https://my.gw/v1' } };
    saveLLMSettings(config, { prompt_cache: false });
    // Persisted, not dropped:
    expect(getSetting('llm.providers') ?? '').toContain('usejarvis_ai');
    // Still visible to the dashboard, and the install does not read as hosted:
    const view = getLLMSettings(config);
    expect(view.providers.usejarvis_ai).toBeDefined();
    expect(view.hosted_llm).toBe(false);
    // Reload keeps it (no reserved-name skip on self-hosted):
    const reloaded = structuredClone(DEFAULT_CONFIG);
    mergeLLMSettingsIntoConfig(reloaded);
    expect(reloaded.llm.providers?.usejarvis_ai?.base_url).toBe('https://my.gw/v1');
  });
});
