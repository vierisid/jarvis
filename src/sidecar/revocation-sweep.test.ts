import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { SidecarManager } from './manager.ts';
import { enrollDevice } from './enrollment.ts';

let dataDir: string;
let manager: SidecarManager;

function fakeConnection() {
  const state = { closed: false };
  return {
    state,
    conn: { close: () => { state.closed = true; } },
  };
}

/** Wire a fake live session into the manager's private connection map. */
function attachFake(m: SidecarManager, sid: string) {
  const { state, conn } = fakeConnection();
  (m as unknown as { sidecarConnections: Map<string, unknown> }).sidecarConnections.set(sid, conn);
  return state;
}

function liveCount(m: SidecarManager): number {
  return (m as unknown as { sidecarConnections: Map<string, unknown> }).sidecarConnections.size;
}

describe('revocation severs live sessions (review finding)', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-revoke-'));
    initDatabase(':memory:');
    manager = new SidecarManager(dataDir);
  });

  afterEach(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('sweep leaves enrolled sessions alone', async () => {
    const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
    });
    const state = attachFake(manager, sidecar.id);

    expect(manager.sweepRevokedConnections()).toBe(0);
    expect(state.closed).toBe(false);
    expect(liveCount(manager)).toBe(1);
  });

  test('CLI-style revocation (row deleted by another process) is severed by the sweep', async () => {
    const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
    });
    const state = attachFake(manager, sidecar.id);

    // What `jarvis revoke` does from its own process: delete the row.
    getDb().run('DELETE FROM sidecars WHERE id = ?', [sidecar.id]);

    expect(manager.sweepRevokedConnections()).toBe(1);
    expect(state.closed).toBe(true);
    expect(liveCount(manager)).toBe(0);
  });

  test('dashboard revokeSidecar disconnects the live session immediately', async () => {
    const { sidecar } = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
    });
    const state = attachFake(manager, sidecar.id);

    expect(manager.revokeSidecar(sidecar.id)).toBe(true);
    expect(state.closed).toBe(true);
    expect(liveCount(manager)).toBe(0);
    expect(manager.isEnrolled(sidecar.id)).toBe(false);
  });
});
