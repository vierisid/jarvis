import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { SidecarManager, parseUpdateProgress, sanitizeFeatures } from './manager.ts';
import { enrollDevice } from './enrollment.ts';
import { SIDECAR_LATEST_VERSION, SIDECAR_MIN_VERSION } from './compat.ts';

/**
 * The self-update half of the register handshake: the brain tells every
 * connecting sidecar which version it ships with (register_ack / _rejected
 * `latest`), records the optional features the sidecar advertises, and keeps
 * the sidecar's reported update progress for the dashboard.
 */

let dataDir: string;
let manager: SidecarManager;

/** A fake sidecar socket: records what the brain sends and whether it closed. */
function fakeSocket(sidecarId: string) {
  const sent: Record<string, unknown>[] = [];
  let closedWith: number | null = null;
  const ws = {
    data: { sidecar_id: sidecarId },
    send: (raw: string) => { sent.push(JSON.parse(raw)); },
    close: (code?: number) => { closedWith = code ?? 1000; },
    ping: () => {},
  };
  return { ws: ws as any, sent, closed: () => closedWith };
}

async function enrolled(): Promise<string> {
  const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'laptop', { onExisting: 'upsert' });
  return sidecar.id;
}

function register(ws: any, fields: Record<string, unknown>) {
  manager.handleSidecarMessage(ws, JSON.stringify({
    type: 'register', hostname: 'laptop', os: 'windows', platform: 'amd64', capabilities: [], ...fields,
  }));
}

describe('register handshake: self-update', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-reg-update-'));
    initDatabase(':memory:');
    manager = new SidecarManager(dataDir);
  });

  afterEach(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('every accepted registration is acked with the version this brain ships with', async () => {
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: '0.9.7', features: ['update_prompt', 'update_apply'] });

    const ack = s.sent.find((m) => m.type === 'register_ack');
    expect(ack).toMatchObject({ type: 'register_ack', update_status: 'ok', latest: SIDECAR_LATEST_VERSION });
    // Not 'suggested': the legacy fields stay off so older sidecars log nothing.
    expect(ack?.update_suggested).toBeUndefined();
    expect(s.closed()).toBeNull();

    const info = manager.getSidecar(id)!;
    expect(info.features).toEqual(['update_prompt', 'update_apply']);
    expect(info.latest_version).toBe(SIDECAR_LATEST_VERSION);
    expect(info.update_available).toBe(true);
  });

  test('a current sidecar is acked too, and is not behind', async () => {
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: SIDECAR_LATEST_VERSION });

    expect(s.sent.find((m) => m.type === 'register_ack')?.latest).toBe(SIDECAR_LATEST_VERSION);
    const info = manager.getSidecar(id)!;
    expect(info.update_available).toBe(false);
    expect(info.features).toEqual([]);
  });

  test('a dev build is never offered an update', async () => {
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: 'dev' });
    expect(s.sent.find((m) => m.type === 'register_ack')?.update_status).toBe('dev');
    expect(manager.getSidecar(id)!.update_available).toBe(false);
  });

  test('a rejected sidecar is told what to update to', async () => {
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: '0.0.1' });

    // Only meaningful while MIN is above 0.0.1, which it always will be.
    expect(SIDECAR_MIN_VERSION).not.toBe('0.0.1');
    expect(s.sent.find((m) => m.type === 'register_rejected')).toMatchObject({
      reason: 'incompatible', min: SIDECAR_MIN_VERSION, your_version: '0.0.1', latest: SIDECAR_LATEST_VERSION,
    });
    expect(s.closed()).toBe(4001);
    expect(manager.isConnected(id)).toBe(false);
  });

  test('update progress lands on the live connection and in the API view', async () => {
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: '0.9.7', features: ['update_apply'] });

    manager.recordUpdateProgress(id, { phase: 'failed', version: '0.10.0', error: 'EACCES', manual_command: 'bun add -g @usejarvis/sidecar@0.10.0' });
    expect(manager.getSidecar(id)!.update_state).toMatchObject({
      phase: 'failed', version: '0.10.0', error: 'EACCES', manual_command: 'bun add -g @usejarvis/sidecar@0.10.0',
    });

    // Garbage is ignored rather than overwriting what the dashboard shows.
    manager.recordUpdateProgress(id, { phase: 'exploded' });
    expect(manager.getSidecar(id)!.update_state?.phase).toBe('failed');
  });
});

describe('update progress through the event pipeline', () => {
  let started: SidecarManager | null = null;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-reg-update-'));
    initDatabase(':memory:');
    manager = new SidecarManager(dataDir);
  });
  afterEach(async () => {
    if (started) await started.stop();
    started = null;
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  // End to end through the socket: a sidecar_event frame, the validator, the
  // scheduler (update_progress is a direct type) and the manager's handler.
  // Dropping the type from SIDECAR_EVENT_TYPES would silently lose it.
  test('an update_progress frame reaches the API view', async () => {
    await manager.start();
    started = manager;
    const id = await enrolled();
    const s = fakeSocket(id);
    manager.handleSidecarConnect(s.ws, id);
    register(s.ws, { version: '0.9.7', features: ['update_apply'] });
    manager.handleSidecarMessage(s.ws, JSON.stringify({
      type: 'sidecar_event', event_type: 'update_progress', timestamp: Date.now(),
      payload: { phase: 'downloading', version: SIDECAR_LATEST_VERSION },
    }));
    for (let i = 0; i < 100 && !manager.getSidecar(id)!.update_state; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(manager.getSidecar(id)!.update_state).toMatchObject({ phase: 'downloading', version: SIDECAR_LATEST_VERSION });
  });
});

describe('reconnect overlap', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-reg-update-'));
    initDatabase(':memory:');
    manager = new SidecarManager(dataDir);
  });
  afterEach(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  // A sidecar that restarted itself (an update) can connect again before its
  // old socket's close arrives. That late close must not drop the new one.
  test("the old socket's late close keeps the newer connection", async () => {
    const id = await enrolled();
    const oldSock = fakeSocket(id);
    manager.handleSidecarConnect(oldSock.ws, id);
    register(oldSock.ws, { version: '0.9.7' });

    const newSock = fakeSocket(id);
    manager.handleSidecarConnect(newSock.ws, id);
    register(newSock.ws, { version: SIDECAR_LATEST_VERSION });
    expect(oldSock.closed()).not.toBeNull(); // retired when the new one arrived

    manager.handleSidecarDisconnect(id, oldSock.ws);
    expect(manager.isConnected(id)).toBe(true);
    expect(manager.getSidecar(id)!.version).toBe(SIDECAR_LATEST_VERSION);
    expect(newSock.closed()).toBeNull();

    manager.handleSidecarDisconnect(id, newSock.ws);
    expect(manager.isConnected(id)).toBe(false);
  });
});

describe('sanitizeFeatures', () => {
  test('keeps identifier-like strings, once', () => {
    expect(sanitizeFeatures(['update_prompt', 'update_apply', 'update_prompt'])).toEqual(['update_prompt', 'update_apply']);
  });
  test('drops everything else', () => {
    expect(sanitizeFeatures('update_prompt')).toEqual([]);
    expect(sanitizeFeatures([1, null, '', '<img src=x>', 'UPPER', 'x'.repeat(80)])).toEqual([]);
  });
  test('is bounded', () => {
    expect(sanitizeFeatures(Array.from({ length: 100 }, (_, i) => `f${i}`))).toHaveLength(32);
  });
});

describe('parseUpdateProgress', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  test('accepts a known phase and bounds the strings', () => {
    const p = parseUpdateProgress({ phase: 'downloading', version: '0.10.0', error: 'x'.repeat(5000) }, now)!;
    expect(p.phase).toBe('downloading');
    expect(p.at).toBe(now.toISOString());
    expect(p.error!.length).toBeLessThanOrEqual(1001);
  });
  test('rejects unknown phases and non-objects', () => {
    expect(parseUpdateProgress({ phase: 'nope' }, now)).toBeNull();
    expect(parseUpdateProgress(null, now)).toBeNull();
    expect(parseUpdateProgress('failed', now)).toBeNull();
  });
});
