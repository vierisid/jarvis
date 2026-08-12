/**
 * Section credentials — STT/TTS API keys and channel bot tokens — must live in
 * the encrypted keychain, never in the plaintext `settings` table, the same
 * split llm-settings.ts applies to provider keys.
 *
 * The keychain writes to `~/.jarvis`, so every test redirects it to a
 * throwaway dir via JARVIS_SECRETS_DIR — never the developer's real store.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { getSecret, setSecret } from '../vault/keychain.ts';
import {
  saveUserSection,
  loadUserSection,
  importLegacyUserSettings,
  mergeUserSettingsIntoConfig,
} from './user-settings.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';

function freshConfig(): JarvisConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** Raw bytes of the row as stored — the assertion that matters for leaks. */
function rawRow(section: 'stt' | 'tts' | 'channels'): string {
  return getSetting(`cfg.${section}`) ?? '';
}

describe('section secrets (stt/tts keys, channel tokens)', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-section-secrets-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('save keeps the key out of the settings row and in the keychain', () => {
    saveUserSection('stt', { provider: 'groq', groq: { api_key: 'gk-secret', model: 'whisper' } });

    expect(rawRow('stt')).not.toContain('gk-secret');
    expect(loadUserSection('stt')).toEqual({ provider: 'groq', groq: { model: 'whisper' } });
    expect(getSecret('stt.groq.api_key')).toBe('gk-secret');

    // ...and the secrets file on disk is ciphertext, not the key in the clear.
    const enc = join(secretsDir, '.secrets.enc');
    expect(existsSync(enc)).toBe(true);
    expect(readFileSync(enc).toString('latin1')).not.toContain('gk-secret');
  });

  test('channels: bot tokens round-trip through the keychain, not the row', () => {
    saveUserSection('channels', {
      telegram: { enabled: true, bot_token: 'tg-token', allowed_users: [42] },
      discord: { enabled: true, bot_token: 'dc-token', allowed_users: ['u1'], guild_id: 'g1' },
    });

    const row = rawRow('channels');
    expect(row).not.toContain('tg-token');
    expect(row).not.toContain('dc-token');
    // Non-secret channel settings stay in the row.
    expect(row).toContain('42');
    expect(getSecret('channels.telegram.bot_token')).toBe('tg-token');
    expect(getSecret('channels.discord.bot_token')).toBe('dc-token');

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    expect(config.channels?.telegram?.bot_token).toBe('tg-token');
    expect(config.channels?.telegram?.allowed_users).toEqual([42]);
    expect(config.channels?.discord?.bot_token).toBe('dc-token');
    expect(config.channels?.discord?.guild_id).toBe('g1');
  });

  test('channels: a legacy plaintext row migrates on the next hydration', () => {
    setSetting('cfg.channels', JSON.stringify({
      telegram: { enabled: true, bot_token: 'legacy-tg', allowed_users: [7] },
      discord: { enabled: false, bot_token: '', allowed_users: [] },
    }));

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    expect(rawRow('channels')).not.toContain('legacy-tg');
    expect(getSecret('channels.telegram.bot_token')).toBe('legacy-tg');
    expect(config.channels?.telegram?.bot_token).toBe('legacy-tg');
    // An empty token was never a credential — nothing stored for it.
    expect(getSecret('channels.discord.bot_token')).toBeNull();
    expect(config.channels?.telegram?.enabled).toBe(true);
  });

  test('channels: the real route path keeps the token out of the row', async () => {
    const config = freshConfig();
    const ctx = {
      daemonStartedAt: Date.now(),
      healthMonitor: {},
      config,
    } as unknown as ApiContext;
    const route = createApiRoutes(ctx)['/api/config/channels'] as {
      GET: () => Response;
      POST: (req: Request) => Promise<Response>;
    };

    const saved = await route.POST(new Request('http://x/api/config/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram: { enabled: true, bot_token: 'tg-http', allowed_users: [1] } }),
    }));
    expect(await saved.json()).toMatchObject({ ok: true });

    expect(rawRow('channels')).not.toContain('tg-http');
    expect(getSecret('channels.telegram.bot_token')).toBe('tg-http');
    expect(await route.GET().json()).toMatchObject({ telegram: { has_token: true } });

    const rebooted = freshConfig();
    mergeUserSettingsIntoConfig(rebooted);
    expect(rebooted.channels?.telegram?.bot_token).toBe('tg-http');
  });

  test('merge injects the stored key back into the in-memory config', () => {
    saveUserSection('stt', { provider: 'openai', openai: { api_key: 'sk-1' } });
    saveUserSection('tts', {
      enabled: true,
      provider: 'elevenlabs',
      elevenlabs: { api_key: 'el-1', voice_id: 'v1' },
    });

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    expect(config.stt?.openai?.api_key).toBe('sk-1');
    expect(config.tts?.elevenlabs?.api_key).toBe('el-1');
    expect(config.tts?.elevenlabs?.voice_id).toBe('v1');
  });

  test('a secret with no settings row is NOT injected (orphan from another install)', () => {
    // e.g. a default (DB-only) backup restored onto a machine whose keychain
    // still holds the previous install's keys.
    setSecret('tts.sarvam.api_key', 'orphan');

    const config = freshConfig(); // DEFAULT_CONFIG always defines tts
    mergeUserSettingsIntoConfig(config);

    expect(config.tts?.sarvam).toBeUndefined();
  });

  test('an empty key deletes the secret instead of leaving it behind', () => {
    saveUserSection('tts', { enabled: true, provider: 'elevenlabs', elevenlabs: { api_key: 'el-1' } });
    expect(getSecret('tts.elevenlabs.api_key')).toBe('el-1');

    // NB: the HTTP routes cannot produce this — mergeCloudSubBlock falls back
    // to the stored key when the patch sends '' (the GET redacts keys, so
    // every UI round-trip would otherwise wipe them). This covers direct
    // callers and keeps a cleared key from lingering in the keychain.
    saveUserSection('tts', { enabled: true, provider: 'edge', elevenlabs: { api_key: '' } });
    expect(getSecret('tts.elevenlabs.api_key')).toBeNull();

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.tts?.elevenlabs?.api_key).toBeUndefined();
  });

  test('dropping a sub-block deletes its secret (no stale credential)', () => {
    saveUserSection('stt', { provider: 'groq', groq: { api_key: 'gk-1' } });
    saveUserSection('stt', { provider: 'local', local: { endpoint: 'http://127.0.0.1:8080' } });

    expect(getSecret('stt.groq.api_key')).toBeNull();
  });

  test('one provider key is untouched by a save that only changes another', () => {
    saveUserSection('stt', {
      provider: 'openai',
      openai: { api_key: 'sk-1' },
      sarvam: { api_key: 'sv-1' },
    });

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    config.stt!.provider = 'sarvam';
    saveUserSection('stt', config.stt);

    expect(getSecret('stt.openai.api_key')).toBe('sk-1');
    expect(getSecret('stt.sarvam.api_key')).toBe('sv-1');
  });

  test('migration: a plaintext row from an older build moves to the keychain', () => {
    // Exactly what the pre-split build wrote.
    setSetting('cfg.stt', JSON.stringify({ provider: 'openai', openai: { api_key: 'legacy-sk', model: 'whisper-1' } }));
    setSetting('cfg.tts', JSON.stringify({ enabled: true, provider: 'sarvam', sarvam: { api_key: 'legacy-sv' } }));

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);

    // Config still works...
    expect(config.stt?.openai?.api_key).toBe('legacy-sk');
    expect(config.tts?.sarvam?.api_key).toBe('legacy-sv');
    // ...and the plaintext copies are gone from the DB.
    expect(rawRow('stt')).not.toContain('legacy-sk');
    expect(rawRow('tts')).not.toContain('legacy-sv');
    expect(getSecret('stt.openai.api_key')).toBe('legacy-sk');
    expect(getSecret('tts.sarvam.api_key')).toBe('legacy-sv');
    // Non-secret fields survive the rewrite.
    expect(config.stt?.openai?.model).toBe('whisper-1');
    expect(config.tts?.provider).toBe('sarvam');

    // Idempotent: a second hydration changes nothing.
    const row = rawRow('stt');
    const again = freshConfig();
    mergeUserSettingsIntoConfig(again);
    expect(rawRow('stt')).toBe(row);
    expect(again.stt?.openai?.api_key).toBe('legacy-sk');
  });

  test('import: a config.yaml key lands in the keychain, not in any DB row', () => {
    const yaml = { stt: { provider: 'groq', groq: { api_key: 'file-gk' } } };
    expect(importLegacyUserSettings(yaml)).toEqual(['stt']);

    expect(rawRow('stt')).not.toContain('file-gk');
    expect(getSetting('cfg.__import_state')).not.toContain('file-gk');
    expect(getSecret('stt.groq.api_key')).toBe('file-gk');

    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.stt?.groq?.api_key).toBe('file-gk');

    // Unchanged file on the next boot: no re-import, dashboard edits survive.
    expect(importLegacyUserSettings(yaml)).toEqual([]);
  });

  test('import: an EDITED file key still re-imports (digest tracks the change)', () => {
    importLegacyUserSettings({ stt: { provider: 'groq', groq: { api_key: 'file-gk' } } });
    const imported = importLegacyUserSettings({ stt: { provider: 'groq', groq: { api_key: 'file-gk-2' } } });

    expect(imported).toEqual(['stt']);
    expect(getSecret('stt.groq.api_key')).toBe('file-gk-2');
  });

  test('the real route path keeps the key out of the row and still reports it set', async () => {
    const config = freshConfig();
    const ctx = {
      daemonStartedAt: Date.now(),
      healthMonitor: {},
      config,
    } as unknown as ApiContext;
    const routes = createApiRoutes(ctx);
    const route = routes['/api/config/tts'] as {
      GET: () => Response;
      POST: (req: Request) => Promise<Response>;
    };

    const saved = await route.POST(new Request('http://x/api/config/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, provider: 'elevenlabs', elevenlabs: { api_key: 'el-http' } }),
    }));
    expect(await saved.json()).toMatchObject({ ok: true });

    expect(rawRow('tts')).not.toContain('el-http');
    expect(getSecret('tts.elevenlabs.api_key')).toBe('el-http');
    // The dashboard's "key is set" indicator reads the live config.
    expect(await route.GET().json()).toMatchObject({ elevenlabs: { has_api_key: true } });

    // And a restart (fresh hydration) gets the key back.
    const rebooted = freshConfig();
    mergeUserSettingsIntoConfig(rebooted);
    expect(rebooted.tts?.elevenlabs?.api_key).toBe('el-http');
  });

  test('a failed keychain write never destroys the key', () => {
    // Point the keychain at a path that cannot become a directory.
    const blocked = join(secretsDir, 'blocked');
    writeFileSync(blocked, 'not a dir');
    process.env.JARVIS_SECRETS_DIR = blocked;

    // Migration keeps the plaintext row rather than stripping a key the
    // keychain never accepted — the credential still works, and the next
    // hydration retries the move.
    const legacyRow = JSON.stringify({ provider: 'openai', openai: { api_key: 'legacy-sk' } });
    setSetting('cfg.stt', legacyRow);
    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(rawRow('stt')).toBe(legacyRow);
    expect(config.stt?.openai?.api_key).toBe('legacy-sk');

    // A save fails loudly instead of reporting success and writing a row with
    // the key stripped out of both stores.
    expect(() => saveUserSection('tts', {
      enabled: true,
      provider: 'elevenlabs',
      elevenlabs: { api_key: 'el-1' },
    })).toThrow(/keychain/i);
    expect(rawRow('tts')).toBe('');
  });

  test('import: a plaintext key in the import-state row is scrubbed even after the file drops the section', () => {
    setSetting('cfg.__import_state', JSON.stringify({
      stt: JSON.stringify({ provider: 'groq', groq: { api_key: 'file-gk' } }),
    }));

    // The config.yaml no longer carries an `stt` block at all, so the import
    // loop never visits that section.
    expect(importLegacyUserSettings({ personality: { assistant_name: 'Edith' } })).toEqual(['personality']);
    expect(getSetting('cfg.__import_state')).not.toContain('file-gk');
  });

  test('import: the state row is scrubbed with no config.yaml at all, and survives a hand-edited value', () => {
    setSetting('cfg.__import_state', JSON.stringify({
      stt: JSON.stringify({ provider: 'groq', groq: { api_key: 'file-gk' } }),
      channels: 42, // not a string: must not take the boot import down with it
    }));

    // The file is gone (deleted, or unreadable — index.ts passes null then).
    expect(importLegacyUserSettings(null)).toEqual([]);
    expect(getSetting('cfg.__import_state')).not.toContain('file-gk');
  });

  test('a keychain failure is reported as a storage error, not an invalid body', async () => {
    const blocked = join(secretsDir, 'blocked');
    writeFileSync(blocked, 'not a dir');
    process.env.JARVIS_SECRETS_DIR = blocked;

    const ctx = {
      daemonStartedAt: Date.now(),
      healthMonitor: {},
      config: freshConfig(),
    } as unknown as ApiContext;
    const route = createApiRoutes(ctx)['/api/config/channels'] as {
      GET: () => Response;
      POST: (req: Request) => Promise<Response>;
    };

    const res = await route.POST(new Request('http://x/api/config/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram: { enabled: true, bot_token: 'tg-1', allowed_users: [] } }),
    }));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(rawRow('channels')).toBe('');
    // ...and the rejected token is not left in the live config either: the API
    // said it was not saved, so nothing may report it as present or persist it
    // on a later save of the same section.
    expect(ctx.config.channels?.telegram?.bot_token).toBeFalsy();
    expect(await route.GET().json()).toMatchObject({ telegram: { has_token: false } });
  });

  test('import: a pre-digest baseline row is upgraded without re-importing', () => {
    // An instance that baselined under the old behavior: the import-state row
    // holds the raw file JSON, api_key included.
    const yaml = { stt: { provider: 'groq', groq: { api_key: 'file-gk' } } };
    setSetting('cfg.stt', JSON.stringify({ provider: 'openai' }));
    setSetting('cfg.__import_state', JSON.stringify({ stt: JSON.stringify(yaml.stt) }));

    expect(importLegacyUserSettings(yaml)).toEqual([]);
    expect(getSetting('cfg.__import_state')).not.toContain('file-gk');

    // The dashboard value is still the one that wins.
    const config = freshConfig();
    mergeUserSettingsIntoConfig(config);
    expect(config.stt?.provider).toBe('openai');
  });
});
