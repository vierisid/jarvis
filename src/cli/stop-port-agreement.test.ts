import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStopPort } from './lifecycle.ts';

/**
 * The port the daemon actually binds, and the port `jarvis stop` would signal,
 * proved to be the same number.
 *
 * A loader unit test is not enough here. #550's consequence was not a wrong
 * number in a config object: it was `jarvis stop` running SIGTERM and then
 * SIGKILL against whatever same-user process happened to hold 3142, because a
 * quoted `daemon.port` bound 8080 (Bun.serve coerces the string), recorded
 * nothing in the lockfile (writeLockedPort demanded a number) and left the CLI
 * falling through to its default. Both halves have to be exercised end to end
 * for that gap to be visible at all.
 *
 * So the child below IS the daemon's port path -- loadConfig, the same
 * `userConfig?.port ?? jarvisConfig.daemon.port ?? DEFAULT_PORT` expression
 * startDaemon uses, resolveListen, acquireLock, writeLockedPort -- and it binds
 * the port for real and reports what the kernel gave it. The parent then runs
 * the CLI's own resolveStopPort, in its own process, against the lockfile and
 * config the child left behind.
 *
 * Nothing here signals anything: the one listener involved is the child this
 * test spawned, and it is stopped by killing that child. Verifying the RESOLVED
 * port is the whole point -- running the cleanup would be aiming a SIGKILL at a
 * port number a test computed.
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'jarvis-stop-port-'));
let prevJarvisHome: string | undefined;

beforeAll(() => {
  prevJarvisHome = process.env.JARVIS_HOME;
  // The lockfile the child writes and the parent reads both hang off this.
  process.env.JARVIS_HOME = SANDBOX;
});

afterAll(() => {
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  rmSync(SANDBOX, { recursive: true, force: true });
});

const LOADER_TS = new URL('../config/loader.ts', import.meta.url).href;
const PID_TS = new URL('../daemon/pid.ts', import.meta.url).href;
const TYPES_TS = new URL('../config/types.ts', import.meta.url).href;

/**
 * A port nothing is on right now: let the kernel pick one, then let it go.
 *
 * Bind-then-release, so something else could take it in between. That can only
 * make the child fail to bind, which fails the test loudly -- it cannot make a
 * wrong port look right, because every assertion compares against the port the
 * kernel actually gave the child.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('probe') });
  // `port` is optional in the types because a unix-socket server has none; this
  // one is TCP on 127.0.0.1, so the kernel gave it a number.
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number') throw new Error('the probe server reported no port');
  return port;
}

/**
 * Run the daemon's port path in a child that keeps the lock and the listener,
 * exactly as a running daemon does. Resolves with the port the kernel actually
 * bound; the returned `stop` kills the child this function spawned.
 */
async function startDaemonLeg(configPath: string): Promise<{ bound: number; portType: string; stop: () => Promise<void> }> {
  const script = `
    const { loadConfig, resolveListen } = await import(${JSON.stringify(LOADER_TS)});
    const { acquireLock, writeLockedPort } = await import(${JSON.stringify(PID_TS)});
    const { DEFAULT_CONFIG } = await import(${JSON.stringify(TYPES_TS)});
    // src/daemon/index.ts keeps its own module-private DEFAULT_PORT; this is the
    // same number from the copy that is importable without booting the daemon.
    const DEFAULT_PORT = DEFAULT_CONFIG.daemon.port;
    const config = await loadConfig(${JSON.stringify(configPath)});
    // startDaemon's own expression, with no --port on the command line.
    const port = config.daemon.port ?? DEFAULT_PORT;
    const listen = resolveListen({ port, listen: config.daemon.listen });
    if (listen.kind !== 'tcp') throw new Error('expected a tcp listen spec');
    // process.pid, as the daemon passes: writeLockedPort rewrites the whole
    // file, so a missing pid here would look fine and leave the lockfile in a
    // shape the daemon never writes if that ever stopped being true.
    if (!acquireLock(process.pid)) throw new Error('could not take the daemon lock');
    writeLockedPort(listen.port);
    const server = Bun.serve({ port: listen.port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    console.log('BOUND:' + server.port + ':' + typeof config.daemon.port);
    // Stay up, holding the lock and the port, until killed.
    await new Promise(() => {});
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    // JARVIS_PORT dropped deliberately: applyEnvOverrides would have it beat the
    // config port, so a developer or runner with one exported would fail this
    // test on a port the config never named.
    env: { ...process.env, JARVIS_HOME: SANDBOX, JARVIS_PORT: undefined },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Awaits the exit, not just the signal: the flock is released when the kernel
  // reaps the child, and the next case in the loop takes the same lock. Killing
  // without waiting made that a race, and this repo has enough of those.
  const stop = async () => {
    try { child.kill(); } catch { /* already gone */ }
    await child.exited;
  };

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 15_000;
  while (!seen.includes('\n') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  // Drained either way, so the pipe is not held open for the rest of the test.
  // The catch keeps a read failure on the happy path (where nothing awaits this)
  // from surfacing as an unhandled rejection instead of a test failure.
  const stderr = new Response(child.stderr).text();
  stderr.catch(() => { /* reported below only when it is needed */ });
  const line = seen.split('\n').find((l) => l.startsWith('BOUND:'));
  if (!line) {
    await stop();
    throw new Error(`daemon leg printed no BOUND line:\n${seen}\n${await stderr}`);
  }
  const [, port = '', portType = ''] = line.trim().split(':');
  // `portType` is asserted by the caller, AFTER the resolution comparison, so
  // the failure this test reports on a regression is the divergence itself
  // rather than an intermediate detail of it.
  return { bound: Number(port), portType, stop };
}

describe('the port the daemon bound is the port `jarvis stop` resolves', () => {
  // Both spellings of the same port. `port: 8080` always worked; `port: "8080"`
  // is a string in YAML and is the bug.
  for (const [label, quote] of [['unquoted', ''], ['quoted', '"']] as const) {
    test(`a ${label} daemon.port`, async () => {
      const port = freePort();
      const configPath = join(SANDBOX, `config-${label}.yaml`);
      writeFileSync(configPath, `daemon:\n  port: ${quote}${port}${quote}\n`);

      const daemon = await startDaemonLeg(configPath);
      try {
        expect(daemon.bound).toBe(port);

        // The CLI, in its own process, with no --port and no JARVIS_PORT: the
        // only thing it can go on is what the daemon left on disk.
        const resolution = resolveStopPort({ configPath, env: {} });

        expect(resolution).toEqual({ port: daemon.bound, source: 'lockfile' });
        // Said twice on purpose: the assertion that matters is "not some other
        // port", and 3142 is the specific other port #550 reached for.
        expect(resolution.port).not.toBe(3142);
        // And the daemon was holding a NUMBER, which is what writeLockedPort
        // needs; a string is what slid past it and emptied the lockfile.
        expect(daemon.portType).toBe('number');
      } finally {
        await daemon.stop();
      }
    }, 30_000);
  }

  test('and the config alone resolves it too, before any daemon has run', async () => {
    // The no-lockfile recovery path `jarvis stop` falls back to: still the
    // daemon's port, quoted or not, rather than the default.
    const configPath = join(SANDBOX, 'config-nolock.yaml');
    writeFileSync(configPath, 'daemon:\n  port: "8080"\n');
    const nested = mkdtempSync(join(tmpdir(), 'jarvis-stop-port-nolock-'));
    const prev = process.env.JARVIS_HOME;
    process.env.JARVIS_HOME = nested; // no lockfile under here
    try {
      expect(resolveStopPort({ configPath, env: {} })).toEqual({ port: 8080, source: 'config' });
    } finally {
      process.env.JARVIS_HOME = prev;
      rmSync(nested, { recursive: true, force: true });
    }
  });
});
