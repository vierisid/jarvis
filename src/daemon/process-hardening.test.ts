import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, readlinkSync, openSync, closeSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hardenProcessInspection } from './process-hardening.ts';

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
      setDumpable: (v) => {
        calls.push(v);
        return 0;
      },
      getDumpable: () => 0,
    });
    expect(outcome).toEqual({ kind: 'hardened' });
    expect(calls).toEqual([0]);
    expect(lines.join('\n')).toContain('Process inspection blocked');
  });

  test('an absent flag hardens: the default is not "allow"', () => {
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: () => {},
      allowInspection: undefined,
      setDumpable: () => 0,
      getDumpable: () => 0,
    });
    expect(outcome).toEqual({ kind: 'hardened' });
  });

  test('the escape hatch skips the call entirely', () => {
    const lines: string[] = [];
    let called = false;
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      allowInspection: true,
      setDumpable: () => {
        called = true;
        return 0;
      },
      getDumpable: () => 1,
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
      allowInspection,
      setDumpable: () => 0,
      getDumpable: () => 0,
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
        setDumpable: () => {
          called = true;
          return 0;
        },
        getDumpable: () => 1,
      });
      expect(outcome).toEqual({ kind: 'unsupported', platform });
      expect(called).toBe(false);
      expect(lines.join('\n')).toContain('Linux-only');
    }
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
      setDumpable: () => {
        throw new Error('bad ffi call');
      },
      getDumpable: () => 1,
    });
    expect(outcome.kind).toBe('unavailable');
    expect(lines.join('\n')).toContain('continuing without it');
  });

  test('a prctl that returns an errno is reported, not thrown', () => {
    const lines: string[] = [];
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: log(lines),
      setDumpable: () => 22, // EINVAL
      getDumpable: () => 1,
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
      setDumpable: () => 0,
      getDumpable: () => 1,
    });
    expect(outcome).toEqual({ kind: 'not-verified', dumpable: 1 });
    expect(lines.join('\n')).toContain('still readable');
  });

  test('an unreadable flag after a successful set is not claimed as hardened', () => {
    const outcome = hardenProcessInspection({
      platform: 'linux',
      log: () => {},
      setDumpable: () => 0,
      getDumpable: () => {
        throw new Error('no');
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
  test('only src/daemon/index.ts, plus this test', () => {
    const SRC = resolve(import.meta.dir, '..');
    const REPO = resolve(SRC, '..');
    /*
     * Adding an entry here is a security decision, and the bar is narrow: the
     * importer must be the daemon's own entry point, or a TEST that deliberately
     * stands a non-dumpable owner up to prove the reaper and the #501 watchdog
     * still work against one. Production code that an engine, a bundle or the
     * CLI can reach never qualifies.
     */
    const allowed = new Set([
      join('src', 'daemon', 'index.ts'),
      join('src', 'daemon', 'process-hardening.ts'),
      join('src', 'daemon', 'process-hardening.test.ts'),
      // Stand-in daemons that harden themselves, then die, so the reap and the
      // in-engine watchdog are measured against a real non-dumpable owner.
      join('src', 'workflows', 'runner', 'engine-runtime', 'engine-reaper.test.ts'),
      join('src', 'workflows', 'runner', 'engine-runtime', 'engine-lifecycle.test.ts'),
    ]);

    const importers: string[] = [];
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
        // An import/require SPECIFIER, not any mention: a comment elsewhere
        // that names this module is fine, a module that pulls it in is not.
        if (/(?:from|import|require)\s*\(?\s*['"][^'"]*process-hardening(?:\.ts)?['"]/.test(text)) {
          importers.push(full.slice(REPO.length + 1));
        }
      }
    };
    for (const root of ['src', 'bin', 'scripts']) walk(join(REPO, root));

    expect(importers.filter((f) => !allowed.has(f)).sort()).toEqual([]);
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
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-dumpable-'));
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
console.log(JSON.stringify({
  outcome,
  before,
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
  }, 30_000);

  test('the escape hatch really leaves environ readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-dumpable-off-'));
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
