import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { EmergencyController } from '../authority/emergency.ts';
import { createEmergencyPersister } from '../authority/emergency-persistence.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
const getDbQueryOnly = (on: boolean) => getDb().exec(`PRAGMA query_only=${on ? 'ON' : 'OFF'}`);
import { HealthMonitor } from './health.ts';
import { ServiceRegistry } from './services.ts';
import { noteStorageFailure, resetStorageStatus, STORAGE_FULL_MESSAGE } from '../vault/storage-health.ts';

type Handler = (req: Request) => Response | Promise<Response>;
const post = (routes: Record<string, unknown>, path: string) => ((routes[path] as { POST: Handler }).POST)(new Request('http://x' + path, { method: 'POST' }));

function setup(diskFull: boolean) {
  const controller = new EmergencyController();
  let full = diskFull;
  const persist = createEmergencyPersister({
    controller,
    save: () => { if (full) throw new Error('database or disk is full'); },
    describe: () => 'the disk is full',
    setTimer: () => 0,
    clearTimer: () => {},
  });
  controller.setStateChangeCallback(() => { persist(); });
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: new HealthMonitor(new ServiceRegistry(), ':memory:'),
    config: {} as ApiContext['config'],
    emergencyController: controller,
    authorityEngine: { getConfig: () => ({}) },
  } as unknown as ApiContext);
  return { routes, controller, free: () => { full = false; persist(); } };
}

beforeEach(() => { resetStorageStatus(); closeDb(); initDatabase(':memory:', { quiet: true }); });
afterEach(() => { resetStorageStatus(); closeDb(); });

describe('Pause and Kill when the state cannot be saved', () => {
  test('Pause stays in effect and says it will not survive a restart', async () => {
    const { routes, controller } = setup(true);
    const res = await post(routes, '/api/authority/emergency/pause');
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.state).toBe('paused');
    expect(controller.getState()).toBe('paused');
    expect(body.saved).toBe(false);
    expect(String(body.warning)).toContain('could not save');
    expect(String(body.warning)).toContain('disk is full');
    expect(String(body.warning)).not.toMatch(/SQLite|SQLITE/);
    const status = await (routes['/api/authority/status'] as { GET: Handler }).GET(new Request('http://x')) as Response;
    expect((await status.json() as Record<string, unknown>).emergency_saved).toBe(false);
  });

  test('Kill says so too, and the warning clears once a retry saves it', async () => {
    const { routes, free, controller } = setup(true);
    const body = await (await post(routes, '/api/authority/emergency/kill')).json() as Record<string, unknown>;
    expect(body.saved).toBe(false);
    free();
    expect(controller.persistence().saved).toBe(true);
    const status = await ((routes['/api/authority/status'] as { GET: Handler }).GET(new Request('http://x')) as Response).json() as Record<string, unknown>;
    expect(status.emergency_saved).toBe(true);
  });

  test('a normal save answers saved without a warning', async () => {
    const { routes } = setup(false);
    const body = await (await post(routes, '/api/authority/emergency/pause')).json() as Record<string, unknown>;
    expect(body).toEqual({ ok: true, state: 'paused', saved: true });
  });
});

describe('health reports whether Jarvis can save', () => {
  test('writable normally, not writable after a full-disk failure', async () => {
    const { routes } = setup(false);
    const read = async () => await ((routes['/api/health'] as { GET: Handler }).GET(new Request('http://x')) as Response).json() as { storage: { writable: boolean; message: string | null } };
    expect((await read()).storage).toMatchObject({ writable: true, message: null });
    noteStorageFailure(new Error('database or disk is full'));
    getDbQueryOnly(true);
    expect((await read()).storage).toMatchObject({ writable: false, message: STORAGE_FULL_MESSAGE });
    getDbQueryOnly(false);
    expect((await read()).storage.writable).toBe(true);
  });
});



