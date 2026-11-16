/**
 * POST /api/awareness/toggle starts a service that watches the screen, so it
 * takes only a real boolean. "false" as a string used to start it.
 *
 * It is also the same switch as the pebble long-press: it sets and persists
 * awareness.enabled and runs the awareness applier (service, cards, pebble
 * glyph, observer pause). Toggling only the service left the setting and the
 * guards that read it saying the opposite.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { getSetting } from '../vault/settings.ts';
import { bindScreenCaptureSwitch, isScreenCaptureEnabled, setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function setup(opts: { config?: JarvisConfig; reload?: boolean } = {}) {
  const config = opts.config ?? structuredClone(DEFAULT_CONFIG);
  const calls: boolean[] = [];
  const applied: string[] = [];
  const awarenessService = { toggle: (v: boolean) => { calls.push(v); } } as unknown as ApiContext['awarenessService'];
  const settingsReload = opts.reload === false ? undefined : {
    // Stands in for the daemon's awareness applier: it reads the live config.
    applyNow: async (section: string) => {
      applied.push(section);
      calls.push(config.awareness?.enabled !== false);
      return null;
    },
  };
  const routes = createApiRoutes({ awarenessService, config, settingsReload } as unknown as ApiContext) as Record<string, any>;
  const post = (raw: string) => (routes['/api/awareness/toggle'].POST as Handler)(
    new Request('http://local/api/awareness/toggle', { method: 'POST', body: raw }));
  return { calls, applied, config, post };
}

const stored = () => {
  const raw = getSetting('cfg.awareness');
  return raw === null ? null : JSON.parse(raw) as { enabled?: unknown; enabled_chosen_at?: unknown };
};

describe('POST /api/awareness/toggle', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => {
    setScreenCaptureEnabledSource(null);
    closeDb();
  });

  test('a non-boolean enabled is refused with 400 and does not change anything', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.awareness!.enabled = false;
    bindScreenCaptureSwitch(config);
    const { calls, applied, post } = setup({ config });
    for (const raw of ['{"enabled":"false"}', '{"enabled":"true"}', '{"enabled":1}', '{"enabled":0}',
      '{"enabled":null}', '{"enabled":[]}', '{"enabled":{}}', '{}', 'null']) {
      const res = await post(raw);
      expect(`${raw}: ${res.status}`).toBe(`${raw}: 400`);
    }
    expect((await post('not json')).status).toBe(400);
    expect(calls).toEqual([]);
    expect(applied).toEqual([]);
    expect(isScreenCaptureEnabled()).toBe(false);
    expect(stored()).toBeNull();
  });

  test('off and on set the live switch, persist the choice and run the awareness applier', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    bindScreenCaptureSwitch(config);
    const { calls, applied, post } = setup({ config });

    const off = await post('{"enabled":false}');
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, enabled: false });
    // The guards (screen reads, history, held research) read this switch.
    expect(isScreenCaptureEnabled()).toBe(false);
    expect(stored()).toMatchObject({ enabled: false });
    expect(typeof stored()!.enabled_chosen_at).toBe('number');

    expect((await post('{"enabled":true}')).status).toBe(200);
    expect(isScreenCaptureEnabled()).toBe(true);
    expect(stored()).toMatchObject({ enabled: true });

    expect(applied).toEqual(['awareness', 'awareness']);
    expect(calls).toEqual([false, true]);
  });

  test('without a settings coordinator the service itself is still switched', async () => {
    const { calls, config, post } = setup({ reload: false });
    expect((await post('{"enabled":false}')).status).toBe(200);
    expect(config.awareness!.enabled).toBe(false);
    expect(calls).toEqual([false]);
  });

  test('a store that cannot be written: off still takes effect, on is refused', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    bindScreenCaptureSwitch(config);
    const { calls, applied, post } = setup({ config });
    closeDb(); // every setSetting now throws

    const off = await post('{"enabled":false}');
    expect(off.status).toBe(500);
    expect(isScreenCaptureEnabled()).toBe(false);
    expect(applied).toEqual(['awareness']);
    expect(calls).toEqual([false]);

    const on = await post('{"enabled":true}');
    expect(on.status).toBe(500);
    expect(isScreenCaptureEnabled()).toBe(false);
    expect(applied).toEqual(['awareness']);
    expect(calls).toEqual([false]);
  });
});
