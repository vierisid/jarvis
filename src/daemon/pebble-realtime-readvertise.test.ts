import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { wireRealtimeReadvertisement } from './pebble-realtime.ts';
import { SettingsReloadCoordinator } from './settings-reload.ts';
import { persistUserPatch, setSectionSavedListener } from './user-settings.ts';

/**
 * A connected pebble keeps the configure_realtime verdict it was sent, so a
 * realtime toggle must re-push it. On 2026-09-10 realtime was switched on in
 * Settings and every summon still ran the one-shot pipeline: a `voice` save
 * had no applier, and the advertisement went out again only on reconnect or a
 * full reload.
 */
describe('wireRealtimeReadvertisement', () => {
  let secretsDir: string;
  let prevSecretsDir: string | undefined;
  let coordinator: SettingsReloadCoordinator;
  let wiring: { settled: () => Promise<void> };
  let pushes: number;

  beforeEach(() => {
    prevSecretsDir = process.env.JARVIS_SECRETS_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), 'jarvis-readvertise-'));
    process.env.JARVIS_SECRETS_DIR = secretsDir;
    initDatabase(':memory:');
    coordinator = new SettingsReloadCoordinator(structuredClone(DEFAULT_CONFIG), {
      googleTokensPath: join(secretsDir, 'google-tokens.json'),
    });
    pushes = 0;
    wiring = wireRealtimeReadvertisement(coordinator, async () => {
      pushes++;
    });
    // The daemon's choke-point hook (daemon/index.ts), so a save reaches the
    // coordinator exactly the way POST /api/config/voice's does.
    setSectionSavedListener((section) => coordinator.sectionChanged(section));
  });

  afterEach(() => {
    setSectionSavedListener(null);
    closeDb();
    if (prevSecretsDir === undefined) delete process.env.JARVIS_SECRETS_DIR;
    else process.env.JARVIS_SECRETS_DIR = prevSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('saving the voice section (the realtime toggle) re-pushes the advertisement', async () => {
    persistUserPatch('voice', { realtime: { enabled: true } });
    await coordinator.whenIdle();
    await wiring.settled();
    expect(pushes).toBe(1);
  });

  test('a burst of voice saves coalesces into one push', async () => {
    persistUserPatch('voice', { realtime: { enabled: true } });
    persistUserPatch('voice', { realtime: { enabled: false } });
    await coordinator.whenIdle();
    await wiring.settled();
    expect(pushes).toBe(1);
  });

  test('another section changing does not re-push', async () => {
    coordinator.sectionChanged('awareness');
    await coordinator.whenIdle();
    await wiring.settled();
    expect(pushes).toBe(0);
  });

  test('a full reload re-pushes too (SIGHUP and POST /api/config/reload)', async () => {
    await coordinator.reloadAll();
    await wiring.settled();
    expect(pushes).toBe(1);
  });

  test('requests made while a push waits to start collapse into it', async () => {
    // A half-open sidecar parks the first push; repeated reloads meanwhile
    // must queue ONE more push (it reads the latest config), not one each.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const slow = new SettingsReloadCoordinator(structuredClone(DEFAULT_CONFIG), {
      googleTokensPath: join(secretsDir, 'google-tokens.json'),
    });
    const slowWiring = wireRealtimeReadvertisement(slow, async () => {
      started++;
      if (started === 1) await gate;
    });
    await slow.reloadAll(); // push 1 starts and parks
    await slow.reloadAll(); // queues push 2
    await slow.reloadAll(); // collapses into push 2
    await slow.reloadAll(); // collapses into push 2
    release();
    await slowWiring.settled();
    expect(started).toBe(2);
  });

  test('a slow push never holds up the coordinator queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new SettingsReloadCoordinator(structuredClone(DEFAULT_CONFIG), {
      googleTokensPath: join(secretsDir, 'google-tokens.json'),
    });
    const slowWiring = wireRealtimeReadvertisement(slow, () => gate);
    let otherApplied = false;
    slow.registerApplier('awareness', () => {
      otherApplied = true;
    });
    slow.sectionChanged('voice');
    slow.sectionChanged('awareness');
    // Resolves even though the push is still parked on its RPC.
    await slow.whenIdle();
    expect(otherApplied).toBe(true);
    release();
    await slowWiring.settled();
  });
});
