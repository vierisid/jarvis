import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstallMethod, MARKER_FILENAME } from './install-method.ts';

let workDir: string;
let fakeHome: string;
let noDockerEnv: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'jarvis-install-method-'));
  fakeHome = join(workDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  // Point dockerEnvPath at a path guaranteed not to exist so no ambient
  // /.dockerenv leaks into tests running inside a container.
  noDockerEnv = join(workDir, 'no-dockerenv');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeMarker(root: string, body: unknown): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, MARKER_FILENAME), typeof body === 'string' ? body : JSON.stringify(body));
}

describe('detectInstallMethod — docker signals', () => {
  test('JARVIS_INSTALL_METHOD=docker wins even when marker says otherwise', () => {
    const root = join(workDir, 'app');
    writeMarker(root, { method: 'bun-global' });
    const info = detectInstallMethod(root, {
      env: { JARVIS_INSTALL_METHOD: 'docker' },
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('docker');
    expect(info.reason).toContain('JARVIS_INSTALL_METHOD');
  });

  test('/.dockerenv presence implies docker', () => {
    const dockerEnv = join(workDir, 'fake-dockerenv');
    writeFileSync(dockerEnv, '');
    const info = detectInstallMethod(join(workDir, 'app'), {
      env: {},
      dockerEnvPath: dockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('docker');
    expect(info.reason).toContain(dockerEnv);
  });
});

describe('detectInstallMethod — marker file', () => {
  test('valid marker is respected', () => {
    const root = join(workDir, 'app');
    writeMarker(root, { method: 'script', installedAt: '2026-04-23T00:00:00Z' });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('script');
    expect(info.markerPath).toBe(join(root, MARKER_FILENAME));
  });

  test('marker with unknown method falls through to inference', () => {
    const root = join(workDir, 'app');
    writeMarker(root, { method: 'bogus' });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('unknown');
    expect(info.markerPath).toBeUndefined();
  });

  test('corrupt marker JSON falls through to inference', () => {
    const root = join(workDir, 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, MARKER_FILENAME), '{not valid json');
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('unknown');
  });
});

describe('detectInstallMethod — path inference', () => {
  test('package root under ~/.bun/install/global is bun-global', () => {
    const root = join(fakeHome, '.bun', 'install', 'global', 'node_modules', '@usejarvis', 'brain');
    mkdirSync(root, { recursive: true });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('bun-global');
  });

  test('~/.jarvis/daemon with .git is script install', () => {
    const root = join(fakeHome, '.jarvis', 'daemon');
    mkdirSync(join(root, '.git'), { recursive: true });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('script');
  });

  test('~/.jarvis/daemon without .git is unknown (half-installed)', () => {
    const root = join(fakeHome, '.jarvis', 'daemon');
    mkdirSync(root, { recursive: true });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('unknown');
  });

  test('arbitrary git checkout is dev', () => {
    const root = join(workDir, 'work', 'jarvis');
    mkdirSync(join(root, '.git'), { recursive: true });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('dev');
  });

  test('neither marker, nor .git, nor known location is unknown', () => {
    const root = join(workDir, 'somewhere-else');
    mkdirSync(root, { recursive: true });
    const info = detectInstallMethod(root, {
      env: {},
      dockerEnvPath: noDockerEnv,
      homeDir: fakeHome,
    });
    expect(info.method).toBe('unknown');
  });
});
