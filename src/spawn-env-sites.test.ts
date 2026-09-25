/**
 * Issue #512: the spawns outside src/sites that ran foreign or workflow code
 * with the daemon's environment. Same method as src/sites/spawn-env.test.ts
 * (#510): assert at EACH CALL SITE, against the environment a real grandchild
 * process received, not against the return value of sanitizedEnv().
 *
 * Arrangement (see fixtures/spawn-env-sites-probe.ts): launch the probe with
 * canaries in its real startup environment and a fake `bun` first on PATH,
 * then assert on what was dumped. The canaries are the daemon's secrets
 * (ANTHROPIC_API_KEY, JARVIS_WORKFLOW_ENCRYPTION_KEY) AND the engine's own
 * variables (SANDBOX_ID and friends): the CODE-step sandbox runs inside the
 * engine, whose env the daemon already curates, so what it could leak is the
 * engine's, and a probe with only daemon-shaped canaries would pass for it
 * even with the fix reverted.
 *
 * As in #510, every dump a run produces is asserted, the probe starts from a
 * minimal constructed env rather than a copy of the developer's, and failures
 * report variable NAMES only.
 *
 * It sits at src/ root, next to the static guard, because the sites span
 * src/workflows and src/daemon.
 *
 * POSIX-only: the fake executable is a `#!/bin/sh` script.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedEnvName } from './util/subprocess-env.ts';

/** Synthetic. Never a real secret, and never printed on failure. */
const CANARY_VALUE = 'sentinel-do-not-log';

/**
 * Daemon secrets, and the engine variables a CODE step inherited before
 * #512. SANDBOX_ID is the identifier the worker RPC authenticates an engine
 * connection by.
 */
const CANARY_NAMES = [
  'ANTHROPIC_API_KEY',
  'JARVIS_WORKFLOW_ENCRYPTION_KEY',
  'SANDBOX_ID',
  'AP_SANDBOX_WS_PORT',
  'JARVIS_ENGINE_MARKER',
];

const PROBE = join(import.meta.dir, 'fixtures', 'spawn-env-sites-probe.ts');

/** Variables a POSIX shell sets for itself; not inherited from the parent. */
const SHELL_INJECTED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

/** Fake-binary controls, checked in the first test; 'control-code' has its own. */
const CONTROL_DUMPS = new Set(['bun-control-node', 'bun-control-bun']);

const tmpRoots: string[] = [];
const liveChildren: Array<{ kill: () => void }> = [];
afterAll(() => {
  // Bun does not kill spawned children when a test times out.
  for (const child of liveChildren) {
    try { child.kill(); } catch { /* already gone */ }
  }
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** `args`: the fake binary's argv, when it recorded one. */
type Dump = { name: string; env: Record<string, string>; args?: string[] };
type ProbeResult = { dumps: Dump[]; stderr: string; exitCode: number };

function dumpNamed(result: ProbeResult, name: string): Record<string, string> | undefined {
  return result.dumps.find(d => d.name === name)?.env;
}

async function runProbe(site: string, extraEnv: Record<string, string> = {}): Promise<ProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-wf-spawn-env-'));
  tmpRoots.push(root);
  const binDir = join(root, 'bin');
  const dumpDir = join(root, 'dumps');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dumpDir, { recursive: true });

  // The dump path is baked into the script: the environment is the channel
  // under test, and the allowlist would strip it.
  writeFileSync(join(binDir, 'bun'), [
    '#!/bin/sh',
    // Unique per invocation, so two spawns cannot overwrite each other's
    // evidence and let a clean one mask a leaking one.
    `dump="${dumpDir}/bun-\${1:-none}.$$.$(date +%s%N).env"`,
    // argv next to it, so the install sites can be held to --ignore-scripts.
    'printf "%s\\n" "$@" > "$dump.args"',
    // Write then rename: a present file is a complete one.
    'env > "$dump.partial"',
    'mv "$dump.partial" "$dump"',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  // Launched by absolute path: with the fake first on PATH, a bare 'bun' here
  // could resolve to the fake instead of the probe's runtime.
  // --no-env-file: from the repo root Bun would otherwise auto-load a .env,
  // and the probe would not start from the minimal env built below.
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', PROBE, site, root], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      // A HOME of our own, so the engine staging dir (under homedir()) lands
      // in the temp root instead of the developer's ~/.jarvis.
      HOME: root,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      ...extraEnv,
      ...Object.fromEntries(CANARY_NAMES.map(n => [n, CANARY_VALUE])),
    },
  });
  liveChildren.push(proc);

  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  const dumps: Dump[] = [];
  for (const file of readdirSync(dumpDir)) {
    // "bun-install.12345.1699.env" -> "bun-install"; "code-sandbox.json" -> "code-sandbox".
    const name = file.slice(0, file.indexOf('.'));
    if (file.endsWith('.json')) {
      dumps.push({ name, env: JSON.parse(readFileSync(join(dumpDir, file), 'utf8')) as Record<string, string> });
    } else if (file.endsWith('.env')) {
      const env: Record<string, string> = {};
      for (const line of readFileSync(join(dumpDir, file), 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const argsFile = join(dumpDir, `${file}.args`);
      const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').filter(Boolean) : undefined;
      dumps.push({ name, env, args });
    }
  }

  return { dumps, stderr, exitCode };
}

/** A crash must not read as a clean run. */
function expectProbeSucceeded(result: ProbeResult) {
  if (result.exitCode !== 0) {
    throw new Error(`probe exited ${result.exitCode}:\n${result.stderr}`);
  }
}

function isAllowedName(name: string): boolean {
  return isAllowedEnvName(name) || SHELL_INJECTED.has(name);
}

/** Names only on failure: a leak is exactly when the env holds real secrets. */
function expectSanitized(name: string, env: Record<string, string>, extraKeys: string[] = []) {
  expect(Object.keys(env).length).toBeGreaterThan(0);

  const leakedCanaries = Object.entries(env).filter(([, v]) => v === CANARY_VALUE).map(([k]) => k);
  expect({ dump: name, leakedCanaries }).toEqual({ dump: name, leakedCanaries: [] });

  const unexpected = Object.keys(env).filter(k => !isAllowedName(k) && !extraKeys.includes(k));
  expect({ dump: name, unexpected }).toEqual({ dump: name, unexpected: [] });

  // The toolchain still got what it needs to run at all.
  expect(env.PATH).toBeTruthy();
  expect(env.HOME).toBeTruthy();
}

/** Third-party installs run no lifecycle scripts (see util/sanitized-install.ts). */
function expectScriptsIgnored(result: ProbeResult) {
  const installs = result.dumps.filter(d => d.name === 'bun-install');
  expect(installs.length).toBeGreaterThan(0);
  for (const d of installs) expect(d.args).toContain('--ignore-scripts');
}

/** Every dump the run produced, not just the one the test names. */
function expectAllSanitized(result: ProbeResult, extraKeys: string[] = []) {
  expectProbeSucceeded(result);
  expect(result.dumps.length).toBeGreaterThan(0);
  for (const { name, env } of result.dumps) {
    if (CONTROL_DUMPS.has(name)) continue;
    expectSanitized(name, env, extraKeys);
  }
}

describe('workflow and daemon spawns do not inherit the daemon environment (#512)', () => {
  // If this fails, every other test in this file is meaningless.
  test('CONTROL: the probe sees every canary through both spawn APIs when env is inherited', async () => {
    const result = await runProbe('control');
    expectProbeSucceeded(result);

    for (const name of CONTROL_DUMPS) {
      const env = dumpNamed(result, name);
      expect(env).toBeDefined();
      for (const canary of CANARY_NAMES) expect({ name, canary, v: env![canary] }).toEqual({ name, canary, v: CANARY_VALUE });
    }
  }, 30_000);

  test('CONTROL: the probe sees every canary through the CODE-sandbox route when env is inherited', async () => {
    const result = await runProbe('control-code');
    expectProbeSucceeded(result);
    const env = dumpNamed(result, 'control-code');

    expect(env).toBeDefined();
    for (const canary of CANARY_NAMES) expect({ canary, v: env![canary] }).toEqual({ canary, v: CANARY_VALUE });
  }, 30_000);

  test('no-op-code-sandbox: the child running a CODE step', async () => {
    const result = await runProbe('code-sandbox');
    expect(dumpNamed(result, 'code-sandbox')).toBeDefined();
    expectAllSanitized(result);
  }, 30_000);

  test('pieces-library installer: `bun install` behind installPiece', async () => {
    const result = await runProbe('pieces-install');
    expect(dumpNamed(result, 'bun-install')).toBeDefined();
    expectAllSanitized(result);
    expectScriptsIgnored(result);
  }, 30_000);

  test('pieces-library reconciler: the startup `bun install`', async () => {
    const result = await runProbe('pieces-reconcile');
    expect(dumpNamed(result, 'bun-install')).toBeDefined();
    expectAllSanitized(result);
    expectScriptsIgnored(result);
  }, 30_000);

  test('engine build: the staging `bun install`', async () => {
    const result = await runProbe('engine-staging');
    expect(dumpNamed(result, 'bun-install')).toBeDefined();
    expectAllSanitized(result);
    expectScriptsIgnored(result);
  }, 30_000);

  test('daemon: the dashboard auto-build `bun run build:ui`', async () => {
    // NODE_ENV is the one per-site addition: `bun build` inlines it, so it
    // decides whether the dashboard is a production build.
    const result = await runProbe('ui-autobuild', { NODE_ENV: 'production' });
    const env = dumpNamed(result, 'bun-run');
    expect(env).toBeDefined();
    expectAllSanitized(result, ['NODE_ENV']);
    expect(env!.NODE_ENV).toBe('production');
  }, 30_000);
});
