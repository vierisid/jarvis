import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hardenProcessInspection } from './process-hardening.ts';
import {
  ENGINE_MARKER_ENV,
  ENGINE_MARKER_VALUE,
} from '../workflows/runner/engine-runtime/engine-lifecycle.ts';

/**
 * #546. Four things are pinned here: the call happens by default on Linux, the
 * config escape hatch stops it, every other platform is a clean no-op, and no
 * failure mode of the native helper can take the daemon down.
 *
 * The real prctl is exercised in a CHILD process, never in the test runner: a
 * non-dumpable test runner would lose `/proc/self/environ` for every test that
 * follows in the same process, and `bun test` runs files together.
 */

const IS_LINUX = process.platform === 'linux';
const MODULE = import.meta.path;

/** Temp dirs the child probes write into, reclaimed after each test. */
const probeDirs: string[] = [];
function probeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  probeDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of probeDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

function log(lines: string[]): (line: string) => void {
  return (line: string) => {
    lines.push(line);
  };
}

describe('the decision', () => {
  test('hardens by default on Linux', () => {
    const lines: string[] = [];
    const calls: number[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      symbols: {
        do_set_dumpable: (v: number) => {
          calls.push(v);
          return 0;
        },
        do_get_dumpable: () => 0,
      },
    });
    expect(outcome).toEqual({ kind: 'hardened' });
    expect(calls).toEqual([0]);
    expect(lines.join('\n')).toContain('Process inspection blocked');
  });

  test('an absent flag hardens: the default is not "allow"', () => {
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: () => {},
      warn: () => {},
      allowInspection: undefined,
      symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 0 },
    });
    expect(outcome).toEqual({ kind: 'hardened' });
  });

  test('the escape hatch skips the call entirely', () => {
    const lines: string[] = [];
    let called = false;
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      allowInspection: true,
      symbols: {
        do_set_dumpable: () => {
          called = true;
          return 0;
        },
        do_get_dumpable: () => 1,
      },
    });
    expect(outcome).toEqual({ kind: 'allowed-by-config' });
    expect(called).toBe(false);
    expect(lines.join('\n')).toContain('ALLOWED');
  });

  /*
   * Fail CLOSED. Only `=== true` opens the hatch, so a value that reached here
   * without going through the config reader -- the YAML 1.1 string "yes", a
   * mapping, a stray 1 -- hardens anyway. Anything else would mean a typo in
   * one key could switch a security control off.
   */
  const notTrue: [string, unknown][] = [
    ['the string "true"', 'true'],
    ['the string "yes"', 'yes'],
    ['1', 1],
    ['a mapping', { allow: true }],
    ['a non-empty list', [true]],
    ['false', false],
    ['null', null],
  ];
  test.each(notTrue)('hardens anyway when the flag is %s rather than a real true', (_label, allowInspection) => {
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: () => {},
      warn: () => {},
      allowInspection,
      symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 0 },
    });
    expect(outcome).toEqual({ kind: 'hardened' });
  });

  test('every non-Linux platform is a clean no-op that says what it did', () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const lines: string[] = [];
      let called = false;
      const outcome = hardenProcessInspection({
        platform,
        log: log(lines),
        warn: log(lines),
        symbols: {
          do_set_dumpable: () => {
            called = true;
            return 0;
          },
          do_get_dumpable: () => 1,
        },
      });
      expect(outcome).toEqual({ kind: 'unsupported', platform });
      expect(called).toBe(false);
      expect(lines.join('\n')).toContain('Linux-only');
    }
  });

  test('the platform verdict beats the hatch, so macOS is never told its /proc is open', () => {
    // The hatch turns off something that never happened off Linux. Reporting
    // `allowed-by-config` there would claim a change that did not apply, and
    // its warning talks about /proc entries macOS does not have.
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'darwin',
      log: log(lines),
      warn: log(lines),
      allowInspection: true,
      symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 1 },
    });
    expect(outcome).toEqual({ kind: 'unsupported', platform: 'darwin' });
    expect(lines.join('\n')).toContain('Linux-only');
    expect(lines.join('\n')).not.toContain('readable by any process');
  });
});

describe('nothing here can take the daemon down', () => {
  test('a helper that cannot be built or whose symbol is missing is survived', () => {
    // The real shape of a musl host, a box with no system headers or a renamed
    // symbol: cc() throws out of load(), before anything is called.
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      loadSymbols: () => {
        throw new Error('"do_set_dumpable" is missing from the compiled source');
      },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.reason).toContain('do_set_dumpable');
    // And it says the hardening is NOT in place, rather than staying quiet.
    expect(lines.join('\n')).toContain('WITHOUT it');
  });

  test('a helper that loads but throws when called is survived too', () => {
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      symbols: {
        do_set_dumpable: () => {
          throw new Error('bad ffi call');
        },
        do_get_dumpable: () => 1,
      },
    });
    expect(outcome.kind).toBe('unavailable');
    expect(lines.join('\n')).toContain('continuing without it');
  });

  test('a prctl that returns an errno is reported, not thrown', () => {
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      symbols: { do_set_dumpable: () => 22, do_get_dumpable: () => 1 }, // 22 = EINVAL
    });
    expect(outcome).toEqual({ kind: 'refused', errno: 22 });
    expect(lines.join('\n')).toContain('errno 22');
  });

  test('a kernel that reports success without honouring it is called out', () => {
    // gVisor and some seccomp filters. Believing a control that is not in
    // effect is worse than not having it.
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 1 },
    });
    expect(outcome).toEqual({ kind: 'not-verified', dumpable: 1 });
    expect(lines.join('\n')).toContain('still readable');
  });

  test('an unreadable flag after a successful set is not claimed as hardened', () => {
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: () => {},
      warn: () => {},
      symbols: {
        do_set_dumpable: () => 0,
        do_get_dumpable: () => {
          throw new Error('no');
        },
      },
    });
    expect(outcome).toEqual({ kind: 'not-verified', dumpable: -1 });
  });
});

/**
 * The import guard. A non-dumpable ENGINE is the one way this change could
 * break #501 silently: identifyEngine() would catch the EACCES on its environ
 * and return null, so the reaper would stop reclaiming orphans AND the bundle
 * pruner would lose the protection that stops it deleting a `main.js` out from
 * under a running engine. Nothing but the daemon's own entry point may call
 * this module.
 */
describe('who may import this module', () => {
  test('only src/daemon/index.ts, plus the tests that stand a hardened owner up', () => {
    const SRC = resolve(import.meta.dir, '..');
    const REPO = resolve(SRC, '..');
    /*
     * Two separate bars, because the guard has to catch two different things.
     *
     * MAY IMPORT: pulls the module in and can call it. The bar is the daemon's
     * own entry point, or a TEST that deliberately stands a non-dumpable owner
     * up to prove the reaper and the #501 watchdog still work against one.
     * Production code an engine, a bundle or the CLI can reach never qualifies
     * -- a non-dumpable engine makes the reaper unable to identify it (#501).
     *
     * MAY MENTION: names the module without importing it, e.g. a comment
     * pointing at the test that pins something. Harmless in itself, but it has
     * to be listed, because "mentions it" is how this guard catches the import
     * idiom a specifier regex cannot see: a path built from string parts and
     * handed to a dynamic `import()`, which is exactly what the two engine
     * tests do.
     */
    const mayImport = new Set([
      join('src', 'daemon', 'index.ts'),
      join('src', 'daemon', 'process-hardening.ts'),
      join('src', 'daemon', 'process-hardening.test.ts'),
      // Stand-in daemons that harden themselves, then die, so the reap and the
      // in-engine watchdog are measured against a real non-dumpable owner.
      join('src', 'workflows', 'runner', 'engine-runtime', 'engine-reaper.test.ts'),
      join('src', 'workflows', 'runner', 'engine-runtime', 'engine-lifecycle.test.ts'),
    ]);
    const mayMention = new Set([
      ...mayImport,
      // A comment on descriptorPath pointing at the test that pins it. Listed
      // rather than exempted wholesale: an actual import from this file would
      // still fail the import check below, which is the point -- builtin.ts is
      // reachable from the tools.
      join('src', 'actions', 'tools', 'builtin.ts'),
    ]);

    /** A literal `from '...'` / `import('...')` / `require('...')` specifier. */
    const IMPORTS = /(?:from|import|require)\s*\(?\s*['"][^'"]*process-hardening(?:\.[cm]?[jt]sx?)?['"]/;

    const mentions: string[] = [];
    const imports: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf-8');
        const rel = full.slice(REPO.length + 1);
        if (text.includes('process-hardening')) mentions.push(rel);
        if (IMPORTS.test(text)) imports.push(rel);
      }
    };
    // Every code directory in the repo, derived rather than listed: a new
    // top-level dir must not slip past this guard silently. The denylist is
    // build output, dependencies and assets, none of which can import a
    // module.
    const skip = new Set(['node_modules', '.git', '.claude', 'dist', 'docs', 'ui', 'webapp-templates']);
    for (const entry of readdirSync(REPO, { withFileTypes: true })) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      walk(join(REPO, entry.name));
    }

    // Sanity: the walk actually found things, so an empty result can never be
    // a silently broken scan passing as "nobody imports it".
    expect(mentions.length).toBeGreaterThanOrEqual(mayImport.size);
    expect(mentions.filter((f) => !mayMention.has(f)).sort()).toEqual([]);
    expect(imports.filter((f) => !mayImport.has(f)).sort()).toEqual([]);
  });

  /*
   * And that the daemon passes the CONFIG value rather than a literal. The
   * guard above proves index.ts imports the module; an implementation that
   * hard-coded `true`, or read the wrong key, would satisfy every other test
   * in this file. Source text, because the alternative is booting a daemon.
   */
  /*
   * And the runtime half, which no text scan can give you: whatever route
   * reached this function, an ENGINE is never hardened. This is the failure
   * that would undo #501 silently, so it is refused rather than trusted to
   * the guard above.
   */
  test('refuses outright when the process carries the engine marker', () => {
    const lines: string[] = [];
    let called = false;
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      warn: log(lines),
      env: { [ENGINE_MARKER_ENV]: ENGINE_MARKER_VALUE },
      symbols: {
        do_set_dumpable: () => {
          called = true;
          return 0;
        },
        do_get_dumpable: () => 0,
      },
    });
    expect(outcome).toEqual({ kind: 'refused-engine-process' });
    expect(called).toBe(false);
    expect(lines.join('\n')).toContain('REFUSING');
    // Even with the hatch shut and everything else in order.
    expect(
      hardenProcessInspection({
        platform: 'linux',
        log: () => {},
        warn: () => {},
        env: { [ENGINE_MARKER_ENV]: ENGINE_MARKER_VALUE, OTHER: 'x' },
        symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 0 },
      }),
    ).toEqual({ kind: 'refused-engine-process' });
    // An unrelated env, or the marker with the wrong value, hardens as usual.
    expect(
      hardenProcessInspection({
        platform: 'linux',
        log: () => {},
        warn: () => {},
        env: { [ENGINE_MARKER_ENV]: 'some-other-value' },
        symbols: { do_set_dumpable: () => 0, do_get_dumpable: () => 0 },
      }),
    ).toEqual({ kind: 'hardened' });
  });

  test('the daemon passes the configured flag, not a literal', () => {
    const index = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');
    expect(index).toContain(
      'hardenProcessInspection({ allowInspection: jarvisConfig.daemon.allow_process_inspection })',
    );
  });
});

/**
 * The real thing, in a child process, on Linux only. This is the measurement
 * the whole change rests on, so it is asserted rather than described: after
 * the hardening the daemon's own environ is gone, and the two /proc reads that
 * #551 and #501 depend on still work.
 */
describe.skipIf(!IS_LINUX)('against a real process', () => {
  test('environ closes while /proc/self/fd and /proc/self/stat keep working', async () => {
    const dir = probeDir('jarvis-dumpable-');
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'hello', 'utf-8');
    const probe = join(dir, 'probe.ts');
    writeFileSync(
      probe,
      `
import { readFileSync, readlinkSync, openSync } from 'node:fs';
import { hardenProcessInspection } from ${JSON.stringify(MODULE.replace(/\.test\.ts$/, '.ts'))};

const fd = openSync(${JSON.stringify(target)}, 0);
const before = {
  environ: readFileSync('/proc/self/environ').length > 0,
  fd: readlinkSync('/proc/self/fd/' + fd),
};
const outcome = hardenProcessInspection({ log: () => {} });
const read = (f) => { try { return readFileSync(f).length > 0 ? 'ok' : 'empty'; } catch (e) { return e.code; } };
const field22 = () => {
  const s = readFileSync('/proc/self/stat', 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
};
// A child spawned FROM the non-dumpable process, for the runner to inspect:
// execve resets dumpable, which is the invariant the whole engine-reaping
// argument rests on. It lives long enough to be looked at, then exits.
const grandchild = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(8000)'], {
  stdout: 'ignore', stderr: 'ignore',
  env: { ...process.env, GRANDCHILD_MARKER: 'visible-to-the-reaper' },
});
grandchild.unref();
console.log(JSON.stringify({
  outcome,
  before,
  grandchildPid: grandchild.pid,
  after: {
    environ: read('/proc/self/environ'),
    stat: read('/proc/self/stat'),
    cgroup: read('/proc/self/cgroup'),
    field22: field22(),
    fd: (() => { try { return readlinkSync('/proc/self/fd/' + fd); } catch (e) { return e.code; } })(),
  },
}));
`,
      'utf-8',
    );

    const run = Bun.spawnSync([process.execPath, probe], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = run.stdout.toString().trim();
    if (!stdout) throw new Error(`probe printed nothing; stderr: ${run.stderr.toString()}`);
    const result = JSON.parse(stdout) as {
      outcome: { kind: string };
      before: { environ: boolean; fd: string };
      grandchildPid: number;
      after: { environ: string; stat: string; cgroup: string; field22: string; fd: string };
    };

    // It really did harden (if the kernel refused, say so rather than passing
    // a test that proved nothing).
    expect(result.outcome.kind).toBe('hardened');
    // Before: the environment was readable. That is what this closes.
    expect(result.before.environ).toBe(true);
    expect(result.before.fd).toBe(target);
    // After: gone, even to the process itself.
    expect(result.after.environ).toBe('EACCES');
    // But #551's descriptor->path readlink still answers,
    expect(result.after.fd).toBe(target);
    // and the field the engine owner-start stamp and the #501 watchdog read.
    expect(result.after.stat).toBe('ok');
    expect(result.after.field22).toMatch(/^\d+$/);
    // Container detection reads this one.
    expect(result.after.cgroup).toBe('ok');

    /*
     * And the invariant the entire engine-reaping argument rests on: execve
     * resets dumpable, so a child of the hardened daemon is readable. Asserted
     * HERE, next to the other measurements, as well as in the reaper's own
     * hardened test -- if that one file is ever skipped, this claim must not
     * go unpinned with it.
     *
     * (It holds for a same-uid, non-secureexec execve, which is every child
     * here: they are all this uid running `bun`. A setuid target or one the
     * kernel marks non-dumpable at exec would not inherit it back.)
     */
    try {
      const env = readFileSync(`/proc/${result.grandchildPid}/environ`, 'utf-8');
      expect(env.split('\0')).toContain('GRANDCHILD_MARKER=visible-to-the-reaper');
      expect(statSync(`/proc/${result.grandchildPid}`).uid).toBe(process.getuid!());
    } finally {
      try {
        process.kill(result.grandchildPid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }, 30_000);

  /**
   * #551 reads a file through the descriptor it actually opened and asks
   * `/proc/self/fd/<n>` where that descriptor landed, which is the only way on
   * Linux to know what was really opened after the path was classified. That
   * directory is reassigned to root when the daemon becomes non-dumpable, so
   * if the kernel stopped admitting the owning thread group, `descriptorPath()`
   * would start returning null and the TOCTOU close would quietly weaken.
   *
   * `descriptorPath` is called DIRECTLY here, because no integration fixture
   * can make it load-bearing: a hard-linked key gives `landed === filePath` by
   * construction, and a symlinked one is resolved identically by the pre-open
   * `resolveReal`, so both are refused by the inode pass in `secretRead()`
   * before `readJudgedFile` opens anything. An earlier version of this test
   * drove the tool against a hard link and believed it was covering the
   * descriptor route; it was not -- verified by mutation, it passed unchanged
   * with `descriptorPath()` stubbed to return null.
   */
  test('#551 descriptorPath still answers inside a non-dumpable process', async () => {
    const dir = probeDir('jarvis-dumpable-551-');
    const probe = join(dir, 'probe.ts');
    const builtin = resolve(import.meta.dir, '..', 'actions', 'tools', 'builtin.ts');
    writeFileSync(
      probe,
      `
import { mkdirSync, writeFileSync, symlinkSync, openSync, unlinkSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { hardenProcessInspection } from ${JSON.stringify(MODULE.replace(/\.test\.ts$/, '.ts'))};
import { descriptorPath } from ${JSON.stringify(builtin)};

const root = ${JSON.stringify(dir)};
mkdirSync(join(root, 'sub'), { recursive: true });
const real = join(root, 'sub', 'real.txt');
writeFileSync(real, 'contents\\n');
const link = join(root, 'via-symlink.txt');
symlinkSync(real, link);
const doomed = join(root, 'doomed.txt');
writeFileSync(doomed, 'gone soon\\n');

// Harden FIRST: every descriptorPath call below runs non-dumpable.
const outcome = hardenProcessInspection({ log: () => {} });

const plainFd = openSync(real, 0);
// Opened THROUGH a symlink: the kernel answers with the target, which is the
// whole point of asking the descriptor instead of trusting the path.
const symlinkFd = openSync(link, 0);
const procFd = openSync('/proc/self/status', 0);
const doomedFd = openSync(doomed, 0);
unlinkSync(doomed); // now the link name carries " (deleted)"

console.log('PROBE_RESULT ' + JSON.stringify({
  outcome,
  plain: descriptorPath(plainFd),
  throughSymlink: descriptorPath(symlinkFd),
  procfs: descriptorPath(procFd),
  deleted: descriptorPath(doomedFd),
  closed: descriptorPath(999999),
}));
closeSync(plainFd); closeSync(symlinkFd); closeSync(procFd); closeSync(doomedFd);
`,
      'utf-8',
    );

    // A minimal env: JARVIS_SECRETS_DIR and JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE
    // both feed the policy's candidate set, so a developer's shell must not be
    // able to change what this measures.
    const run = Bun.spawnSync([process.execPath, probe], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    const stdout = run.stdout.toString();
    const line = stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) {
      throw new Error(`probe printed no result; stdout: ${stdout}\nstderr: ${run.stderr.toString()}`);
    }
    expect(run.exitCode).toBe(0);
    const result = JSON.parse(line.slice('PROBE_RESULT '.length)) as {
      outcome: { kind: string };
      plain: string | null;
      throughSymlink: string | null;
      procfs: string | null;
      deleted: string | null;
      closed: string | null;
    };

    // The process really was hardened, so none of the below passes by accident.
    expect(result.outcome.kind).toBe('hardened');
    // The production function, not a readlink the test did itself.
    expect(result.plain).toBe(join(dir, 'sub', 'real.txt'));
    // `landed !== filePath`: the branch that exists to catch a swapped path.
    expect(result.throughSymlink).toBe(join(dir, 'sub', 'real.txt'));
    // The numeric re-spelling that gets reclassified by secretRead(landed).
    expect(result.procfs).toMatch(/^\/proc\/\d+\/status$/);
    // The `" (deleted)"` strip, which nothing else in the repo covers: without
    // it the suffix would be classified as part of the file name.
    expect(result.deleted).toBe(join(dir, 'doomed.txt'));
    expect(result.deleted).not.toContain('deleted');
    // And a descriptor that is not open still answers null rather than throwing.
    expect(result.closed).toBeNull();
  }, 60_000);

  /**
   * And the tool on top of it: the refusals and the reads #551 ships still
   * behave when the process serving them is non-dumpable. This does NOT cover
   * the descriptor route (see the test above for why); it covers that nothing
   * in the classifier degrades, and it names which control fired.
   */
  test('#551 read_file still refuses a key and still reads, inside a non-dumpable process', async () => {
    const dir = probeDir('jarvis-dumpable-551-tool-');
    const probe = join(dir, 'probe.ts');
    const builtin = resolve(import.meta.dir, '..', 'actions', 'tools', 'builtin.ts');
    const policy = resolve(import.meta.dir, '..', 'actions', 'tools', 'file-path-policy.ts');
    // One definition, interpolated into the probe AND into the assertion, so
    // an edit to either cannot leave `not.toContain` passing trivially.
    const MARKER = 'SYNTHETIC-KEY-MUST-NOT-APPEAR';
    writeFileSync(
      probe,
      `
import { mkdirSync, writeFileSync, linkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hardenProcessInspection } from ${JSON.stringify(MODULE.replace(/\.test\.ts$/, '.ts'))};
import { readFileTool, setDefaultCwd } from ${JSON.stringify(builtin)};
import { setDaemonDataRoots, setPolicyHome, setSiteProjectsDir } from ${JSON.stringify(policy)};

const root = ${JSON.stringify(dir)};
const home = join(root, 'home');
const dataDir = join(home, '.jarvis');
const projectsDir = join(dataDir, 'projects');
mkdirSync(projectsDir, { recursive: true });
mkdirSync(join(home, 'Documents'), { recursive: true });
writeFileSync(join(dataDir, '.secrets.key'), ${JSON.stringify(MARKER)} + '\\n');
writeFileSync(join(home, 'Documents', 'cv.txt'), 'an ordinary document\\n');
const alias = join(home, 'Documents', 'notes.txt');
linkSync(join(dataDir, '.secrets.key'), alias);
setPolicyHome(home);
setSiteProjectsDir(projectsDir);
setDaemonDataRoots({ dataDirs: [dataDir], secretsDirs: [dataDir] });
setDefaultCwd(null);

const outcome = hardenProcessInspection({ log: () => {} });
const read = async (p) => String(await readFileTool.execute({ path: p }));
const status = readFileSync('/proc/self/status', 'utf8');
console.log('PROBE_RESULT ' + JSON.stringify({
  outcome,
  // The kernel's own word for "this process is non-dumpable", read through
  // the tool's own process rather than inferred from the outcome.
  coreDumping: /^CoreDumping:\\s*(\\d+)/m.exec(status)?.[1] ?? 'absent',
  alias: await read(alias),
  ordinary: await read(join(home, 'Documents', 'cv.txt')),
  procfs: await read('/proc/self/status'),
}));
`,
      'utf-8',
    );

    const run = Bun.spawnSync([process.execPath, probe], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    const stdout = run.stdout.toString();
    // The policy logs refusals with console.warn, i.e. stderr: that line is
    // how we tell WHICH control refused, not just that something did.
    const stderr = run.stderr.toString();
    const line = stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) throw new Error(`probe printed no result; stdout: ${stdout}\nstderr: ${stderr}`);
    expect(run.exitCode).toBe(0);
    const result = JSON.parse(line.slice('PROBE_RESULT '.length)) as {
      outcome: { kind: string };
      coreDumping: string;
      alias: string;
      ordinary: string;
      procfs: string;
    };

    expect(result.outcome.kind).toBe('hardened');
    // Non-dumpable according to the kernel, in the very process that served
    // the reads below.
    expect(result.coreDumping).toBe('0');
    // The key is refused, by the credential rule and not by some other
    // "Access denied", and none of its bytes came back.
    expect(result.alias).toContain("holds Jarvis's own credentials");
    expect(result.alias).not.toContain(MARKER);
    expect(stderr).toContain('read_file refused: jarvis-key');
    // An ordinary file still reads.
    expect(result.ordinary).toContain('an ordinary document');
    // And a size-0 procfs file still reads through the descriptor rather than
    // by its reported size.
    expect(result.procfs).toContain('Pid:');
  }, 60_000);
  test('the escape hatch really leaves environ readable', async () => {
    const dir = probeDir('jarvis-dumpable-off-');
    const probe = join(dir, 'probe.ts');
    writeFileSync(
      probe,
      `
import { readFileSync } from 'node:fs';
import { hardenProcessInspection } from ${JSON.stringify(MODULE.replace(/\.test\.ts$/, '.ts'))};
const outcome = hardenProcessInspection({ allowInspection: true, log: () => {} });
let environ = 'unread';
try { environ = readFileSync('/proc/self/environ').length > 0 ? 'ok' : 'empty'; } catch (e) { environ = e.code; }
console.log(JSON.stringify({ outcome, environ }));
`,
      'utf-8',
    );
    const run = Bun.spawnSync([process.execPath, probe], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = run.stdout.toString().trim();
    if (!stdout) throw new Error(`probe printed nothing; stderr: ${run.stderr.toString()}`);
    expect(JSON.parse(stdout)).toEqual({ outcome: { kind: 'allowed-by-config' }, environ: 'ok' });
  }, 30_000);
});
