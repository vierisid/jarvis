/**
 * Issue #514: the spawns the MODEL directs -- run_command's shell, an app it
 * launches, the Chrome it drives over CDP, and the desktop-bridge that
 * launches apps for it -- no longer hand their child the daemon's own
 * secrets, and still hand it the user's shell and desktop.
 *
 * Same method as src/spawn-env-sites.test.ts (#512): assert at EACH CALL SITE,
 * against the environment a real child received. See
 * fixtures/model-exec-env-probe.ts: the probe starts with the canaries and the
 * user variables in its real startup environment, and each site runs a fake
 * executable that dumps what it got.
 *
 * Two directions are asserted, because a denylist can fail both ways:
 *   - no canary value reaches the child: every DAEMON_SECRET_ENV_NAMES entry,
 *     an unclassified JARVIS_ name standing for a future secret, and a
 *     lowercase spelling of a listed one;
 *   - every user variable arrives with its value: PATH, HOME, SHELL,
 *     SSH_AUTH_SOCK, DISPLAY, XAUTHORITY, VIRTUAL_ENV, NVM_DIR, a proxy, the
 *     user's own GITHUB_TOKEN, a custom variable, JARVIS_HOME.
 * Failures report variable NAMES only.
 *
 * Not covered here, because no Linux run can reach them: the Windows and
 * macOS scripts behind defaultExec (the seam itself is covered). The static
 * guard holds defaultExec to modelExecEnv().
 *
 * POSIX-only: the fakes are `#!/bin/sh` scripts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_SECRET_ENV_NAMES } from './util/model-exec-env.ts';

/** Synthetic. Never a real secret, and never printed on failure. */
const CANARY_VALUE = 'sentinel-do-not-log';

const CANARY_NAMES = [
  ...DAEMON_SECRET_ENV_NAMES,
  // A JARVIS_ name nobody has classified: the future secret.
  'JARVIS_FUTURE_SIGNING_SALT',
  // POSIX names are case-sensitive; this is a distinct variable, and still
  // the daemon's.
  'jarvis_github_token',
];

const PROBE = join(import.meta.dir, 'fixtures', 'model-exec-env-probe.ts');
const FAKE_SERVER = join(import.meta.dir, 'fixtures', 'model-exec-fake-server.ts');

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

type Dump = { name: string; env: Record<string, string> };
/** `sent`: the user variables the probe started with, for exact comparison. */
type ProbeResult = { dumps: Dump[]; sent: Record<string, string>; stdout: string; stderr: string; exitCode: number };

/** The user's shell and desktop, as the probe's startup env carries it. */
function userEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    SHELL: join(root, 'bin', 'fake-shell'),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: 'C.UTF-8',
    SSH_AUTH_SOCK: join(root, 'agent.sock'),
    DISPLAY: ':99',
    WAYLAND_DISPLAY: 'wayland-99',
    XAUTHORITY: join(root, 'xauth'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, 'bus')}`,
    XDG_RUNTIME_DIR: join(root, 'run'),
    VIRTUAL_ENV: join(root, 'venv'),
    NVM_DIR: join(root, 'nvm'),
    HTTPS_PROXY: 'http://proxy.invalid:3128',
    GITHUB_TOKEN: 'users-own-token',
    MY_PROJECT_SETTING: 'custom-value',
    JARVIS_HOME: join(root, 'jarvis-home'),
  };
}

function fake(path: string, lines: string[]) {
  writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n', { mode: 0o755 });
}

/**
 * The dump path is baked into each fake: the environment is the channel under
 * test. Write-then-rename, so a present file is a complete one; unique per
 * invocation, so two spawns cannot overwrite each other's evidence.
 */
function dumpTo(dumpDir: string, prefix: string): string[] {
  return [
    `dump="${dumpDir}/${prefix}.$$.$(date +%s%N).env"`,
    'env > "$dump.partial"',
    'mv "$dump.partial" "$dump"',
  ];
}

/**
 * `fakesFirstOnPath`: put the fakes' directory at the front of PATH, for a site
 * that finds its executable by name (the toast's `which` and powershell.exe).
 */
async function runProbe(site: string, fakesFirstOnPath = false): Promise<ProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-model-exec-env-'));
  tmpRoots.push(root);
  const binDir = join(root, 'bin');
  const dumpDir = join(root, 'dumps');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dumpDir, { recursive: true });

  // The shell run_command uses: ignores `-c <command>`, dumps, succeeds.
  fake(join(binDir, 'fake-shell'), [...dumpTo(dumpDir, 'shell'), 'echo ok']);
  // A launched app: its first argument names the dump.
  fake(join(binDir, 'fake-app'), [...dumpTo(dumpDir, '${1:-app}')]);
  // Browser and bridge: dump, then become the listener the launcher polls, so
  // that the launcher's kill reaches it.
  const serve = `exec "${process.execPath}" --no-env-file "${FAKE_SERVER}" "$@"`;
  fake(join(binDir, 'fake-chrome'), [...dumpTo(dumpDir, 'chrome'), serve]);
  fake(join(binDir, 'fake-sidecar'), [...dumpTo(dumpDir, 'sidecar'), serve]);
  // The toast: WSL's view of the machine, no notify-send and a powershell.exe.
  fake(join(binDir, 'which'), ['case "$1" in powershell.exe) echo "$0"; exit 0;; *) exit 1;; esac']);
  fake(join(binDir, 'powershell.exe'), [...dumpTo(dumpDir, 'powershell')]);
  const env = userEnv(root);
  if (fakesFirstOnPath) env.PATH = `${binDir}:${env.PATH}`;

  // --no-env-file: from the repo root Bun would otherwise auto-load a .env,
  // and the probe would not start from the env built here.
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', PROBE, site, root], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...env,
      ...Object.fromEntries(CANARY_NAMES.map(n => [n, CANARY_VALUE])),
    },
  });
  const killer = setTimeout(() => proc.kill(9), 40_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);

  const dumps: Dump[] = [];
  for (const file of readdirSync(dumpDir)) {
    if (!file.endsWith('.env')) continue;
    const env: Record<string, string> = {};
    for (const line of readFileSync(join(dumpDir, file), 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    dumps.push({ name: file.slice(0, file.indexOf('.')), env });
  }
  return { dumps, sent: env, stdout, stderr, exitCode };
}

/** A crash must not read as a clean run. */
function expectProbeSucceeded(result: ProbeResult) {
  if (result.exitCode !== 0) throw new Error(`probe exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
}

/** Every dump the run produced, not just the one the test names. */
function expectModelExecEnv(result: ProbeResult, expectedDump: string) {
  expectProbeSucceeded(result);
  expect(result.dumps.map(d => d.name)).toContain(expectedDump);
  for (const { name, env } of result.dumps) {
    // Names only: a leak is exactly when the env holds real secrets.
    const leaked = Object.entries(env).filter(([, v]) => v === CANARY_VALUE).map(([k]) => k);
    expect({ dump: name, leaked }).toEqual({ dump: name, leaked: [] });

    // Every user variable arrived unchanged. These are synthetic, not
    // secrets, so a mismatch may print them.
    const changed = Object.keys(result.sent).filter(k => env[k] !== result.sent[k]);
    expect({ dump: name, changed }).toEqual({ dump: name, changed: [] });
  }
}

describe('model-directed spawns strip the daemon secrets and keep the user env (#514)', () => {
  // If this fails, every other test in this file is meaningless.
  test('CONTROL: a spawn that inherits sees every canary, through both spawn APIs', async () => {
    const result = await runProbe('control');
    expectProbeSucceeded(result);
    for (const name of ['control-bun', 'control-node']) {
      const env = result.dumps.find(d => d.name === name)?.env;
      expect({ name, dumped: env !== undefined }).toEqual({ name, dumped: true });
      const seen = CANARY_NAMES.filter(c => env![c] === CANARY_VALUE);
      expect({ name, seen }).toEqual({ name, seen: CANARY_NAMES });
    }
  }, 45_000);

  test('run_command: TerminalExecutor.execute, $SHELL -c', async () => {
    expectModelExecEnv(await runProbe('executor-execute'), 'shell');
  }, 45_000);

  test('run_command, streaming: TerminalExecutor.stream', async () => {
    expectModelExecEnv(await runProbe('executor-stream'), 'shell');
  }, 45_000);

  test('desktop_launch_app on Linux: LinuxAppController.launchApp', async () => {
    expectModelExecEnv(await runProbe('linux-launch-app'), 'linux-launch-app');
  }, 45_000);

  test('launch_app on Windows/macOS: the native-exec seam', async () => {
    expectModelExecEnv(await runProbe('native-exec'), 'native-exec');
  }, 45_000);

  test('the browser the model drives: launchChrome', async () => {
    expectModelExecEnv(await runProbe('chrome'), 'chrome');
  }, 45_000);

  test('desktop-bridge, which launches apps for the model: launchSidecar', async () => {
    expectModelExecEnv(await runProbe('sidecar'), 'sidecar');
  }, 45_000);

  test('the PowerShell toast, which interpolates model text: sendViaPowerShell', async () => {
    expectModelExecEnv(await runProbe('desktop-notify', true), 'powershell');
  }, 45_000);
});
