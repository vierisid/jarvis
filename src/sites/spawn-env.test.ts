/**
 * Issue #509: every site-builder spawn runs code out of a model-written project
 * tree, so none of them may inherit the daemon's environment.
 *
 * These tests assert at EACH CALL SITE, against the environment a real
 * grandchild process actually received. A test that only exercised
 * sanitizedEnv() would have passed on the day this bug was filed, while eight
 * of nine spawns leaked.
 *
 * Arrangement (see fixtures/spawn-env-probe.ts for why a child process is
 * required): launch the probe with canaries in its real startup environment and
 * with PATH pointing at fake `bunx`/`make`/`git` executables that dump their
 * own environment. Then assert on the dumps.
 *
 * Two deliberate properties of the harness:
 *   - The probe is launched from a MINIMAL constructed environment, not from
 *     `{...process.env}`. It does not need the developer's real secrets to
 *     prove anything, and not forwarding them keeps them out of the dump files
 *     and out of any failure output.
 *   - Every dump a probe run produces is asserted, not only the one the test
 *     names. Enumerating call sites is the same failure pattern this fix
 *     rejects for env names: it cannot cover the spawn nobody listed.
 *
 * POSIX-only: the fake executables are `#!/bin/sh` scripts. The win32 name
 * handling is covered by unit tests in src/util/subprocess-env.test.ts.
 *
 * The static guard that catches the NEXT unsanitized spawn used to live at the
 * bottom of this file, scoped to src/sites. #512 widened it to all of src/ and
 * moved it to src/spawn-env-guard.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedEnvName } from '../util/subprocess-env.ts';

/** Synthetic. Never a real secret, and never printed on failure. */
const CANARY_VALUE = 'sentinel-do-not-log';
const CANARY2_VALUE = 'sentinel-do-not-log-2';
/** A name the old denylist would NOT have matched. */
const CANARY_NAME = 'JARVIS_WORKFLOW_ENCRYPTION_KEY';
const CANARY2_NAME = 'ANTHROPIC_API_KEY';

const PROBE = join(import.meta.dir, 'fixtures', 'spawn-env-probe.ts');

/** Variables a POSIX shell sets for itself; not inherited from the parent. */
const SHELL_INJECTED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

/**
 * Per-site additions each spawn is PERMITTED (not required) to carry, keyed by
 * dump name. An allowance only: that a given site actually sets its addition is
 * asserted individually by the tests below.
 *
 * `/^git-/` is deliberately broad. `git config` is spawned both by
 * GitManager.init (through run(), which does set GIT_TERMINAL_PROMPT) and by
 * the static getGlobalAuthor (which does not), and both land under the same
 * dump name, so the allowance has to cover either.
 */
const EXTRAS_BY_DUMP: Array<[RegExp, string[]]> = [
  [/^make-dev$/, ['PORT', 'HOST', 'NODE_ENV']],
  [/^git-/, ['GIT_TERMINAL_PROMPT']],
];

/** The positive control spawns with an inherited env on purpose. */
const CONTROL_DUMP = 'make-control';

const tmpRoots: string[] = [];
const liveChildren: Array<{ kill: () => void }> = [];
afterAll(() => {
  // Bun does not kill spawned children when a test times out.
  for (const child of liveChildren) {
    try { child.kill(); } catch { /* already gone */ }
  }
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

type Dump = { name: string; env: Record<string, string> };
type ProbeResult = { dumps: Dump[]; stdout: string; stderr: string; exitCode: number };

function dumpNamed(result: ProbeResult, name: string): Record<string, string> | undefined {
  return result.dumps.find(d => d.name === name)?.env;
}

async function runProbe(site: string): Promise<ProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-spawn-env-'));
  tmpRoots.push(root);
  const binDir = join(root, 'bin');
  const dumpDir = join(root, 'dumps');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dumpDir, { recursive: true });

  // Fake toolchain. The dump path is baked into the script text because it
  // cannot be passed through the environment -- that is the very channel under
  // test, and an allowlist would strip it.
  for (const name of ['bunx', 'make', 'git']) {
    const script = [
      '#!/bin/sh',
      // Unique per invocation: two spawns of the same binary with the same
      // first argument must not overwrite each other's evidence, or a
      // sanitized call could mask a leaking one.
      `dump="${dumpDir}/${name}-\${1:-none}.$$.$(date +%s%N).env"`,
      // Write then rename: the presence of the file implies a complete write.
      'env > "$dump.partial"',
      'mv "$dump.partial" "$dump"',
      'exit 0',
    ].join('\n');
    writeFileSync(join(binDir, name), script, { mode: 0o755 });
  }

  // A minimal environment, built rather than inherited. Enough to run bun and
  // the toolchain; no real credential is handed to the probe at all.
  // --no-env-file: from the repo root Bun would otherwise auto-load a .env,
  // and the probe would not start from the minimal env built below.
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', PROBE, site, root], {
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      // In the probe's REAL startup environment, so an inheriting spawn
      // genuinely carries them.
      [CANARY_NAME]: CANARY_VALUE,
      [CANARY2_NAME]: CANARY2_VALUE,
    },
  });
  liveChildren.push(proc);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  const dumps: Dump[] = [];
  if (existsSync(dumpDir)) {
    for (const file of readdirSync(dumpDir)) {
      if (!file.endsWith('.env')) continue;
      const env: Record<string, string> = {};
      for (const line of readFileSync(join(dumpDir, file), 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      // Strip the uniqueness suffix: "git-remote.12345.1699.env" -> "git-remote".
      dumps.push({ name: file.slice(0, file.indexOf('.')), env });
    }
  }

  return { dumps, stdout, stderr, exitCode };
}

/** The probe must have completed; a crash must not read as a clean run. */
function expectProbeSucceeded(result: ProbeResult) {
  if (result.exitCode !== 0) {
    throw new Error(`probe exited ${result.exitCode}:\n${result.stderr}`);
  }
}

function isAllowedName(name: string): boolean {
  return isAllowedEnvName(name) || SHELL_INJECTED.has(name);
}

/**
 * The assertion applied to every dump.
 *
 * Reports only NAMES on failure. A leak means the child's environment is full
 * of the operator's real credentials, and this assertion fires exactly then --
 * printing the environment would write those credentials into the CI log.
 */
function expectSanitized(name: string, env: Record<string, string>, extraKeys: string[]) {
  expect(Object.keys(env).length).toBeGreaterThan(0);

  const leakedCanaries = Object.entries(env)
    .filter(([, v]) => v === CANARY_VALUE || v === CANARY2_VALUE)
    .map(([k]) => k);
  expect({ dump: name, leakedCanaries }).toEqual({ dump: name, leakedCanaries: [] });

  const unexpected = Object.keys(env).filter(k => !isAllowedName(k) && !extraKeys.includes(k));
  expect({ dump: name, unexpected }).toEqual({ dump: name, unexpected: [] });

  // The toolchain still got what it needs to run at all.
  expect(env.PATH).toBeTruthy();
}

/**
 * Assert EVERY dump the run produced. This is what makes coverage default-on:
 * a spawn nobody enumerated still has to be clean.
 */
function expectAllSanitized(result: ProbeResult) {
  expectProbeSucceeded(result);
  expect(result.dumps.length).toBeGreaterThan(0);

  for (const { name, env } of result.dumps) {
    if (name === CONTROL_DUMP) continue;
    const extras = EXTRAS_BY_DUMP.find(([pattern]) => pattern.test(name))?.[1] ?? [];
    expectSanitized(name, env, extras);
  }
}

describe('site-builder spawns do not inherit the daemon environment', () => {
  // If this fails, every other test in this file is meaningless.
  test('CONTROL: the probe can detect a leak when env is inherited', async () => {
    const result = await runProbe('control');
    expectProbeSucceeded(result);
    const env = dumpNamed(result, CONTROL_DUMP);

    expect(env).toBeDefined();
    expect(env![CANARY_NAME]).toBe(CANARY_VALUE);
    expect(env![CANARY2_NAME]).toBe(CANARY2_VALUE);
  }, 30_000);

  test('project-manager: `bunx create-*` scaffold spawn', async () => {
    const result = await runProbe('create-project');
    expect(dumpNamed(result, 'bunx-create-vite')).toBeDefined();
    expectAllSanitized(result);
  }, 60_000);

  test('project-manager: `make install` spawn', async () => {
    const result = await runProbe('create-project');
    expect(dumpNamed(result, 'make-install')).toBeDefined();
    expectAllSanitized(result);
  }, 60_000);

  test('dev-server-manager: `make dev` spawn keeps PORT/HOST/NODE_ENV', async () => {
    const result = await runProbe('dev-server');
    const env = dumpNamed(result, 'make-dev');

    expect(env).toBeDefined();
    expectAllSanitized(result);
    // The site's own additions must survive the refactor.
    expect(env!.HOST).toBe('127.0.0.1');
    expect(env!.NODE_ENV).toBe('development');
    expect(Number(env!.PORT)).toBeGreaterThanOrEqual(39000);
  }, 30_000);

  test('git-manager: git spawn keeps GIT_TERMINAL_PROMPT', async () => {
    const result = await runProbe('git-manager');
    const env = dumpNamed(result, 'git-branch');

    expect(env).toBeDefined();
    expectAllSanitized(result);
    expect(env!.GIT_TERMINAL_PROMPT).toBe('0');
  }, 30_000);

  test('git-manager: the static `git --version` / `git config` spawns', async () => {
    // These three carried no env at all and were missed by the first pass over
    // this file, so they get a behavioural probe rather than only the static
    // source scan below.
    const result = await runProbe('git-statics');

    expect(dumpNamed(result, 'git---version')).toBeDefined();
    expect(dumpNamed(result, 'git-config')).toBeDefined();
    // getGlobalAuthor spawns `git config` TWICE; both dumps are asserted here
    // because every dump is asserted, not just the first one found.
    expect(result.dumps.filter(d => d.name === 'git-config').length).toBe(2);
    expectAllSanitized(result);
  }, 30_000);

  test('github-manager: git spawn keeps GIT_TERMINAL_PROMPT', async () => {
    const result = await runProbe('github-manager');
    const env = dumpNamed(result, 'git-remote');

    expect(env).toBeDefined();
    // addRemote makes TWO git spawns (get-url, then add). Both are asserted.
    expect(result.dumps.filter(d => d.name === 'git-remote').length).toBe(2);
    expectAllSanitized(result);
    expect(env!.GIT_TERMINAL_PROMPT).toBe('0');
  }, 30_000);

  test('builder-tools: `sh -c` spawn behind site_run_command', async () => {
    const result = await runProbe('run-command');
    expectProbeSucceeded(result);

    expect(result.stdout).toContain('---RUN-COMMAND-OUTPUT---');
    // Without the end marker the dump may be truncated, and a truncated env
    // reads as a clean one.
    expect(result.stdout).toContain('---RUN-COMMAND-END---');

    const body = result.stdout.split('---RUN-COMMAND-OUTPUT---')[1]!.split('---RUN-COMMAND-END---')[0]!;
    const env: Record<string, string> = {};
    for (const line of body.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }

    expectSanitized('site_run_command', env, []);
  }, 30_000);
});
