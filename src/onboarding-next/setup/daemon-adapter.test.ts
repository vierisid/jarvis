import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../config/types.ts';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { getDb } from '../../vault/schema.ts';
import { getSetting, setSetting } from '../../vault/settings.ts';
import { loadUserSection, saveUserSection, persistUserPatch, persistAwarenessChoice, importLegacyUserSettings } from '../../daemon/user-settings.ts';
import { effectiveLlmForBinding, effectiveTtsForBinding } from '../../daemon/usejarvis-ai.ts';
import { createDaemonSetupStore } from './daemon-adapter.ts';
import { createSetupProvider } from './provider.ts';

const owner = { actorId: 'fixture-owner', projectId: 'fixture-project' };
const command = { action: 'complete_setup' };
let secretsDir: string;
let oldSecrets: string | undefined;
beforeEach(() => {
  oldSecrets = process.env.JARVIS_SECRETS_DIR;
  secretsDir = mkdtempSync(join(tmpdir(), 'on-b-02-'));
  process.env.JARVIS_SECRETS_DIR = secretsDir;
  closeDb(); initDatabase(':memory:');
});
afterEach(() => {
  closeDb();
  if (oldSecrets === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = oldSecrets;
  rmSync(secretsDir, { recursive: true, force: true });
});
function fixture(awarenessAtStart = false) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = { base_url: 'https://fixture.invalid', api_key: 'fixture-not-real' };
  let loaded = true;
  const store = createDaemonSetupStore({ owner, config, isConfigLoaded: () => loaded, isSelfConfigured: () => false, now: () => 12345 });
  let starts = 0;
  const provider = createSetupProvider({ authorize: () => owner, store, services: {
    read: async () => starts ? 'running' : 'stopped',
    start: async () => {
      // Exercise the legacy starter's exact Awareness guard without starting
      // a daemon, background agent, capture loop or external provider.
      expect(config.awareness?.enabled).toBe(awarenessAtStart);
      expect((loadUserSection('awareness') as { enabled: boolean }).enabled).toBe(awarenessAtStart);
      starts++;
    },
  } });
  return { config, store, provider, setLoaded: (value: boolean) => { loaded = value; }, starts: () => starts };
}

describe('existing vault/settings setup adapter', () => {
  test('hosted setup persists, preserves system providers and starts only after disabling implicit Awareness', async () => {
    const f = fixture();
    const system = structuredClone(f.config.usejarvis_ai);
    const llm = effectiveLlmForBinding(f.config);
    expect(await f.provider.read(null)).toMatchObject({ reason: 'setup_required' });
    expect(loadUserSection('onboarding') ?? null).toBeNull();
    expect(loadUserSection('awareness') ?? null).toBeNull();
    expect(await f.provider.complete(null, command)).toMatchObject({ ready: true, completedAt: 12345 });
    expect(f.config.usejarvis_ai).toEqual(system);
    expect(effectiveLlmForBinding(f.config)).toEqual(llm);
    expect(getSetting('llm.mode')).toBe('multi-tier');
    expect(getSetting('llm.default')).toBe('');
    expect(loadUserSection('stt') ?? null).toBeNull();
    expect(loadUserSection('tts')).toEqual({ enabled: true });
    expect(effectiveTtsForBinding(f.config)?.provider).toBe('usejarvis');
    expect(f.starts()).toBe(1);
    const before = getSetting('cfg.onboarding');
    await f.provider.complete(null, command);
    expect(getSetting('cfg.onboarding')).toBe(before);
    expect(f.starts()).toBe(1);
  });
  test('a durable retry preserves completion and a later explicit Awareness choice', async () => {
    const f = fixture(); await f.provider.complete(null, command);
    saveUserSection('awareness', { ...f.config.awareness!, enabled: true });
    const reloaded = createDaemonSetupStore({ owner, config: f.config, isConfigLoaded: () => true, isSelfConfigured: () => false, now: () => 99999 });
    expect(await reloaded.completeHosted(owner)).toBe(12345);
    expect((loadUserSection('awareness') as { enabled: boolean }).enabled).toBe(true);
  });
  test.each([true, false])('re-running setup after a setup reset keeps an explicit Awareness=%p choice (#1070)', async choice => {
    const f = fixture(choice); await f.provider.complete(null, command);
    // The user's later choice in Settings, then /api/onboarding/reset with scope setup.
    setSetting('cfg.awareness', JSON.stringify({ capture_interval_ms: 1234 })); persistAwarenessChoice(choice, 777); f.config.awareness = { ...f.config.awareness!, enabled: choice };
    saveUserSection('onboarding', { ...f.config.onboarding!, setup_completed_at: null }); f.config.onboarding = { ...f.config.onboarding!, setup_completed_at: null };
    const rerun = createDaemonSetupStore({ owner, config: f.config, isConfigLoaded: () => true, isSelfConfigured: () => false, now: () => 99999 });
    expect(rerun.completeHosted(owner)).toBe(99999);
    expect(loadUserSection('awareness')).toEqual({ enabled: choice, enabled_chosen_at: 777, capture_interval_ms: 1234 });
    expect(f.config.awareness?.enabled).toBe(choice);
  });
  test('an unmarked Awareness=true, as older builds stamped from defaults into config.yaml, is not a choice (#1070)', async () => {
    const f = fixture();
    // Builds before #262 saved the whole merged config, so config.yaml carried DEFAULT_CONFIG's enabled: true.
    expect(importLegacyUserSettings({ awareness: structuredClone(DEFAULT_CONFIG.awareness) })).toContain('awareness');
    expect((loadUserSection('awareness') as { enabled: boolean }).enabled).toBe(true);
    expect(await f.provider.complete(null, command)).toMatchObject({ ready: true });
    expect((loadUserSection('awareness') as { enabled: boolean }).enabled).toBe(false); expect(f.config.awareness?.enabled).toBe(false);
  });
  test('first setup stores only the Awareness off switch, not every in-memory default (#1070)', async () => {
    const f = fixture(); await f.provider.complete(null, command);
    expect(loadUserSection('awareness')).toEqual({ enabled: false });
  });
  test('an Awareness section saved without an enabled choice still starts off; a malformed one blocks setup (#1070)', async () => {
    const f = fixture(); setSetting('cfg.awareness', JSON.stringify({ capture_interval_ms: 1234 }));
    expect(await f.provider.complete(null, command)).toMatchObject({ ready: true });
    expect(loadUserSection('awareness')).toMatchObject({ enabled: false, capture_interval_ms: 1234 });
    const g = fixture(); setSetting('cfg.awareness', JSON.stringify({ enabled: 'yes' })); setSetting('cfg.onboarding', JSON.stringify({ setup_completed_at: null }));
    expect(await g.provider.complete(null, command)).toMatchObject({ reason: 'setup_save_failed', ready: false });
    expect(getSetting('cfg.awareness')).toBe(JSON.stringify({ enabled: 'yes' })); expect(g.starts()).toBe(0);
  });
  test('explicit voice decline, existing provider settings and onboarding fields survive', async () => {
    const f = fixture();
    persistUserPatch('tts', { enabled: false, provider: 'edge', voice: 'fixture-voice' });
    saveUserSection('onboarding', { setup_completed_at: null, tutorial_completed_at: null, tutorial_progress_step: 'rooms', setup_skipped_profile: true });
    await f.provider.complete(null, command);
    expect(loadUserSection('tts')).toEqual({ enabled: false, provider: 'edge', voice: 'fixture-voice' });
    expect(loadUserSection('onboarding')).toMatchObject({ setup_completed_at: 12345, tutorial_progress_step: 'rooms', setup_skipped_profile: true });
  });
  test('delayed server configuration stays unknown; proxy-less hosted remains hosted', async () => {
    const f = fixture(); f.setLoaded(false);
    expect(await f.store.read(owner)).toMatchObject({ installMode: 'unknown', configured: false });
    f.setLoaded(true); f.config.usejarvis_ai = undefined; f.config.daemon.listen = 'unix:/fixture/brain.sock';
    expect(await f.provider.complete(null, command)).toMatchObject({ installMode: 'hosted', reason: 'hosted_configuration_unavailable', next: 'retry' });
    expect(loadUserSection('onboarding') ?? null).toBeNull();
  });
  test('self-hosted settings are never rewritten or marked complete', async () => {
    const f = fixture(); f.config.usejarvis_ai = undefined;
    f.config.llm.providers = { local: { kind: 'ollama', base_url: 'http://fixture.invalid' } };
    const before = structuredClone(f.config);
    expect(await f.provider.complete(null, command)).toMatchObject({ installMode: 'self', next: 'legacy_setup' });
    expect(f.config).toEqual(before);
    expect(loadUserSection('onboarding') ?? null).toBeNull();
    expect(() => f.store.completeHosted(owner)).toThrow();
  });
  test('wrong actor/project cannot read or commit the bound vault', () => {
    const f = fixture();
    for (const scope of [{ ...owner, actorId: 'other' }, { ...owner, projectId: 'other' }]) {
      expect(() => f.store.read(scope)).toThrow('owner mismatch');
      expect(() => f.store.completeHosted(scope)).toThrow('owner mismatch');
    }
    expect(loadUserSection('onboarding') ?? null).toBeNull();
  });
  test.each(['not-json', '[]', '"string"', '{"setup_completed_at":"yesterday"}'])(
    'corrupt onboarding row %s is retained and not overwritten', async raw => {
      const f = fixture(); setSetting('cfg.onboarding', raw);
      expect(await f.provider.complete(null, command)).toMatchObject({ reason: 'setup_unavailable', ready: false });
      expect(getSetting('cfg.onboarding')).toBe(raw); expect(f.starts()).toBe(0);
    },
  );
  test.each(['cfg.awareness', 'cfg.tts'])('corrupt %s blocks setup before writes', async key => {
    const f = fixture(); setSetting(key, '[]');
    expect(await f.provider.complete(null, command)).toMatchObject({ reason: 'setup_save_failed', ready: false });
    expect(loadUserSection('onboarding') ?? null).toBeNull(); expect(f.starts()).toBe(0);
    expect(getSetting(key)).toBe('[]'); expect(getSetting('llm.mode')).toBeNull();
  });
  test('real SQLite completion-write failure retains off state and retries safely', async () => {
    const f = fixture();
    getDb().exec("CREATE TRIGGER fixture_fail_setup BEFORE INSERT ON settings WHEN NEW.key = 'cfg.onboarding' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
    expect(await f.provider.complete(null, command)).toMatchObject({ reason: 'setup_save_failed', completedAt: null, ready: false });
    expect(loadUserSection('onboarding') ?? null).toBeNull();
    expect(f.config.onboarding?.setup_completed_at ?? null).toBeNull();
    expect(f.config.awareness?.enabled).toBe(false); expect(f.starts()).toBe(0);
    getDb().exec('DROP TRIGGER fixture_fail_setup');
    expect(await f.provider.complete(null, command)).toMatchObject({ ready: true, completedAt: 12345 });
  });
});
