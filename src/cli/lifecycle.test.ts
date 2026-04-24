import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  DEFAULT_DAEMON_PORT,
  getConfiguredPort,
  readConfiguredPort,
  resolveStopPort,
} from './lifecycle.ts';
import { acquireLock, releaseLock, writeLockedPort } from '../daemon/pid.ts';

const TEST_CONFIG_PATH = '/tmp/jarvis-cli-lifecycle-config.yaml';
const MISSING_CONFIG_PATH = '/tmp/jarvis-cli-lifecycle-missing.yaml';

async function cleanupConfig(): Promise<void> {
  if (existsSync(TEST_CONFIG_PATH)) await unlink(TEST_CONFIG_PATH);
}

describe('getConfiguredPort / readConfiguredPort', () => {
  afterEach(cleanupConfig);

  test('reads configured port from YAML', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 4242\n');
    expect(getConfiguredPort(TEST_CONFIG_PATH)).toBe(4242);
    expect(readConfiguredPort(TEST_CONFIG_PATH)).toBe(4242);
  });

  test('falls back to default port for invalid config', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port:\n    nope: true\n');
    expect(getConfiguredPort(TEST_CONFIG_PATH)).toBe(DEFAULT_DAEMON_PORT);
    expect(readConfiguredPort(TEST_CONFIG_PATH)).toBeNull();
  });

  test('readConfiguredPort returns null for missing file', () => {
    expect(readConfiguredPort(MISSING_CONFIG_PATH)).toBeNull();
    expect(getConfiguredPort(MISSING_CONFIG_PATH)).toBe(DEFAULT_DAEMON_PORT);
  });
});

describe('resolveStopPort precedence', () => {
  beforeEach(() => releaseLock());
  afterEach(async () => {
    releaseLock();
    await cleanupConfig();
  });

  test('lockfile beats env, CLI, config', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    acquireLock(process.pid);
    writeLockedPort(9000);

    const result = resolveStopPort({
      cliPort: 8000,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    });
    expect(result).toEqual({ port: 9000, source: 'lockfile' });
  });

  test('env beats CLI and config when no lockfile port', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    const result = resolveStopPort({
      cliPort: 8000,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    });
    expect(result).toEqual({ port: 7000, source: 'env' });
  });

  test('CLI beats config when no lockfile and no env', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    const result = resolveStopPort({
      cliPort: 8000,
      configPath: TEST_CONFIG_PATH,
      env: {},
    });
    expect(result).toEqual({ port: 8000, source: 'cli' });
  });

  test('config used when no lockfile, env, or CLI', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    const result = resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(result).toEqual({ port: 5000, source: 'config' });
  });

  test('default used when nothing else is available', () => {
    const result = resolveStopPort({ configPath: MISSING_CONFIG_PATH, env: {} });
    expect(result).toEqual({ port: DEFAULT_DAEMON_PORT, source: 'default' });
  });

  test('invalid env var is ignored, next source wins', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    const result = resolveStopPort({
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: 'not-a-port' },
    });
    expect(result).toEqual({ port: 5000, source: 'config' });
  });

  test('invalid CLI port is ignored, next source wins', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    const result = resolveStopPort({
      cliPort: 99999,
      configPath: TEST_CONFIG_PATH,
      env: {},
    });
    expect(result).toEqual({ port: 5000, source: 'config' });
  });

  test('explicitly-set port 3142 in config reports source "config", not "default"', async () => {
    await Bun.write(TEST_CONFIG_PATH, `daemon:\n  port: ${DEFAULT_DAEMON_PORT}\n`);
    const result = resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(result).toEqual({ port: DEFAULT_DAEMON_PORT, source: 'config' });
  });
});
