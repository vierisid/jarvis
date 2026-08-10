import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtVerify, decodeJwt } from 'jose';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import {
  enrollDevice,
  loadOrGenerateSidecarKeys,
  validateSidecarName,
  sidecarKeyPaths,
} from './enrollment.ts';

let dataDir: string;

describe('standalone enrollment', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-enroll-'));
    initDatabase(':memory:');
  });

  afterEach(async () => {
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('mints a verifiable ES256 JWT with self-describing claims and stores the record', async () => {
    const result = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', {
      onExisting: 'upsert',
    });

    expect(result.created).toBe(true);
    const claims = decodeJwt(result.token);
    expect(claims.brain).toBe('wss://u1.vps1.usejarvis.host/sidecar/connect');
    expect(claims.jwks).toBe('https://u1.vps1.usejarvis.host/api/sidecars/.well-known/jwks.json');
    expect(claims.sid).toBe(result.sidecar.id);
    expect(claims.name).toBe('desktop-NA23');

    // Verifies against the persisted public key (what the daemon serves as JWKS).
    const keys = await loadOrGenerateSidecarKeys(dataDir);
    const { payload } = await jwtVerify(result.token, keys.publicKey, { algorithms: ['ES256'] });
    expect(payload.jti).toBe(result.sidecar.token_id);

    const row = getDb().query('SELECT * FROM sidecars WHERE id = ?').get(result.sidecar.id) as {
      name: string;
      status: string;
    };
    expect(row.name).toBe('desktop-NA23');
    expect(row.status).toBe('enrolled');
  });

  test('upsert by name: same device record, fresh jti, both tokens stay valid', async () => {
    const first = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', {
      onExisting: 'upsert',
    });
    const second = await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', {
      onExisting: 'upsert',
    });

    expect(second.created).toBe(false);
    expect(second.sidecar.id).toBe(first.sidecar.id); // same sid: one device
    expect(second.sidecar.token_id).not.toBe(first.sidecar.token_id); // fresh jti

    // Exactly one row for the device.
    const count = getDb().query('SELECT COUNT(*) as n FROM sidecars').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test('re-mint after a brain_domain change points the token at the new host (migration)', async () => {
    await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', { onExisting: 'upsert' });
    const moved = await enrollDevice(dataDir, 'u1.vps2.usejarvis.host', 'desktop-NA23', {
      onExisting: 'upsert',
    });
    expect(decodeJwt(moved.token).brain).toBe('wss://u1.vps2.usejarvis.host/sidecar/connect');
  });

  test('reject mode preserves the dashboard duplicate error', async () => {
    await enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', { onExisting: 'upsert' });
    await expect(
      enrollDevice(dataDir, 'u1.vps1.usejarvis.host', 'desktop-NA23', { onExisting: 'reject' }),
    ).rejects.toThrow(/already enrolled/);
  });

  test('key files persist with tight permissions and reload identically', async () => {
    const a = await loadOrGenerateSidecarKeys(dataDir);
    const b = await loadOrGenerateSidecarKeys(dataDir);
    expect(b.keyId).toBe(a.keyId); // same key on reload, not a regeneration

    const { statSync } = await import('node:fs');
    const paths = sidecarKeyPaths(dataDir);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.privatePem).mode & 0o777).toBe(0o600);
    expect(statSync(paths.publicPem).mode & 0o777).toBe(0o644);
  });

  test('name validation: rules shared with the manager', () => {
    expect(validateSidecarName('  desktop-NA23  ')).toBe('desktop-NA23');
    expect(() => validateSidecarName('')).toThrow(/1-64/);
    expect(() => validateSidecarName('a'.repeat(65))).toThrow(/1-64/);
    expect(() => validateSidecarName('bad name!')).toThrow(/letters, numbers/);
  });

  test('missing brain URL is a hard error, not a localhost token', async () => {
    await expect(enrollDevice(dataDir, '', 'desktop-NA23', { onExisting: 'upsert' })).rejects.toThrow(
      /public_url/i,
    );
  });
});

test('rotate: fresh sid, old tokens die with the old row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-rotate-'));
  initDatabase(':memory:');
  try {
    const first = await enrollDevice(dir, 'u1.vps1.usejarvis.host', 'desktop-A', { onExisting: 'upsert' });
    const rotated = await enrollDevice(dir, 'u1.vps1.usejarvis.host', 'desktop-A', {
      onExisting: 'upsert',
      rotate: true,
    });

    expect(rotated.created).toBe(true);
    expect(rotated.sidecar.id).not.toBe(first.sidecar.id);
    // Old sid is gone -> every JWT carrying it fails enrollment checks.
    const old = getDb().query('SELECT id FROM sidecars WHERE id = ?').get(first.sidecar.id);
    expect(old).toBeNull();
    // Exactly one row for the device name.
    const count = getDb().query('SELECT COUNT(*) as n FROM sidecars').get() as { n: number };
    expect(count.n).toBe(1);
  } finally {
    closeDb();
    await rm(dir, { recursive: true, force: true });
  }
});
