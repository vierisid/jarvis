import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnrollmentUrls, isLocalhostBrainUrl, SidecarManager } from './manager.ts';

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
