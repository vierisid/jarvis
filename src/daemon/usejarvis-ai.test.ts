import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { hasSecret } from '../vault/keychain.ts';
import {
  applyUsejarvisAi,
  effectiveLlmForBinding,
  hasUsejarvisAi,
  USEJARVIS_PROVIDER_NAME,
} from './usejarvis-ai.ts';
import { mergeLLMSettingsIntoConfig, saveLLMSettings } from './llm-settings.ts';

const base = (): JarvisConfig => structuredClone(DEFAULT_CONFIG);

const hosted = (): JarvisConfig => {
  const config = base();
  config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc123' };
  return config;
};

describe('applyUsejarvisAi (provider injection only)', () => {
  test('no-op on self-hosted installs (block absent or incomplete)', () => {
    const config = base();
    applyUsejarvisAi(config);
    expect(config.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
    expect(hasUsejarvisAi(config)).toBe(false);

    const partial = base();
    partial.usejarvis_ai = { base_url: 'https://llm.usejarvis.host' }; // no key
    applyUsejarvisAi(partial);
    expect(partial.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
  });

  test('injects the provider and NEVER touches config.llm.tiers', () => {
    const config = hosted();
    applyUsejarvisAi(config);
    expect(config.llm.providers![USEJARVIS_PROVIDER_NAME]).toEqual({
      kind: 'usejarvis_ai',
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc123',
    });
    // Tier defaults live ONLY in the binding view — the config object stays
    // exactly what the DB (here: nothing) provided, so no save path can
    // ever persist a fabricated tier as a user choice.
    expect(config.llm.tiers ?? {}).toEqual({});
    expect(config.llm.default).toBeUndefined();
  });

  test('a malformed block (unquoted YAML scalars) is ignored, never throws', () => {
    const config = base();
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host', api_key: 1234567890 } as never;
    expect(hasUsejarvisAi(config)).toBe(false);
    expect(() => applyUsejarvisAi(config)).not.toThrow();
    expect(config.llm.providers?.[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
  });

  test('base_url is normalized: trailing slashes never reach the provider entry', () => {
    const config = base();
    config.usejarvis_ai = { base_url: 'https://llm.usejarvis.host/v1/', api_key: 'sk-uj-abc123' };
    applyUsejarvisAi(config);
    expect(config.llm.providers![USEJARVIS_PROVIDER_NAME]!.base_url).toBe(
      'https://llm.usejarvis.host/v1',
    );
  });

  test('a DB row squatting on the reserved name is overwritten, not merged', () => {
    const config = hosted();
    config.llm.providers = {
      [USEJARVIS_PROVIDER_NAME]: { kind: 'openai', base_url: 'https://evil.example' },
    };
    applyUsejarvisAi(config);
    expect(config.llm.providers[USEJARVIS_PROVIDER_NAME]).toEqual({
      kind: 'usejarvis_ai',
      base_url: 'https://llm.usejarvis.host',
      api_key: 'sk-uj-abc123',
    });
  });

  test('idempotent: applying twice equals applying once', () => {
    const once = hosted();
    applyUsejarvisAi(once);
    const twice = hosted();
    applyUsejarvisAi(twice);
    applyUsejarvisAi(twice);
    expect(twice.llm).toEqual(once.llm);
  });
});

describe('effectiveLlmForBinding (per-slot: explicit ref → llm.default → plan alias)', () => {
  test('self-hosted: returns config.llm untouched', () => {
    const config = base();
    config.llm.tiers = { high: 'anthropic:claude-x' };
    expect(effectiveLlmForBinding(config)).toBe(config.llm);
  });

  test('hosted, all silent: every slot resolves to its uj-* alias', () => {
    const config = hosted();
    expect(effectiveLlmForBinding(config).tiers).toEqual({
      conversation: 'usejarvis_ai:uj-chat',
      low: 'usejarvis_ai:uj-low',
      medium: 'usejarvis_ai:uj-medium',
      high: 'usejarvis_ai:uj-high',
    });
    // ...without mutating the underlying config.
    expect(config.llm.tiers ?? {}).toEqual({});
  });

  test("a user's explicit tier choice wins for THAT slot; the rest default", () => {
    const config = hosted();
    config.llm.tiers = { high: 'anthropic:claude-x' };
    const effective = effectiveLlmForBinding(config);
    expect(effective.tiers!.high).toBe('anthropic:claude-x');
    expect(effective.tiers!.low).toBe('usejarvis_ai:uj-low');
    expect(config.llm.tiers).toEqual({ high: 'anthropic:claude-x' }); // untouched
  });

  test('llm.default narrows the fallback for unset slots instead of disabling the others', () => {
    // The old all-or-nothing bail meant setting a default silently tore down
    // every hosted tier. Per-slot resolution: explicit ref → default → alias.
    const config = hosted();
    config.llm.default = 'anthropic:claude-x';
    config.llm.tiers = { high: 'usejarvis_ai:uj-high' };
    const effective = effectiveLlmForBinding(config);
    expect(effective.tiers!.high).toBe('usejarvis_ai:uj-high'); // explicit wins
    expect(effective.tiers!.conversation).toBe('anthropic:claude-x'); // default beats alias
    expect(effective.tiers!.low).toBe('anthropic:claude-x');
  });
});

describe('DB round-trips (restart survival + fill never persists)', () => {
  // Isolated keychain per test: these paths touch getSecret/setSecret and must
  // never read from — or write to — the machine's real ~/.jarvis keychain.
  let secretsDir: string;
  let prevSecretsDir: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-usejarvis-ai-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
  });

  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('persisted usejarvis_ai:* refs survive a boot merge (never pruned as orphans)', () => {
    initDatabase(':memory:');
    setSetting('llm.providers', '{}');
    setSetting('llm.default', 'usejarvis_ai:uj-high');
    setSetting('llm.tiers.high', 'usejarvis_ai:uj-high');

    const config = hosted();
    mergeLLMSettingsIntoConfig(config);

    // In memory AND in the settings table: the refs must survive the restart.
    expect(config.llm.default).toBe('usejarvis_ai:uj-high');
    expect(config.llm.tiers!.high).toBe('usejarvis_ai:uj-high');
    expect(getSetting('llm.default')).toBe('usejarvis_ai:uj-high');
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:uj-high');
  });

  test('un-hosting still prunes the now-dangling usejarvis_ai refs', () => {
    initDatabase(':memory:');
    setSetting('llm.providers', '{}');
    setSetting('llm.tiers.high', 'usejarvis_ai:uj-high');

    const config = base(); // no usejarvis_ai block
    mergeLLMSettingsIntoConfig(config);

    expect(config.llm.tiers!.high).toBeUndefined();
    expect(getSetting('llm.tiers.high')).toBe('');
  });

  test('the hosted fill is never promoted to persisted user state by a save', () => {
    initDatabase(':memory:');
    const config = hosted();
    mergeLLMSettingsIntoConfig(config);

    // Reproduces pr1's defaults-become-choices bug: switch to single mode,
    // then pick a default — before the fix the refilled uj-* tiers were
    // written to the DB and outranked the model the user just chose.
    saveLLMSettings(config, { mode: 'single', tiers: { conversation: null, high: null, medium: null, low: null } });
    saveLLMSettings(config, { default: 'anthropic:claude-x' });

    expect(getSetting('llm.default')).toBe('anthropic:claude-x');
    expect(getSetting('llm.tiers.conversation')).toBe('');
    expect(getSetting('llm.tiers.high')).toBe('');
    expect(getSetting('llm.tiers.medium')).toBe('');
    expect(getSetting('llm.tiers.low')).toBe('');
    expect(config.llm.tiers ?? {}).toEqual({});
  });

  test('clearing a tier persists the clear (no same-request refill)', () => {
    initDatabase(':memory:');
    const config = hosted();
    mergeLLMSettingsIntoConfig(config);

    saveLLMSettings(config, { tiers: { high: 'usejarvis_ai:uj-high' } });
    expect(getSetting('llm.tiers.high')).toBe('usejarvis_ai:uj-high');

    saveLLMSettings(config, { tiers: { high: null } });
    expect(getSetting('llm.tiers.high')).toBe('');
    expect(config.llm.tiers!.high).toBeUndefined();
    // The binding view falls back to the plan alias; the persisted state does not.
    expect(effectiveLlmForBinding(config).tiers!.high).toBe('usejarvis_ai:uj-high');
  });

  test('editing/deleting the managed provider is refused atomically on hosted installs', () => {
    initDatabase(':memory:');
    const config = hosted();
    mergeLLMSettingsIntoConfig(config);
    config.llm.providers!['atomicity-probe'] = { kind: 'anthropic' };

    // The throw must come from the VALIDATION loop: a mixed batch rejects
    // without writing the sibling's key to the keychain or mutating config.
    expect(() =>
      saveLLMSettings(config, {
        providers: {
          'atomicity-probe': { api_key: 'sk-ant-NEW' },
          [USEJARVIS_PROVIDER_NAME]: null,
        },
      }),
    ).toThrow(/managed by your hosting plan/);
    expect(hasSecret('llm.provider.atomicity-probe.api_key')).toBe(false);
    expect(config.llm.providers!['atomicity-probe']).toEqual({ kind: 'anthropic' });

    // Self-hosted installs keep the legacy silent skip (no block, no throw).
    const selfHosted = base();
    selfHosted.llm.providers = {};
    expect(() =>
      saveLLMSettings(selfHosted, { providers: { [USEJARVIS_PROVIDER_NAME]: { kind: 'openai' } } }),
    ).not.toThrow();
    expect(selfHosted.llm.providers[USEJARVIS_PROVIDER_NAME]).toBeUndefined();
  });
});
