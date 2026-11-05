/**
 * #1159: desktop.enabled (#905) could only be set in config.yaml, and a change
 * took a restart. A hosted install has no config.yaml it can edit, so it
 * could not turn desktop control off at all. POST /api/config/desktop sets it
 * from Settings and applies it at once; GET /api/config reports it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { bindDesktopSwitch, isDesktopEnabled, setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function route(config: JarvisConfig, applied: string[] = []): { get: Handler; post: Handler } {
  const ctx = {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config,
    agentService: {} as ApiContext['agentService'],
    settingsReload: { applyNow: async (section: string) => { applied.push(section); return null; } },
  } as unknown as ApiContext;
  const routes = createApiRoutes(ctx) as Record<string, { GET?: Handler; POST?: Handler }>;
  return { get: routes['/api/config']!.GET!, post: routes['/api/config/desktop']?.POST ?? (() => new Response('no route', { status: 404 })) };
}

const post = (handler: Handler, body: unknown) => handler(new Request('http://x/api/config/desktop', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

describe('desktop.enabled from Settings (#1159)', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => {
    setDesktopEnabledSource(null);
    closeDb();
  });

  test('GET /api/config reports the switch: on by default, off when set off', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    delete (config as { desktop?: unknown }).desktop;
    expect(((await (await route(config).get(new Request('http://x/api/config'))).json()) as { desktop?: unknown }).desktop).toEqual({ enabled: true });
    config.desktop = { enabled: false };
    expect(((await (await route(config).get(new Request('http://x/api/config'))).json()) as { desktop?: unknown }).desktop).toEqual({ enabled: false });
  });

  test('turning it off applies at once, persists only the one key, and runs the desktop applier', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    bindDesktopSwitch(config);
    expect(isDesktopEnabled()).toBe(true);
    const applied: string[] = [];
    const res = await post(route(config, applied).post, { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, enabled: false });
    // Live: the very object the switch is bound to now reads off.
    expect(isDesktopEnabled()).toBe(false);
    expect(JSON.parse(getSetting('cfg.desktop')!)).toEqual({ enabled: false });
    expect(applied).toEqual(['desktop']);

    // And back on.
    expect((await post(route(config, applied).post, { enabled: true })).status).toBe(200);
    expect(isDesktopEnabled()).toBe(true);
    expect(JSON.parse(getSetting('cfg.desktop')!)).toEqual({ enabled: true });
  });

  test('other keys already in the stored row are kept', async () => {
    setSetting('cfg.desktop', JSON.stringify({ enabled: true, note: 'kept' }));
    const config = structuredClone(DEFAULT_CONFIG);
    expect((await post(route(config).post, { enabled: false })).status).toBe(200);
    expect(JSON.parse(getSetting('cfg.desktop')!)).toEqual({ enabled: false, note: 'kept' });
  });

  test('a wrong-shape section (desktop: false in the file) is replaced by the choice', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    (config as { desktop?: unknown }).desktop = false;
    bindDesktopSwitch(config);
    expect(isDesktopEnabled()).toBe(false);
    expect((await post(route(config).post, { enabled: true })).status).toBe(200);
    expect(isDesktopEnabled()).toBe(true);
  });

  test('anything but a boolean is refused and changes nothing', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.desktop = { enabled: false };
    bindDesktopSwitch(config);
    for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}, { enabled: null }]) {
      const res = await post(route(config).post, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(isDesktopEnabled()).toBe(false);
    expect(getSetting('cfg.desktop')).toBeNull();
  });
});

test('the daemon desktop applier re-pushes the pebble glyph, so a Settings toggle shows on every pebble', async () => {
  // startDaemon cannot be booted in a unit test (see desktop-guard.test.ts);
  // this pins the push inside the applier the route runs.
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
  const start = source.indexOf("settingsReload.registerApplier('desktop'");
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('\n    });', start));
  expect(block).toContain('pushPebbleBlinded(pebbleBlindDeps, pebbleBlinded(');
  expect(block).toContain('isDesktopEnabled()');
});

describe('a settings store that cannot be written (#1159 security review)', () => {
  afterEach(() => setDesktopEnabledSource(null));

  test('turning it off still takes effect now, and says the save failed', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    bindDesktopSwitch(config);
    const applied: string[] = [];
    closeDb(); // every setSetting now throws
    const res = await post(route(config, applied).post, { enabled: false });
    expect(isDesktopEnabled()).toBe(false);
    expect(applied).toEqual(['desktop']);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/off for now.*could not be saved.*restart or settings reload/i);
  });

  test('turning it on is not applied when it cannot be saved', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.desktop = { enabled: false };
    bindDesktopSwitch(config);
    closeDb();
    const res = await post(route(config).post, { enabled: true });
    expect(isDesktopEnabled()).toBe(false);
    expect(res.status).toBe(500);
  });
});
