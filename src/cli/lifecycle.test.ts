import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DAEMON_PORT,
  describeDashboard,
  getConfiguredPort,
  readConfiguredPort,
  readConfiguredPortSetting,
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

  test('a quoted port reads as the same number as an unquoted one', async () => {
    // YAML makes a quoted scalar a string, and this reader used to take only a
    // number: the daemon bound 8080 (Bun.serve coerces) while every CLI path
    // here fell through to 3142 (#550).
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080"\n');
    expect(readConfiguredPort(TEST_CONFIG_PATH)).toBe(8080);
    expect(getConfiguredPort(TEST_CONFIG_PATH)).toBe(8080);
    expect(readConfiguredPortSetting(TEST_CONFIG_PATH)).toEqual({ kind: 'valid', port: 8080 });
  });

  test('readConfiguredPortSetting tells a broken port from an absent one', async () => {
    // readConfiguredPort collapses both to null, which is why the callers that
    // would otherwise reach for 3142 use the setting instead.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    expect(readConfiguredPortSetting(TEST_CONFIG_PATH).kind).toBe('invalid');
    expect(readConfiguredPort(TEST_CONFIG_PATH)).toBeNull();

    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  data_dir: /tmp/jarvis-test\n');
    expect(readConfiguredPortSetting(TEST_CONFIG_PATH)).toEqual({ kind: 'absent' });

    expect(readConfiguredPortSetting(MISSING_CONFIG_PATH)).toEqual({ kind: 'absent' });
  });

  test('an unparseable config is invalid, not absent', async () => {
    // The daemon will not boot from it either, so nothing of ours is listening
    // and 3142 can only reach someone else.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: [unclosed\n');
    expect(readConfiguredPortSetting(TEST_CONFIG_PATH).kind).toBe('invalid');
  });

  // Any file loadConfig throws on. Each of these used to read as "nothing
  // configured" -- a `parsed?.daemon?.port` lookup cannot tell an absent key
  // from a `daemon:` block that is not a block -- and so resolved to 3142 on a
  // machine where the daemon could not start at all. A single slipped indent in
  // the very key #550 is about does it.
  const unloadable: [string, string][] = [
    ['a mis-indented daemon block', 'daemon:\nport: 8080\n'],
    ['an empty daemon block', 'daemon:\n'],
    ['a scalar where the daemon block goes', 'daemon: 5\n'],
    ['a string where the daemon block goes', 'daemon: "nope"\n'],
    ['a scalar at the top level', '42\n'],
    ['a list at the top level', '- daemon\n'],
  ];

  test.each(unloadable)('%s is invalid, because loadConfig throws on it', async (_label, body) => {
    await Bun.write(TEST_CONFIG_PATH, body);
    // Asserted, not assumed: this pins the two readers together, so the CLI
    // cannot start treating a file as fine that the daemon refuses.
    const { loadConfig } = await import('../config/loader.ts');
    await expect(loadConfig(TEST_CONFIG_PATH)).rejects.toThrow();
    expect(readConfiguredPortSetting(TEST_CONFIG_PATH).kind).toBe('invalid');
    expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }).port).toBeNull();
  });

  test('a list UNDER daemon: does load, and both sides then agree on the default', async () => {
    // Not lumped in above: deepMerge copies the list, no setting is found on it,
    // and the daemon really does bind the default. Refusing here would make the
    // CLI stricter than the daemon, which is the same class of disagreement.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  - port: 8080\n');
    const { loadConfig } = await import('../config/loader.ts');
    expect((await loadConfig(TEST_CONFIG_PATH)).daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }))
      .toEqual({ port: DEFAULT_DAEMON_PORT, source: 'default' });
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

  test('a quoted config port is the port stop targets', async () => {
    // The port `jarvis stop` signals. It used to be 3142 here, whoever held it.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080"\n');
    expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }))
      .toEqual({ port: 8080, source: 'config' });
  });

  test('a broken daemon.port makes stop pid-only, NOT a 3142 cleanup', async () => {
    // The point of #550: with no port we can trust, killing whatever listens on
    // the default is killing a process we never started.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    const result = resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(result.port).toBeNull();
    expect(result.source).toBe('invalid-config');
    expect(result.source === 'invalid-config' ? result.problem : '').toMatch(/between 1 and 65535/);
  });

  test('--port is still honoured over a broken daemon.port, but a stale JARVIS_PORT is not', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');

    // `--port N` was typed on this command line: a present-tense claim about a
    // daemon that is running, from someone looking at it.
    expect(resolveStopPort({ cliPort: 6000, configPath: TEST_CONFIG_PATH, env: {} }))
      .toEqual({ port: 6000, source: 'cli' });

    // JARVIS_PORT is NOT, and this is the important half. normalizeDaemonPort
    // rejects this file BEFORE applyEnvOverrides, so a daemon started from it is
    // not on 7000 either -- it is not running. Signalling 7000 would be #550's
    // harm through the env var instead of through the 3142 default.
    const stale = resolveStopPort({ configPath: TEST_CONFIG_PATH, env: { JARVIS_PORT: '7000' } });
    expect(stale.port).toBeNull();
    expect(stale.source).toBe('invalid-config');

    // With a port the daemon CAN bind, JARVIS_PORT keeps beating the config, as
    // applyEnvOverrides does.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: 5000\n');
    expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: { JARVIS_PORT: '7000' } }))
      .toEqual({ port: 7000, source: 'env' });
  });

  test('a real daemon started on JARVIS_PORT is still stoppable after the file is mistyped', async () => {
    // The case the rule above could have broken: the lockfile is read first, so
    // a running daemon is reachable however bad the file has since become.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    expect(acquireLock(process.pid)).toBe(true);
    writeLockedPort(7000);
    try {
      expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: { JARVIS_PORT: '7000' } }))
        .toEqual({ port: 7000, source: 'lockfile' });
    } finally {
      releaseLock();
    }
  });

  test('a running daemon lockfile still wins over a broken daemon.port', async () => {
    // The lockfile is the port a daemon actually bound, so a config edited
    // badly after it started must not turn `jarvis stop` into a pid-only stop.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    expect(acquireLock(process.pid)).toBe(true);
    writeLockedPort(9000);
    try {
      expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }))
        .toEqual({ port: 9000, source: 'lockfile' });
    } finally {
      releaseLock();
    }
  });

  // The same family as a broken daemon.port, one key over: resolveListen throws
  // on these, so the daemon never binds anything -- but the CLI used to read
  // daemon.listen as "not a unix socket", fall through to daemon.port, and go
  // after whatever held it.
  test.each([
    ['a listen the daemon refuses', 'daemon:\n  port: 8080\n  listen: "tcp:0.0.0.0:80"\n'],
    ['a non-string listen', 'daemon:\n  port: 8080\n  listen: 42\n'],
    ['a unix path that is not absolute', 'daemon:\n  port: 8080\n  listen: "unix:rel.sock"\n'],
  ])('%s makes stop pid-only rather than going after daemon.port', async (_label, body) => {
    await Bun.write(TEST_CONFIG_PATH, body);
    const result = resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(result.port).toBeNull();
    expect(result.source).toBe('invalid-config');
    expect(result.source === 'invalid-config' ? result.problem : '').toContain('daemon.listen');
  });

  test('a directory where the config file goes matches what the daemon does with it', async () => {
    // loadConfig asks Bun.file(dir).exists(), which is false, so the daemon boots
    // on the defaults. The CLI must not be stricter and skip a cleanup it owes.
    const asDir = join(SANDBOX, 'config-as-dir.yaml');
    mkdirSync(asDir, { recursive: true });
    try {
      const { loadConfig } = await import('../config/loader.ts');
      expect((await loadConfig(asDir)).daemon.port).toBe(DEFAULT_DAEMON_PORT);
      expect(resolveStopPort({ configPath: asDir, env: {} }))
        .toEqual({ port: DEFAULT_DAEMON_PORT, source: 'default' });
    } finally {
      rmSync(asDir, { recursive: true, force: true });
    }
  });

  test('unix-socket mode stays unix-socket, not invalid-config', async () => {
    // Both are pid-only, but they are reported differently and the user should
    // be told the right one.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n  listen: "unix:/run/jarvis/brain.sock"\n');
    expect(resolveStopPort({ configPath: TEST_CONFIG_PATH, env: {} }))
      .toEqual({ port: null, source: 'unix-socket' });
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
      .toEqual({ label: 'http://localhost:8080', openUrl: 'http://localhost:8080', reason: 'url', problem: null });
    const socket = describeDashboard({ url: null });
    expect(socket.openUrl).toBeNull();
    expect(socket.reason).toBe('unix-socket');
    expect(socket.label).toContain('unix socket');
    expect(socket.label).not.toContain('http://');
  });

  test('a quoted daemon.port sends the browser to the port the daemon binds', async () => {
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080"\n');
    const target = resolveDashboardTarget({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(target).toEqual({ url: 'http://localhost:8080', port: 8080, source: 'config' });
    expect(describeDashboard(target).openUrl).toBe('http://localhost:8080');
  });

  test('a broken daemon.port opens nothing and says why, instead of opening 3142', async () => {
    // The daemon refuses to load this config, so there is no dashboard; a tab
    // at the default would land on whatever else is listening there.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    const target = resolveDashboardTarget({ configPath: TEST_CONFIG_PATH, env: {} });
    expect(target.url).toBeNull();
    expect(target.port).toBeNull();
    expect(target.source).toBe('invalid-config');

    const described = describeDashboard(target);
    expect(described.openUrl).toBeNull();
    expect(described.reason).toBe('invalid-config');
    expect(described.problem).toContain('daemon.port');
    expect(described.label).toContain('between 1 and 65535');
    // Not the other reason for having no URL.
    expect(described.label).not.toContain('unix socket');
  });

  test('a broken daemon.port beats even an explicit --port here, unlike on the stop path', async () => {
    // This describes the daemon we are about to START, and the loader rejects
    // the file before startDaemon applies --port or JARVIS_PORT, so there is no
    // dashboard at any port. resolveStopPort differs on purpose: there a --port
    // is a claim about a daemon that is already up.
    await Bun.write(TEST_CONFIG_PATH, 'daemon:\n  port: "8080abc"\n');
    expect(resolveDashboardTarget({
      cliPort: 8080,
      configPath: TEST_CONFIG_PATH,
      env: { JARVIS_PORT: '7000' },
    }).source).toBe('invalid-config');
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
