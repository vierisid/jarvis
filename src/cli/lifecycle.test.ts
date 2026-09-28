import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DAEMON_PORT,
  describeDashboard,
  getConfiguredPort,
  readConfiguredPort,
  resolveDashboardTarget,
  resolveStopPort,
} from './lifecycle.ts';
import { acquireLock, releaseLock, writeLockedPort } from '../daemon/pid.ts';

/**
 * One sandbox for the whole file, and JARVIS_HOME points at it while these
 * tests run.
 *
 * Both matter. `releaseLock()` unlinks the daemon's lock path whether or not
 * this process holds the flock (src/daemon/pid.ts), so against the default root
 * these tests would delete a LIVE daemon's lockfile -- and then pass vacuously,
 * because `acquireLock` fails while that daemon holds the flock and
 * `writeLockedPort` no-ops without one. A per-run temp path also keeps parallel
 * runs in other worktrees off each other's config file.
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'jarvis-cli-lifecycle-'));
const TEST_CONFIG_PATH = join(SANDBOX, 'config.yaml');
const MISSING_CONFIG_PATH = join(SANDBOX, 'missing.yaml');
let prevJarvisHome: string | undefined;

beforeAll(() => {
  prevJarvisHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = SANDBOX;
});

afterAll(() => {
  releaseLock();
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

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

// #544: the open step used a hardcoded 3142, so `jarvis start` sent the browser
// (and the printed URL) to the wrong place on any other port, and to a bogus
// localhost tab in unix-socket mode.
describe('resolveDashboardTarget precedence', () => {
  afterEach(cleanupConfig);

  test('--port wins, like startDaemon userConfig.port', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    expect(resolveDashboardTarget({
      cliPort: 8080,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    })).toEqual({ url: 'http://localhost:8080', port: 8080, source: 'cli' });
  });

  test('JARVIS_PORT beats config, as applyEnvOverrides does', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    expect(resolveDashboardTarget({
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    })).toEqual({ url: 'http://localhost:7000', port: 7000, source: 'env' });
  });

  test('daemon.port is used when nothing overrides it', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    expect(resolveDashboardTarget({ configPath: TEST_CONFIG_PATH, env: {} }))
      .toEqual({ url: 'http://localhost:5000', port: 5000, source: 'config' });
  });

  test('the default is the last resort, not the first', () => {
    expect(resolveDashboardTarget({ configPath: MISSING_CONFIG_PATH, env: {} }))
      .toEqual({ url: `http://localhost:${DEFAULT_DAEMON_PORT}`, port: DEFAULT_DAEMON_PORT, source: 'default' });
  });

  test('an invalid --port or JARVIS_PORT falls through instead of being used', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    expect(resolveDashboardTarget({
      cliPort: 99999,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: 'not-a-port' },
    })).toEqual({ url: 'http://localhost:5000', port: 5000, source: 'config' });
  });

  test('unix-socket mode has no URL at all, whatever the port sources say', async () => {
    // There is no localhost port to open: a tab at daemon.port would land on
    // whatever else is listening there.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n  listen: "unix:/run/jarvis/brain.sock"\n');
    expect(resolveDashboardTarget({
      cliPort: 8080,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    })).toEqual({ url: null, port: null, source: 'unix-socket' });
  });

  // The #544 bug was in the CLI's wiring, not in the lookup: this is the part
  // bin/jarvis.ts prints and opens, so it is asserted here rather than nowhere.
  test('the CLI default is the config default', async () => {
    // resolveDashboardTarget claims to end where startDaemon ends, which holds
    // only while the copies of the default agree. src/daemon/index.ts keeps a
    // third (DEFAULT_PORT), module-private, and falls back to daemon.port first.
    const { DEFAULT_CONFIG } = await import('../config/types.ts');
    expect(DEFAULT_DAEMON_PORT).toBe(DEFAULT_CONFIG.daemon.port);
  });

  test('a TCP target is printed and opened; a socket is printed and NOT opened', () => {
    expect(describeDashboard({ url: 'http://localhost:8080' }))
      .toEqual({ label: 'http://localhost:8080', openUrl: 'http://localhost:8080' });
    const socket = describeDashboard({ url: null });
    expect(socket.openUrl).toBeNull();
    expect(socket.label).toContain('unix socket');
    expect(socket.label).not.toContain('http://');
  });

  test('a lockfile from a previous daemon does not decide where the browser goes', async () => {
    // resolveStopPort starts from the lockfile because it signals a RUNNING
    // daemon. Nothing has bound a port yet here, and a stale record would open
    // the wrong tab.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    // Asserted, not assumed: without the lock the port below is never recorded
    // and this test would pass whatever resolveDashboardTarget did.
    expect(acquireLock(process.pid)).toBe(true);
    writeLockedPort(9000);
    try {
      expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }).port).toBe(9000);
      expect(resolveDashboardTarget({ configPath: TEST_CONFIG_PATH, env: {} }).port).toBe(5000);
    } finally {
      releaseLock();
    }
  });
});
