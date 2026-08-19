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
  effectiveSttForBinding,
  effectiveTtsForBinding,
  hasUsejarvisAi,
  usejarvisVoiceCredentials,
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
      prompt_cache: false, // opt-in, absent block field reads as OFF
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
      prompt_cache: false,
    });
  });

  test('the provisioner prompt_cache opt-in carries through; junk reads as OFF', () => {
    const optedIn = hosted();
    optedIn.usejarvis_ai!.prompt_cache = true;
    applyUsejarvisAi(optedIn);
    expect(optedIn.llm.providers![USEJARVIS_PROVIDER_NAME]!.prompt_cache).toBe(true);

    const junk = hosted();
    (junk.usejarvis_ai as Record<string, unknown>).prompt_cache = 'yes'; // YAML-typed junk
    applyUsejarvisAi(junk);
    expect(junk.llm.providers![USEJARVIS_PROVIDER_NAME]!.prompt_cache).toBe(false);
  });

  test('idempotent: applying twice equals applying once', () => {
    const once = hosted();
    applyUsejarvisAi(once);
    const twice = hosted();
    applyUsejarvisAi(twice);
    applyUsejarvisAi(twice);
    expect(twice.llm).toEqual(once.llm);
  });

  test('testLLMProvider refuses the reserved name (key-exfiltration guard)', async () => {
    const { testLLMProvider } = await import('./llm-settings.ts');
    const config = hosted();
    applyUsejarvisAi(config);
    // A kind/base_url override would otherwise inherit the hosted key and
    // send it to an attacker-chosen endpoint.
    const result = await testLLMProvider(
      { name: USEJARVIS_PROVIDER_NAME, kind: 'openai_compatible', base_url: 'https://evil.example' },
      config,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('system-managed');
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

    // Self-hosted installs have NO reservation: a provider that happens to
    // carry the name is user property and saves like any other entry (the
    // old silent skip destroyed legacy configs named usejarvis_ai).
    const selfHosted = base();
    selfHosted.llm.providers = {};
    expect(() =>
      saveLLMSettings(selfHosted, { providers: { [USEJARVIS_PROVIDER_NAME]: { kind: 'openai' } } }),
    ).not.toThrow();
    expect(selfHosted.llm.providers[USEJARVIS_PROVIDER_NAME]).toEqual({ kind: 'openai' });
  });
});

describe('hasUsejarvisAi: malformed blocks read as NOT hosted, never fatal', () => {
  const withBlock = (block: unknown): JarvisConfig => {
    const config = structuredClone(DEFAULT_CONFIG);
    (config as Record<string, unknown>).usejarvis_ai = block;
    return config;
  };

  // YAML types its scalars: an unquoted `api_key: 1234567890` parses as a
  // number, and `.trim()` on it threw out of here, through
  // mergeLLMSettingsIntoConfig, into the boot try/catch → exit(1). A hand-
  // edited config must degrade to self-hosted, not stop the daemon booting.
  test('a numeric api_key or base_url does not throw', () => {
    expect(() => hasUsejarvisAi(withBlock({ base_url: 'https://x', api_key: 1234567890 }))).not.toThrow();
    expect(hasUsejarvisAi(withBlock({ base_url: 'https://x', api_key: 1234567890 }))).toBe(false);
    expect(hasUsejarvisAi(withBlock({ base_url: 42, api_key: 'sk-uj-abc' }))).toBe(false);
  });

  test('other malformed shapes are also non-fatal and non-hosted', () => {
    for (const block of [null, undefined, 'a string', [], { base_url: 'https://x' }, { api_key: 'sk-uj-a' },
                         { base_url: '   ', api_key: 'sk-uj-a' }, { base_url: true, api_key: false }]) {
      expect(() => hasUsejarvisAi(withBlock(block))).not.toThrow();
      expect(hasUsejarvisAi(withBlock(block))).toBe(false);
    }
  });

  test('a well-formed block still reads as hosted', () => {
    expect(hasUsejarvisAi(withBlock({ base_url: 'https://llm.usejarvis.host', api_key: 'sk-uj-abc' }))).toBe(true);
  });
});

describe('usejarvisVoiceCredentials (the SEPARATE credential channel)', () => {
  test('null on self-hosted installs', () => {
    expect(usejarvisVoiceCredentials(base())).toBeNull();
    const partial = base();
    partial.usejarvis_ai = { base_url: 'https://llm.usejarvis.host' }; // no key
    expect(usejarvisVoiceCredentials(partial)).toBeNull();
  });

  test('returns trimmed proxy origin + key when hosted', () => {
    const config = hosted();
    config.usejarvis_ai = { base_url: ' https://llm.usejarvis.host ', api_key: ' sk-uj-abc123 ' };
    expect(usejarvisVoiceCredentials(config)).toEqual({
      baseUrl: 'https://llm.usejarvis.host',
      apiKey: 'sk-uj-abc123',
    });
  });
});

describe('effectiveSttForBinding (hosted STT default, persistence-pure)', () => {
  const noRow = () => undefined;

  test('self-hosted: returns cfg.stt untouched (same reference), DB never read', () => {
    const config = base();
    let reads = 0;
    const spy = () => { reads += 1; return undefined; };
    expect(effectiveSttForBinding(config, spy)).toBe(config.stt);
    expect(reads).toBe(0);
  });

  test('hosted + no stored stt row: binding view says usejarvis, config is NOT mutated', () => {
    const config = hosted();
    const view = effectiveSttForBinding(config, noRow);
    expect(view?.provider).toBe('usejarvis');
    // Persistence purity: the in-memory section every /api/config/stt save
    // round-trips must still carry only user intent (the stock default).
    expect(config.stt?.provider).toBe('openai');
  });

  test('hosted + stored row WITH a provider: the explicit user choice wins', () => {
    const config = hosted();
    config.stt = { provider: 'groq', groq: { api_key: 'gsk-user' } };
    const view = effectiveSttForBinding(config, (section) =>
      section === 'stt' ? { provider: 'groq', groq: { api_key: 'gsk-user' } } : undefined);
    expect(view).toBe(config.stt); // untouched, same reference
    expect(view?.provider).toBe('groq');
  });

  test('hosted + stored row with a sub-block but no provider: configuration, not silence', () => {
    const config = hosted();
    // What the legacy import wrote for a config.yaml that had
    // `stt: { openai: {...} }` and relied on DEFAULT_CONFIG for the provider
    // line: a stripped row with no `provider`. That user configured a key —
    // re-routing their audio to the hosted proxy past it would bypass an
    // explicit setup, so the sub-block reads as intent and the merged
    // in-memory section (provider 'openai') binds.
    config.stt = { provider: 'openai', openai: { api_key: 'sk-user' } };
    const view = effectiveSttForBinding(config, () => ({ openai: {} }));
    expect(view).toBe(config.stt);
    expect(view?.provider).toBe('openai');
  });

  test('hosted + stored row with only unknown fields: still silent, defaults to usejarvis', () => {
    const config = hosted();
    // A row carrying no provider AND no provider sub-block (e.g. just a
    // language preference) records no routing intent.
    const view = effectiveSttForBinding(config, () => ({ language: 'it' }));
    expect(view?.provider).toBe('usejarvis');
  });

  test('the view never carries credentials: only the provider string differs', () => {
    const config = hosted();
    const view = effectiveSttForBinding(config, noRow)!;
    expect(JSON.stringify(view)).not.toContain('sk-uj-abc123');
    expect(view).toEqual({ ...config.stt!, provider: 'usejarvis' });
  });
});

describe('effectiveTtsForBinding (hosted TTS default, explicit Edge respected)', () => {
  const noRow = () => undefined;

  test('self-hosted: returns cfg.tts untouched (same reference), DB never read', () => {
    const config = base();
    let reads = 0;
    const spy = () => { reads += 1; return undefined; };
    expect(effectiveTtsForBinding(config, spy)).toBe(config.tts);
    expect(reads).toBe(0);
  });

  test('hosted + no stored tts row: binding view says usejarvis, enabled and config untouched', () => {
    const config = hosted();
    const view = effectiveTtsForBinding(config, noRow);
    expect(view?.provider).toBe('usejarvis');
    // The hosted default never switches speech ON — it only picks who
    // speaks once the user enables TTS.
    expect(view?.enabled).toBe(false);
    // Persistence purity: the in-memory section still carries the stock
    // default, so a later save records no choice the user never made.
    expect(config.tts?.provider).toBe('edge');
  });

  test("hosted + stored row with provider 'edge': the EXPLICIT Edge choice wins", () => {
    // The in-memory 'edge' alone is ambiguous (it is also DEFAULT_CONFIG's
    // value) — the stored row's provider field is what makes it intent.
    const config = hosted();
    config.tts = { enabled: true, provider: 'edge', voice: 'en-GB-SoniaNeural' };
    const view = effectiveTtsForBinding(config, (section) =>
      section === 'tts' ? { enabled: true, provider: 'edge', voice: 'en-GB-SoniaNeural' } : undefined);
    expect(view).toBe(config.tts); // same reference, untouched
    expect(view?.provider).toBe('edge');
  });

  test('hosted + stored row WITHOUT a provider field (voice-command enable): still silent', () => {
    const config = hosted();
    config.tts = { ...config.tts!, enabled: true };
    const view = effectiveTtsForBinding(config, () => ({ enabled: true }));
    expect(view?.provider).toBe('usejarvis');
    expect(view?.enabled).toBe(true);
  });

  test('the view never carries credentials', () => {
    const config = hosted();
    const view = effectiveTtsForBinding(config, noRow)!;
    expect(JSON.stringify(view)).not.toContain('sk-uj-abc123');
    expect(view).toEqual({ ...config.tts!, provider: 'usejarvis' });
  });
});
