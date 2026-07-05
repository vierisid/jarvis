import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { SidecarManager } from './manager.ts';
import { enrollDevice } from './enrollment.ts';
import type { ConnectedSidecar } from './types.ts';

let dataDir: string;
let manager: SidecarManager;

function connected(sid: string, timezone?: string): ConnectedSidecar {
  return {
    id: sid,
    name: 'desktop-A',
    hostname: 'desktop-A',
    os: 'linux',
    platform: 'amd64',
    version: '1.0.0',
    updateStatus: 'ok' as ConnectedSidecar['updateStatus'],
    capabilities: [],
    unavailableCapabilities: [],
    timezone,
    connectedAt: new Date(),
  };
}

describe('sidecar timezone reporting', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-tz-'));
    initDatabase(':memory:');
    manager = new SidecarManager(dataDir);
  });

  afterEach(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('register persists the reported IANA timezone on the device row', async () => {
    const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
    });
    manager.registerConnection(connected(sidecar.id, 'Europe/Rome'));

    const row = getDb().query('SELECT timezone FROM sidecars WHERE id = ?').get(sidecar.id) as {
      timezone: string | null;
    };
    expect(row.timezone).toBe('Europe/Rome');
  });

  test('a re-register WITHOUT a timezone keeps the previously reported one (COALESCE)', async () => {
    const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
    });
    manager.registerConnection(connected(sidecar.id, 'Europe/Rome'));
    // Old sidecar build (or detection failure) reports nothing.
    manager.registerConnection(connected(sidecar.id, undefined));

    const row = getDb().query('SELECT timezone FROM sidecars WHERE id = ?').get(sidecar.id) as {
      timezone: string | null;
    };
    expect(row.timezone).toBe('Europe/Rome');
  });
});
