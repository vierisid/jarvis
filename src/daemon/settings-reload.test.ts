import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { setSetting } from '../vault/settings.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { SettingsReloadCoordinator, type SettingsAppliedPayload } from './settings-reload.ts';
import { ServiceRegistry, type Service, type ServiceStatus } from './services.ts';

function freshConfig(): JarvisConfig {
  return structuredClone(DEFAULT_CONFIG);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('settings-reload', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  test('sectionChanged runs the applier with the live config', async () => {
    const config = freshConfig();
    const coordinator = new SettingsReloadCoordinator(config);
    const seen: string[] = [];
    coordinator.registerApplier('stt', (cfg) => {
      seen.push(cfg.stt?.provider ?? 'none');
    });

    config.stt = { provider: 'groq' };
    coordinator.sectionChanged('stt');
    await coordinator.whenIdle();

    expect(seen).toEqual(['groq']);
  });

  test('multiple appliers per section all run, in registration order', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    const order: string[] = [];
    coordinator.registerApplier('tts', () => { order.push('a'); });
    coordinator.registerApplier('tts', () => { order.push('b'); });

    await coordinator.applyNow('tts');
    expect(order).toEqual(['a', 'b']);
  });

  test('sectionChanged with no appliers is a no-op', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    coordinator.sectionChanged('desktop');
    await coordinator.whenIdle();
  });

  test('repeat sectionChanged calls coalesce into one applier run', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    let runs = 0;
    coordinator.registerApplier('channels', () => { runs++; }, { debounceMs: 30 });

    coordinator.sectionChanged('channels');
    coordinator.sectionChanged('channels');
    coordinator.sectionChanged('channels');
    await sleep(200);

    expect(runs).toBe(1);
  });

  test('applyNow cancels a pending debounce so nothing runs twice', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    let runs = 0;
    coordinator.registerApplier('channels', () => { runs++; }, { debounceMs: 5_000 });

    coordinator.sectionChanged('channels');
    const err = await coordinator.applyNow('channels');
    expect(err).toBeNull();
    expect(runs).toBe(1);

    // The 5s timer was cancelled — no second run shows up.
    await sleep(50);
    expect(runs).toBe(1);
  });

  test('appliers are serialized: never two in flight at once', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    let inFlight = 0;
    let maxInFlight = 0;
    const slowApplier = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight--;
    };
    coordinator.registerApplier('stt', slowApplier);
    coordinator.registerApplier('tts', slowApplier);

    await Promise.all([coordinator.applyNow('stt'), coordinator.applyNow('tts')]);
    expect(maxInFlight).toBe(1);
  });

  test('a throwing applier surfaces as ApplyError and does not break other sections', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    const payloads: SettingsAppliedPayload[] = [];
    coordinator.setBroadcast((p) => payloads.push(p));
    coordinator.registerApplier('stt', () => {
      throw new Error('boom');
    });
    let ttsRan = false;
    coordinator.registerApplier('tts', () => { ttsRan = true; });

    const err = await coordinator.applyNow('stt');
    expect(err?.section).toBe('stt');
    expect(err?.error).toBe('boom');

    expect(await coordinator.applyNow('tts')).toBeNull();
    expect(ttsRan).toBe(true);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual({ sections: ['stt'], ok: false, errors: [{ section: 'stt', error: 'boom' }] });
    expect(payloads[1]).toEqual({ sections: ['tts'], ok: true, errors: [] });
  });

  test('a throwing applier does not poison the queue for later applies of the same section', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    let calls = 0;
    coordinator.registerApplier('channels', () => {
      calls++;
      if (calls === 1) throw new Error('first fails');
    });

    expect((await coordinator.applyNow('channels'))?.error).toBe('first fails');
    expect(await coordinator.applyNow('channels')).toBeNull();
    expect(calls).toBe(2);
  });

  test('reloadAll picks up an external DB edit and runs only the changed sections', async () => {
    const config = freshConfig();
    const coordinator = new SettingsReloadCoordinator(config);
    const applied: string[] = [];
    coordinator.registerApplier('stt', () => { applied.push('stt'); });
    coordinator.registerApplier('tts', () => { applied.push('tts'); });

    // Simulate an edit made OUTSIDE the daemon (sqlite3 CLI): raw row write,
    // no saveUserSection listener fires.
    setSetting('cfg.stt', JSON.stringify({ provider: 'sarvam', sarvam: { api_key: 'sk-1' } }));

    const result = await coordinator.reloadAll();

    expect(result.changed).toContain('stt');
    expect(result.changed).not.toContain('tts');
    expect(result.applied).toContain('stt');
    expect(result.errors).toEqual([]);
    expect(applied).toContain('stt');
    expect(applied).not.toContain('tts');
    expect(config.stt?.provider).toBe('sarvam');
  });

  test('reloadAll is stable: a second run with no DB change reports nothing changed', async () => {
    const config = freshConfig();
    const coordinator = new SettingsReloadCoordinator(config);
    setSetting('cfg.tts', JSON.stringify({ enabled: true, provider: 'edge' }));

    const first = await coordinator.reloadAll();
    expect(first.changed).toContain('tts');

    const second = await coordinator.reloadAll();
    expect(second.changed).toEqual([]);
    expect(second.applied).toEqual([]);
  });

  test('reloadAll cancels a pending scheduled apply for a changed section', async () => {
    const config = freshConfig();
    const coordinator = new SettingsReloadCoordinator(config);
    let runs = 0;
    coordinator.registerApplier('stt', () => { runs++; }, { debounceMs: 5_000 });

    setSetting('cfg.stt', JSON.stringify({ provider: 'groq' }));
    coordinator.sectionChanged('stt'); // scheduled 5s out
    await coordinator.reloadAll();     // runs the applier itself

    expect(runs).toBe(1);
    await sleep(50);
    expect(runs).toBe(1); // debounce timer was cancelled
  });

  test('reloadAll broadcasts one batch with every changed section', async () => {
    const config = freshConfig();
    const coordinator = new SettingsReloadCoordinator(config);
    const payloads: SettingsAppliedPayload[] = [];
    coordinator.setBroadcast((p) => payloads.push(p));

    setSetting('cfg.stt', JSON.stringify({ provider: 'groq' }));
    setSetting('cfg.active_role', JSON.stringify('researcher'));
    await coordinator.reloadAll();

    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.sections).toContain('stt');
    expect(payloads[0]!.sections).toContain('active_role');
    expect(payloads[0]!.ok).toBe(true);
  });

  test('channels-style applier: stop-then-start through a real ServiceRegistry', async () => {
    const calls: string[] = [];
    let failNextStart = false;
    let status: ServiceStatus = 'stopped';
    const stub: Service = {
      name: 'channels',
      async start() {
        calls.push('start');
        if (failNextStart) {
          failNextStart = false;
          throw new Error('connect refused');
        }
        status = 'running';
      },
      async stop() {
        calls.push('stop');
        status = 'stopped';
      },
      status: () => status,
    };
    const registry = new ServiceRegistry();
    registry.register(stub);
    await registry.startService('channels');
    calls.length = 0;

    const coordinator = new SettingsReloadCoordinator(freshConfig());
    coordinator.registerApplier('channels', async () => {
      await registry.stopService('channels');
      await registry.startService('channels');
    });

    expect(await coordinator.applyNow('channels')).toBeNull();
    expect(calls).toEqual(['stop', 'start']);

    // A failed start surfaces as an ApplyError but leaves the queue usable.
    failNextStart = true;
    const err = await coordinator.applyNow('channels');
    expect(err?.error).toBe('connect refused');
    expect(await coordinator.applyNow('channels')).toBeNull();
  });

  test('a broken broadcast callback never breaks the apply', async () => {
    const coordinator = new SettingsReloadCoordinator(freshConfig());
    coordinator.setBroadcast(() => {
      throw new Error('ws down');
    });
    let ran = false;
    coordinator.registerApplier('tts', () => { ran = true; });

    expect(await coordinator.applyNow('tts')).toBeNull();
    expect(ran).toBe(true);
  });
});
