import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { buildEnrollmentUrls, isLocalhostBrainUrl, SidecarManager } from './manager.ts';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { computeAnonId } from '../telemetry/anon-id.ts';

function keyPaths(dataDir: string): { keyDir: string; privateKeyPath: string; publicKeyPath: string } {
  const keyDir = join(dataDir, 'sidecar-keys');
  return {
    keyDir,
    privateKeyPath: join(keyDir, 'private.pem'),
    publicKeyPath: join(keyDir, 'public.pem'),
  };
}

function expectKeyModes(dataDir: string): void {
  const { keyDir, privateKeyPath, publicKeyPath } = keyPaths(dataDir);
  expect(statSync(keyDir).mode & 0o777).toBe(0o700);
  expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);
  expect(statSync(publicKeyPath).mode & 0o777).toBe(0o644);
}

describe('buildEnrollmentUrls', () => {
  test('parses https URL into wss/https pair', () => {
    expect(buildEnrollmentUrls('https://brain.example.com')).toEqual({
      brainWs: 'wss://brain.example.com/sidecar/connect',
      jwksUrl: 'https://brain.example.com/api/sidecars/.well-known/jwks.json',
    });
  });

  test('parses wss URL into wss/https pair (preserves explicit ws scheme)', () => {
    expect(buildEnrollmentUrls('wss://brain.example.com:8443')).toEqual({
      brainWs: 'wss://brain.example.com:8443/sidecar/connect',
      jwksUrl: 'https://brain.example.com:8443/api/sidecars/.well-known/jwks.json',
    });
  });

  test('parses http URL into ws/http pair', () => {
    expect(buildEnrollmentUrls('http://10.0.0.5:3142')).toEqual({
      brainWs: 'ws://10.0.0.5:3142/sidecar/connect',
      jwksUrl: 'http://10.0.0.5:3142/api/sidecars/.well-known/jwks.json',
    });
  });

  test('bare localhost host gets ws/http (insecure)', () => {
    expect(buildEnrollmentUrls('localhost:3142')).toEqual({
      brainWs: 'ws://localhost:3142/sidecar/connect',
      jwksUrl: 'http://localhost:3142/api/sidecars/.well-known/jwks.json',
    });
  });

  test('bare 127.0.0.1 host gets ws/http (insecure)', () => {
    expect(buildEnrollmentUrls('127.0.0.1:3142')).toEqual({
      brainWs: 'ws://127.0.0.1:3142/sidecar/connect',
      jwksUrl: 'http://127.0.0.1:3142/api/sidecars/.well-known/jwks.json',
    });
  });

  // Regression: pre-fix the bare-host heuristic was `!normalized.match(/:\d+$/)`,
  // which downgraded any remote host with an explicit port to ws/http. A
  // production deployment configured as `brain.example.com:443` would emit
  // ws://brain.example.com:443 — wrong. Now any non-localhost defaults to wss.
  test('bare remote host with explicit port stays wss/https', () => {
    expect(buildEnrollmentUrls('brain.example.com:443')).toEqual({
      brainWs: 'wss://brain.example.com:443/sidecar/connect',
      jwksUrl: 'https://brain.example.com:443/api/sidecars/.well-known/jwks.json',
    });
  });

  test('bare remote host without port gets wss/https', () => {
    expect(buildEnrollmentUrls('brain.example.com')).toEqual({
      brainWs: 'wss://brain.example.com/sidecar/connect',
      jwksUrl: 'https://brain.example.com/api/sidecars/.well-known/jwks.json',
    });
  });

  // Regression: pre-fix `normalized.includes('localhost')` matched
  // `notlocalhost.example.com` and downgraded it to ws/http.
  test('bare host containing the substring "localhost" but not equal to it stays wss', () => {
    expect(buildEnrollmentUrls('notlocalhost.example.com').brainWs)
      .toBe('wss://notlocalhost.example.com/sidecar/connect');
  });

  test('trims whitespace', () => {
    expect(buildEnrollmentUrls('  brain.example.com  ').brainWs)
      .toBe('wss://brain.example.com/sidecar/connect');
  });
});

describe('isLocalhostBrainUrl', () => {
  test.each([
    ['localhost', true],
    ['localhost:3142', true],
    ['127.0.0.1', true],
    ['127.0.0.1:3142', true],
    ['0.0.0.0', true],
    ['0.0.0.0:3142', true],
    ['[::1]', true],
    ['[::1]:3142', true],
    ['http://localhost:3142', true],
    ['ws://127.0.0.1:3142', true],
    ['https://brain.example.com', false],
    ['brain.example.com', false],
    ['brain.example.com:443', false],
    ['notlocalhost.example.com', false],
  ])('isLocalhostBrainUrl(%p) === %p', (input, expected) => {
    expect(isLocalhostBrainUrl(input)).toBe(expected);
  });
});

describe('SidecarManager key storage', () => {
  test('stores the enrollment private key with owner-only permissions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    try {
      const manager = new SidecarManager(dataDir);

      await manager.start();
      await manager.stop();

      expectKeyModes(dataDir);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('tightens existing enrollment key permissions on load', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    try {
      const firstManager = new SidecarManager(dataDir);
      await firstManager.start();
      await firstManager.stop();

      const { keyDir, privateKeyPath, publicKeyPath } = keyPaths(dataDir);
      await chmod(keyDir, 0o777);
      await chmod(privateKeyPath, 0o644);
      await chmod(publicKeyPath, 0o666);

      const secondManager = new SidecarManager(dataDir);
      await secondManager.start();
      await secondManager.stop();

      expectKeyModes(dataDir);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('SidecarManager enrollment', () => {
  test('stamps the brain anonymous telemetry id (bid) into the enrollment token', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      manager.setBrainUrl('https://brain.example.com');

      const { token } = await manager.enrollSidecar('telemetry-test');
      const claims = decodeJwt(token);

      // The token carries the brain's anon telemetry id so the sidecar can
      // report which brain it belongs to — and it must equal exactly what the
      // brain reports in its own telemetry, or the Grafana join won't line up.
      expect(claims.bid).toBe(computeAnonId());

      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('SidecarManager access tokens', () => {
  test('mints an access token an enrolled sidecar can use, and round-trips the sid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      manager.setBrainUrl('https://brain.example.com');

      const { sidecar } = await manager.enrollSidecar('access-test');

      const minted = await manager.issueAccessToken(sidecar.id);
      expect(minted).not.toBeNull();
      expect(minted!.expiresIn).toBeGreaterThan(0);

      // The access token authenticates the data plane and decodes back to sid.
      const verified = await manager.verifyAccessToken(minted!.token);
      expect(verified).toEqual({ sid: sidecar.id });

      // Carries a real expiry (unlike the long-lived enrollment JWT).
      const decoded = decodeJwt(minted!.token);
      expect(decoded.exp).toBeDefined();
      expect(decoded.aud).toBe('brain-api');

      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('does not mint for an unenrolled sid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      expect(await manager.issueAccessToken('does-not-exist')).toBeNull();
      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('the enrollment JWT is NOT accepted as an access token (and vice versa)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      manager.setBrainUrl('https://brain.example.com');

      const { token: enrollmentJwt, sidecar } = await manager.enrollSidecar('cutover-test');
      const access = await manager.issueAccessToken(sidecar.id);

      // The whole point of the split: the long-lived enrollment JWT must be
      // rejected on the data plane (it has no brain-api audience).
      expect(await manager.verifyAccessToken(enrollmentJwt)).toBeNull();

      // And a short-lived access token must NOT work as an enrollment credential
      // (else it could mint fresh tokens forever via /sidecar/token).
      expect(await manager.validateToken(access!.token)).toBeNull();

      // Sanity: each is still valid on its own side.
      expect(await manager.verifyAccessToken(access!.token)).toEqual({ sid: sidecar.id });
      expect((await manager.validateToken(enrollmentJwt))?.sid).toBe(sidecar.id);

      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('rejects garbage and tampered access tokens', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      manager.setBrainUrl('https://brain.example.com');
      const { sidecar } = await manager.enrollSidecar('tamper-test');
      const access = await manager.issueAccessToken(sidecar.id);

      expect(await manager.verifyAccessToken('not-a-jwt')).toBeNull();
      expect(await manager.verifyAccessToken('')).toBeNull();
      // Flip a character in the signature segment -> signature check fails.
      const tampered = access!.token.slice(0, -3) + (access!.token.endsWith('a') ? 'b' : 'a') + 'xx';
      expect(await manager.verifyAccessToken(tampered)).toBeNull();

      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * Panel sessions are what a panel webview authenticates with once its
 * bootstrap access token has been exchanged. The access token's 10-minute TTL
 * used to be BOTH the session lifetime (which broke panels mid-use) and the
 * revocation mechanism (`verifyAccessToken` is stateless on purpose). Removing
 * the first meant taking on the second explicitly, so these pin revocation.
 */
describe('SidecarManager panel sessions', () => {
  const withManager = async (
    body: (manager: SidecarManager, dataDir: string) => Promise<void>,
  ) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const manager = new SidecarManager(dataDir);
      await manager.start();
      manager.setBrainUrl('https://brain.example.com');
      await body(manager, dataDir);
      await manager.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  test('opens a session only for a token that verifies, and only while enrolled', async () => {
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('panel-open');
      const minted = await manager.issueAccessToken(sidecar.id);

      const session = await manager.openPanelSession(minted!.token);
      expect(session).not.toBeNull();
      expect(session!.sid).toBe(sidecar.id);

      // Garbage, and the enrollment JWT itself, open nothing.
      expect(await manager.openPanelSession('not-a-token')).toBeNull();
      expect(await manager.openPanelSession('')).toBeNull();
    });
  });

  test('revoking a device closes its panels and leaves other devices alone', async () => {
    await withManager(async (manager) => {
      const a = (await manager.enrollSidecar('device-a')).sidecar;
      const b = (await manager.enrollSidecar('device-b')).sidecar;
      const aSession = (await manager.openPanelSession((await manager.issueAccessToken(a.id))!.token))!;
      const bSession = (await manager.openPanelSession((await manager.issueAccessToken(b.id))!.token))!;

      expect(manager.revokeSidecar(a.id)).toBe(true);

      expect(manager.resolvePanelSession(aSession.id)).toBeNull();
      expect(manager.resolvePanelSession(bSession.id)?.sid).toBe(b.id);
      expect(manager.listPanelSessions()).toHaveLength(1);
    });
  });

  test('a revoked device is refused on the next request, not at the next sweep', async () => {
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('cli-revoke');
      const session = (await manager.openPanelSession((await manager.issueAccessToken(sidecar.id))!.token))!;
      expect(manager.resolvePanelSession(session.id)).not.toBeNull();

      // What `jarvis revoke` does from ANOTHER process: the row goes, and this
      // daemon is not told. The resolver must not need to have been told.
      const db = getDb();
      db.run('DELETE FROM sidecars WHERE id = ?', [sidecar.id]);

      expect(manager.resolvePanelSession(session.id)).toBeNull();
      // ...and it is forgotten, not merely refused each time.
      expect(manager.listPanelSessions()).toHaveLength(0);
    });
  });

  test('the sweep closes panels of a device revoked while it was offline', async () => {
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('offline-revoke');
      await manager.openPanelSession((await manager.issueAccessToken(sidecar.id))!.token);
      expect(manager.listPanelSessions()).toHaveLength(1);

      // No live connection to sever, so sweepRevokedConnections sees nothing.
      getDb().run('DELETE FROM sidecars WHERE id = ?', [sidecar.id]);
      expect(manager.sweepRevokedConnections()).toBe(0);

      expect(manager.sweepPanelSessions()).toBe(1);
      expect(manager.listPanelSessions()).toHaveLength(0);
    });
  });

  test('closing a session removes its row, not just its map entry', async () => {
    // Every write-through assertion elsewhere runs against a fake sink. This
    // one runs against the real table, so a typo in the SQL is caught rather
    // than passing every in-memory check.
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('rows-test');
      await manager.openPanelSession((await manager.issueAccessToken(sidecar.id))!.token);
      const rows = () =>
        (getDb().query('SELECT count(*) AS n FROM panel_sessions').get() as { n: number }).n;
      expect(rows()).toBe(1);

      expect(manager.revokeSidecar(sidecar.id)).toBe(true);
      expect(rows()).toBe(0);
    });
  });

  test('a CLI revoke takes the rows with it, in that process, via the cascade', async () => {
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('cascade-test');
      await manager.openPanelSession((await manager.issueAccessToken(sidecar.id))!.token);

      // What `jarvis revoke` does, from a process that knows nothing about
      // panel sessions. The FK is what cleans up on its behalf.
      getDb().run('DELETE FROM sidecars WHERE id = ?', [sidecar.id]);

      const n = (getDb().query('SELECT count(*) AS n FROM panel_sessions').get() as { n: number }).n;
      expect(n).toBe(0);
    });
  });

  test('a device revoked while the brain was down does not come back with it', async () => {
    // The dangerous shape of the restart feature: sessions persist, so a
    // revocation performed during the downtime must still be honoured on the
    // way back up rather than restored as a live panel.
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const first = new SidecarManager(dataDir);
      await first.start();
      first.setBrainUrl('https://brain.example.com');
      const { sidecar } = await first.enrollSidecar('revoked-while-down');
      const session = (await first.openPanelSession((await first.issueAccessToken(sidecar.id))!.token))!;
      await first.stop();

      getDb().run('DELETE FROM sidecars WHERE id = ?', [sidecar.id]);

      const second = new SidecarManager(dataDir);
      await second.start();
      // Assert BEFORE resolving: `resolvePanelSession` deletes on a failed
      // enrollment check, so checking after it would pass whether the cascade
      // worked or not. Nothing should have been restored at all.
      expect(second.listPanelSessions()).toHaveLength(0);
      expect(second.resolvePanelSession(session.id)).toBeNull();
      await second.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('revoking a device with more sessions than SQLite has variables still clears the table', async () => {
    // The bootstrap token is reusable inside its TTL, so the number of sessions
    // for one sid is not bounded by anything the code controls. An unchunked
    // `DELETE ... IN (?,...)` throws past ~32k variables, and persist() swallows
    // it -- leaving rows on disk that every later sweep and every start would
    // re-throw on. 600 is enough to catch an unchunked delete against the real
    // driver without minting 33k JWTs.
    await withManager(async (manager) => {
      const { sidecar } = await manager.enrollSidecar('chunk-test');
      const token = (await manager.issueAccessToken(sidecar.id))!.token;
      for (let i = 0; i < 600; i++) await manager.openPanelSession(token);

      const rows = () =>
        (getDb().query('SELECT count(*) AS n FROM panel_sessions').get() as { n: number }).n;
      expect(rows()).toBe(600);

      expect(manager.revokeSidecar(sidecar.id)).toBe(true);
      expect(rows()).toBe(0);
      expect(manager.listPanelSessions()).toHaveLength(0);
    });
  });

  test('an open panel survives a brain restart', async () => {
    // THE REASON SESSIONS ARE PERSISTED. Every hosted update restarts the
    // instance unit; an in-memory-only session would put every open panel on a
    // 401 it could never recover from.
    const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-sidecar-manager-'));
    initDatabase(':memory:');
    try {
      const first = new SidecarManager(dataDir);
      await first.start();
      first.setBrainUrl('https://brain.example.com');
      const { sidecar } = await first.enrollSidecar('restart-test');
      const session = (await first.openPanelSession((await first.issueAccessToken(sidecar.id))!.token))!;
      await first.stop();

      const second = new SidecarManager(dataDir);
      await second.start();
      expect(second.resolvePanelSession(session.id)?.sid).toBe(sidecar.id);
      await second.stop();
    } finally {
      closeDb();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
