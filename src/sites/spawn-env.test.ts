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
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBPROCESS_ENV_ALLOWLIST } from '../util/subprocess-env.ts';

/** Synthetic. Never a real secret, and never printed on failure. */
const CANARY_VALUE = 'sentinel-do-not-log';
const CANARY2_VALUE = 'sentinel-do-not-log-2';
/** A name the old denylist would NOT have matched. */
const CANARY_NAME = 'JARVIS_WORKFLOW_ENCRYPTION_KEY';
const CANARY2_NAME = 'ANTHROPIC_API_KEY';

const PROBE = join(import.meta.dir, 'fixtures', 'spawn-env-probe.ts');

/** Variables a POSIX shell sets for itself; not inherited from the parent. */
const SHELL_INJECTED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

/** Per-site additions each spawn is entitled to, keyed by dump name prefix. */
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
  const proc = Bun.spawn(['bun', 'run', PROBE, site, root], {
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
  return SUBPROCESS_ENV_ALLOWLIST.includes(name) || /^LC_/.test(name) || SHELL_INJECTED.has(name);
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

describe('no site-builder spawn may be added without sanitizing its env', () => {
  // The reason this issue existed: sanitizedEnv() was already in the tree and
  // 8 of 9 spawns simply did not call it. A per-call-site test cannot catch the
  // TENTH spawn, written next month. This one can.
  const SPAWN_IDIOMS = [
    'Bun.spawnSync(',
    'Bun.spawn(',
    'spawnSync(',
    'spawn(',
    'execSync(',
    'execFileSync(',
    'execFile(',
    'exec(',
  ];

  /**
   * The positive control in the probe fixture spawns with an inherited env on
   * purpose. Exempt it by exact path rather than by skipping subdirectories,
   * and assert the exemption still points at a real file so a rename fails
   * loudly instead of silently widening it.
   */
  const EXEMPT = [join(import.meta.dir, 'fixtures', 'spawn-env-probe.ts')];

  /**
   * Blank out string literals, template literals and comments, preserving
   * length and newlines so offsets and line numbers stay correct.
   *
   * Without this the paren walker below is defeated by an unbalanced paren
   * inside a string -- and `sh -c "... ("` is an entirely ordinary thing to
   * write at these call sites. Worse, the walker would run past the real end
   * of the call and swallow the NEXT spawn too, hiding two leaks at once.
   */
  function blankLiterals(source: string): string {
    const out = source.split('');
    let i = 0;
    while (i < source.length) {
      const ch = source[i]!;
      const next = source[i + 1];

      if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') out[i++] = ' ';
        continue;
      }
      if (ch === '/' && next === '*') {
        out[i++] = ' '; out[i++] = ' ';
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] !== '\n') out[i] = ' ';
          i++;
        }
        if (i < source.length) { out[i++] = ' '; out[i++] = ' '; }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i++; // keep the opening quote
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') { out[i] = ' '; i++; if (i < source.length && source[i] !== '\n') out[i] = ' '; i++; continue; }
          if (source[i] !== '\n') out[i] = ' ';
          i++;
        }
        i++; // skip the closing quote
        continue;
      }
      i++;
    }
    return out.join('');
  }

  /** Every .ts file under src/sites, recursively, excluding test files. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
    }
    return found;
  }

  test('the guard exemption still points at a real file', () => {
    for (const path of EXEMPT) expect(existsSync(path)).toBe(true);
  });

  test('every spawn under src/sites passes env: sanitizedEnv', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(import.meta.dir)) {
      if (EXEMPT.includes(file)) continue;

      const raw = readFileSync(file, 'utf8');
      const source = blankLiterals(raw);
      const relative = file.slice(import.meta.dir.length + 1);
      const seen = new Set<number>();

      for (const idiom of SPAWN_IDIOMS) {
        let index = source.indexOf(idiom);
        while (index !== -1) {
          // Longest idiom wins: `Bun.spawn(` also ends with `spawn(`.
          const alreadyCounted = [...seen].some(s => s <= index && index < s + 20 && source.startsWith(idiom, index));
          const end = index + idiom.length - 1;

          if (!alreadyCounted && !seen.has(index)) {
            let depth = 0;
            let cursor = end;
            for (; cursor < source.length; cursor++) {
              if (source[cursor] === '(') depth++;
              else if (source[cursor] === ')') {
                depth--;
                if (depth === 0) break;
              }
            }
            if (cursor >= source.length) {
              offenders.push(`${relative}:${raw.slice(0, index).split('\n').length} (unbalanced call, cannot verify)`);
            } else {
              // Read the ORIGINAL text so `sanitizedEnv(` is still visible.
              const call = raw.slice(index, cursor + 1);
              if (!call.includes('sanitizedEnv(')) {
                offenders.push(`${relative}:${raw.slice(0, index).split('\n').length} (${idiom})`);
              }
            }
            for (let m = index; m < index + idiom.length; m++) seen.add(m);
          }
          index = source.indexOf(idiom, index + 1);
        }
      }
    }

    // If this fails: the listed spawn runs code from a model-written project
    // tree and must pass `env: sanitizedEnv()` (plus any per-site additions as
    // its argument). See src/util/subprocess-env.ts.
    expect(offenders).toEqual([]);
  });
});
