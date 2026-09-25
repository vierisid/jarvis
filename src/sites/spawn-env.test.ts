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
import ts from 'typescript';
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
      // Name the dump after the subcommand, skipping leading `-c key=value`
      // pairs (GitManager and GitHubManager pin config on every git they run).
      'while [ "$#" -ge 2 ] && [ "$1" = "-c" ]; do shift 2; done',
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
  //
  // It walks the TypeScript AST rather than scanning text. A hand-rolled
  // scanner was tried first and was silently blind: it had no regex-literal
  // state, so the `"` inside `/\/home\/[^\s"']*/g` at proxy.ts:128 opened a
  // phantom string and blanked the rest of that file. Any spawn below it was
  // invisible, with no failure to notice. Parsing removes that whole class of
  // bug, along with division-vs-comment and template-interpolation ambiguity.

  /** Exact callee spellings. `RE.exec(...)` is not one, so it cannot false-positive. */
  const SPAWN_CALLEES = new Set([
    'Bun.spawn', 'Bun.spawnSync',
    'spawn', 'spawnSync',
    'exec', 'execSync', 'execFile', 'execFileSync',
  ]);

  /**
   * The positive control in the probe fixture spawns with an inherited env on
   * purpose. Exempt it by exact path, and assert the path still resolves so a
   * rename fails loudly instead of silently widening the exemption.
   */
  const EXEMPT = [join(import.meta.dir, 'fixtures', 'spawn-env-probe.ts')];

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

  /** Report every spawn in `source` that does not pass env: sanitizedEnv(...). */
  function findOffenders(source: string, label: string): string[] {
    const offenders: string[] = [];
    const sf = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const visit = (node: ts.Node): void => {
      // `Bun.$`make dev`` inherits the environment and has no sanitized form
      // here, so it is always an offender.
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText(sf);
        if (tag === 'Bun.$' || tag === '$') {
          offenders.push(`${label}:${lineOf(node)} (${tag} shell inherits the env; use Bun.spawn with env: sanitizedEnv())`);
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (SPAWN_CALLEES.has(callee)) {
          const options = node.arguments.find(ts.isObjectLiteralExpression);
          const envProp = options?.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'env',
          );

          if (!envProp) {
            offenders.push(`${label}:${lineOf(node)} (${callee} passes no env, so it inherits the daemon's)`);
          } else {
            // Must be exactly a sanitizedEnv(...) call. A substring check would
            // accept `{ ...sanitizedEnv(), ...process.env }`, which is the most
            // plausible future regression and a total leak.
            const init = envProp.initializer;
            const sanitized = ts.isCallExpression(init) && init.expression.getText(sf) === 'sanitizedEnv';
            if (!sanitized) {
              offenders.push(`${label}:${lineOf(node)} (${callee} env must be exactly sanitizedEnv(...), got: ${init.getText(sf).replace(/\s+/g, ' ').slice(0, 60)})`);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
    return offenders;
  }

  test('the guard exemption still points at a real file', () => {
    for (const path of EXEMPT) expect(existsSync(path)).toBe(true);
  });

  test('every spawn under src/sites passes env: sanitizedEnv', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(import.meta.dir)) {
      if (EXEMPT.includes(file)) continue;
      offenders.push(...findOffenders(readFileSync(file, 'utf8'), file.slice(import.meta.dir.length + 1)));
    }

    // If this fails: the listed spawn runs code from a model-written project
    // tree and must pass `env: sanitizedEnv()` (plus any per-site additions as
    // its argument). See src/util/subprocess-env.ts.
    expect(offenders).toEqual([]);
  });

  // The guard is the only layer protecting spawns that do not exist yet, so
  // the shapes it must catch are pinned here rather than checked by hand once.
  describe('the guard catches evasions', () => {
    const cases: Array<[string, string]> = [
      ['a plain unsanitized spawn', `Bun.spawn(['echo'], { cwd: d, stdout: 'pipe' });`],
      ['an unbalanced paren inside a string', `Bun.spawn(['sh', '-c', 'echo hi ('], { cwd: d });`],
      ['a regex literal containing a quote (proxy.ts:128 shape)', `const RE = /\\/home\\/[^\\s"']*/g;\nBun.spawn(['echo'], { cwd: d });`],
      ['Bun.spawnSync', `Bun.spawnSync(['echo'], { cwd: d });`],
      ['node child_process exec', `execSync('echo hi', { cwd: d });`],
      ['a spread that re-adds the daemon env', `Bun.spawn(['echo'], { env: { ...sanitizedEnv(), ...process.env } });`],
      ['a sanitizedEnv call parked on the wrong property', `Bun.spawn(['echo'], { cwd: d, note: sanitizedEnv() });`],
      ['a second spawn adjacent to a sanitized one', `Bun.spawn(['a'], { env: sanitizedEnv() });spawn(['b'], { cwd: d });`],
      ['a template literal with interpolation', `Bun.spawn([\`\${bin} run\`], { cwd: d });`],
      ['Bun.$ shell', 'Bun.$`make dev`.cwd(d);'],
    ];

    for (const [name, code] of cases) {
      test(name, () => {
        expect(findOffenders(code, 'synthetic.ts')).not.toEqual([]);
      });
    }

    const allowed: Array<[string, string]> = [
      ['a correctly sanitized spawn', `Bun.spawn(['echo'], { cwd: d, env: sanitizedEnv() });`],
      ['a sanitized spawn with extras', `Bun.spawn(['echo'], { env: sanitizedEnv({ PORT: '1' }) });`],
      ['a spawn mentioned only in a line comment', `// Bun.spawn(['echo'], { cwd: d })`],
      ['a spawn mentioned only in a block comment', `/* Bun.spawn(['echo'], {}) */`],
      ['regex .exec(), which is not a spawn', `const m = RE.exec(input);`],
      ['a string that merely mentions a spawn', `const doc = "call Bun.spawn( with env";`],
    ];

    for (const [name, code] of allowed) {
      test(`no false positive: ${name}`, () => {
        expect(findOffenders(code, 'synthetic.ts')).toEqual([]);
      });
    }
  });
});
