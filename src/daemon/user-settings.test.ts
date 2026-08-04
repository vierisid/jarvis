import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { loadConfig } from '../config/loader.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import {
  saveUserSection,
  loadUserSection,
  importLegacyUserSettings,
  mergeUserSettingsIntoConfig,
  saveGoogleSettings,
  setSectionSavedListener,
} from './user-settings.ts';

function freshConfig(): JarvisConfig {
  return structuredClone(DEFAULT_CONFIG);
}

describe('user-settings', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    setSectionSavedListener(null);
    closeDb();
  });

  test('workflows: file-provided SYSTEM path keys win over a saved user section', () => {
    // A dashboard save of the user-tunable workflow fields (which may carry
    // stale/absent path keys) must never strip the deployment-written
    // artifact paths that loadConfig preserved from the FILE.
    saveUserSection('workflows', {
      enabled: true,
      maxConcurrentExecutions: 2,
      defaultRetries: 0,
      defaultTimeoutMs: 1000,
      selfHealEnabled: false,
      autoSuggestEnabled: false,
    });

    const config = freshConfig();
    (config as Record<string, unknown>)['workflows'] = {
      engine_dir: '/opt/jarvis-engine/${version}',
      pieces_dir: '/srv/pieces',
      piece_metadata_cache: '/srv/piece-metadata.json',
    };
    mergeUserSettingsIntoConfig(config);

    expect(config.workflows?.enabled).toBe(true);
    expect(config.workflows?.maxConcurrentExecutions).toBe(2);
    expect(config.workflows?.engine_dir).toBe('/opt/jarvis-engine/${version}');
    expect(config.workflows?.pieces_dir).toBe('/srv/pieces');
    expect(config.workflows?.piece_metadata_cache).toBe('/srv/piece-metadata.json');
  });

  test('save -> merge round-trips a section into the config', () => {
    saveUserSection('stt', { provider: 'groq', groq: { api_key: 'gk-1' } });
    saveUserSection('active_role', 'researcher');

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    expect(config.stt?.provider).toBe('groq');
    expect(config.stt?.groq?.api_key).toBe('gk-1');
    expect(config.active_role).toBe('researcher');
  });

  test('object sections merge OVER defaults so old rows never strip new fields', () => {
    // Simulate a row written by an older build that predates a field.
    setSetting('cfg.heartbeat', JSON.stringify({ interval_minutes: 5 }));

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    expect(config.heartbeat.interval_minutes).toBe(5);
    // Fields the stored row doesn't know about keep their defaults.
    expect(config.heartbeat.active_hours).toEqual(DEFAULT_CONFIG.heartbeat.active_hours);
    expect(config.heartbeat.aggressiveness).toBe(DEFAULT_CONFIG.heartbeat.aggressiveness);
  });

  test('absent sections leave the config untouched', () => {
    const config = freshConfig();
    const before = structuredClone(config);
    mergeUserSettingsIntoConfig(config);
    expect(config).toEqual(before);
  });

  test('corrupt stored JSON is ignored, not fatal', () => {
    setSetting('cfg.tts', '{not json');
    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.tts).toEqual(DEFAULT_CONFIG.tts);
    expect(loadUserSection('tts')).toBeUndefined();
  });

  test('import: UNCHANGED file never clobbers dashboard edits', () => {
    const legacyYaml = {
      daemon: { port: 7777 }, // system key: not imported
      stt: { provider: 'groq' },
      active_role: 'villain',
    };

    const imported = importLegacyUserSettings(legacyYaml);
    expect(imported.sort()).toEqual(['active_role', 'stt']);
    expect(getSetting('cfg.daemon')).toBeNull();

    // The dashboard later edits stt...
    saveUserSection('stt', { provider: 'openai' });

    // ...and a re-import from the SAME file must NOT clobber it.
    const reimported = importLegacyUserSettings(legacyYaml);
    expect(reimported).toEqual([]);

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.stt?.provider).toBe('openai');
    expect(config.active_role).toBe('villain');
  });

  test('import: an EDITED file value applies over the DB (editor-less sections stay tunable)', () => {
    // Review finding: heartbeat/cron/goals/... have no dashboard editor, so
    // write-once import made the file a lie. A changed file value is intent.
    importLegacyUserSettings({ heartbeat: { interval_minutes: 15 } });
    let config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.heartbeat.interval_minutes).toBe(15);

    // Same file on the next boots: nothing happens.
    expect(importLegacyUserSettings({ heartbeat: { interval_minutes: 15 } })).toEqual([]);

    // The self-hoster edits the file: the new value must apply.
    const imported = importLegacyUserSettings({ heartbeat: { interval_minutes: 5 } });
    expect(imported).toEqual(['heartbeat']);
    config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.heartbeat.interval_minutes).toBe(5);
  });

  test('import: pre-tracking DB values are baselined, not clobbered, then file edits apply', () => {
    // Simulates an instance that imported under the old write-once behavior
    // (DB row exists, no import record) and got a dashboard edit.
    setSetting('cfg.stt', JSON.stringify({ provider: 'openai' }));

    // First boot with tracking: file present but only baselined.
    expect(importLegacyUserSettings({ stt: { provider: 'groq' } })).toEqual([]);
    let config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.stt?.provider).toBe('openai');

    // A LATER file edit applies.
    expect(importLegacyUserSettings({ stt: { provider: 'sarvam' } })).toEqual(['stt']);
    config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.stt?.provider).toBe('sarvam');
  });

  test('null rawYaml (no config file) imports nothing', () => {
    expect(importLegacyUserSettings(null)).toEqual([]);
  });

  test('section-saved listener fires AFTER the write, with the section name', () => {
    const events: string[] = [];
    setSectionSavedListener((section) => {
      events.push(section);
      // The DB write must already be visible when the listener runs.
      expect(loadUserSection('stt')).toEqual({ provider: 'groq' });
    });

    saveUserSection('stt', { provider: 'groq' });
    expect(events).toEqual(['stt']);
  });

  test("saveGoogleSettings notifies the listener with 'google'", () => {
    const events: string[] = [];
    setSectionSavedListener((section) => events.push(section));

    saveGoogleSettings({ client_id: 'id', client_secret: 'secret' });
    expect(events).toEqual(['google']);
  });

  test('a throwing listener never fails the save', () => {
    setSectionSavedListener(() => {
      throw new Error('listener boom');
    });

    expect(() => saveUserSection('active_role', 'researcher')).not.toThrow();
    expect(loadUserSection('active_role')).toBe('researcher');
  });

  test('setSectionSavedListener(null) detaches', () => {
    const events: string[] = [];
    setSectionSavedListener((section) => events.push(section));
    saveUserSection('active_role', 'a');
    setSectionSavedListener(null);
    saveUserSection('active_role', 'b');

    expect(events).toEqual(['active_role']);
  });

  test('google: DB is only a fallback - a file-provided client always wins', () => {
    saveGoogleSettings({ client_id: 'db-client', client_secret: 'db-secret' });

    // Self-host: no file google -> DB fallback applies.
    const selfHosted = freshConfig();
    mergeUserSettingsIntoConfig(selfHosted);
    expect(selfHosted.google?.client_id).toBe('db-client');

    // Hosted: the system config carries the shared company client -> file wins.
    const hosted = freshConfig();
    hosted.google = { client_id: 'company-client', client_secret: 'company-secret' };
    mergeUserSettingsIntoConfig(hosted);
    expect(hosted.google.client_id).toBe('company-client');
  });

  test('end to end: legacy file -> import -> discard -> merge equals old behavior', async () => {
    // The full boot path: a legacy config.yaml carrying user sections keeps
    // working (values preserved via the DB) even though loadConfig now
    // discards them from the file.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/jarvis-user-settings-${Date.now()}`;
    const path = `${dir}/config.yaml`;
    await Bun.write(
      path,
      'daemon:\n  port: 4242\nstt:\n  provider: sarvam\npersonality:\n  assistant_name: "Edith"\n',
    );

    const { readRawConfigFile } = await import('../config/loader.ts');
    const raw = await readRawConfigFile(path);
    importLegacyUserSettings(raw);

    const config = await loadConfig(path); // discards user sections...
    expect(config.stt?.provider).toBe(DEFAULT_CONFIG.stt?.provider);
    mergeUserSettingsIntoConfig(config); // ...and the DB restores them.

    expect(config.daemon.port).toBe(4242);
    expect(config.stt?.provider).toBe('sarvam');
    expect(config.personality.assistant_name).toBe('Edith');
    // Merge over defaults kept the untouched personality fields.
    expect(config.personality.core_traits).toEqual(DEFAULT_CONFIG.personality.core_traits);
  });
});
