import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearStartOptions, daemonStartFlags, readStartOptions, recordStartOptions, restartStartArgs, startOptionsPath } from './start-options.ts';

let home: string;
let prevJarvisHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jarvis-start-options-test-'));
  // The record lives beside the lock: keep both off the real ~/.jarvis.
  prevJarvisHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = home;
});

afterEach(() => {
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  rmSync(home, { recursive: true, force: true });
});

describe('daemonStartFlags', () => {
  test('forwards every start option', () => {
    expect(daemonStartFlags({ port: 8080, dataDir: '/srv/jarvis', noLocalTools: true, systemConfigPath: '/etc/j.yaml' }))
      .toEqual(['--port', '8080', '--data-dir', '/srv/jarvis', '--no-local-tools', '--system-config', '/etc/j.yaml']);
  });

  test('forwards nothing for a plain start', () => {
    expect(daemonStartFlags({})).toEqual([]);
  });

  test('never forwards a value the child would read as a flag', () => {
    expect(daemonStartFlags({ dataDir: '-d', systemConfigPath: '--no-open' })).toEqual([]);
  });
});

describe('start option record', () => {
  test('round-trips for the pid that wrote it, beside the lock', () => {
    recordStartOptions(100, { port: 4100, dataDir: '/srv/jarvis', noLocalTools: true });

    expect(startOptionsPath()).toBe(join(home, 'daemon-start.json'));
    expect(statSync(startOptionsPath()).mode & 0o777).toBe(0o600);
    expect(readStartOptions(100)).toEqual({ port: 4100, dataDir: '/srv/jarvis', noLocalTools: true });
  });

  test('is not read for another pid', () => {
    recordStartOptions(100, { port: 4100 });

    expect(readStartOptions(101)).toBeNull();
  });

  test('a later start without options replaces the earlier one', () => {
    recordStartOptions(100, { port: 4100 });
    recordStartOptions(100, {});

    expect(readStartOptions(100)).toEqual({});
  });

  test('stores relative paths as the absolute paths the daemon used', () => {
    recordStartOptions(100, { dataDir: 'rel/data', systemConfigPath: 'rel/system.yaml' });

    expect(readStartOptions(100)).toEqual({ dataDir: resolve('rel/data'), systemConfigPath: resolve('rel/system.yaml') });
  });

  test('drops fields of the wrong shape from a hand-edited record', () => {
    writeFileSync(startOptionsPath(), JSON.stringify({
      pid: 100,
      options: { port: '4100', dataDir: '-d', noLocalTools: 'yes', systemConfigPath: 7 },
    }), { mode: 0o600 });
    chmodSync(startOptionsPath(), 0o600); // whatever the umask

    expect(readStartOptions(100)).toEqual({});
  });

  test('is 0600 even when it replaces a looser file, and never writes through a symlink', () => {
    writeFileSync(startOptionsPath(), '{}', { mode: 0o644 });
    chmodSync(startOptionsPath(), 0o644);
    recordStartOptions(100, { port: 4100 });
    expect(statSync(startOptionsPath()).mode & 0o777).toBe(0o600);

    rmSync(startOptionsPath());
    const target = join(home, 'elsewhere.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, startOptionsPath());
    recordStartOptions(100, { port: 4100 });
    expect(readFileSync(target, 'utf-8')).toBe('untouched');
    expect(lstatSync(startOptionsPath()).isSymbolicLink()).toBe(false);
    expect(readStartOptions(100)).toEqual({ port: 4100 });
    expect(existsSync(`${startOptionsPath()}.100.tmp`)).toBe(false);
  });

  test('ignores a record others can write, or one that is a symlink', () => {
    recordStartOptions(100, { port: 4100 });
    chmodSync(startOptionsPath(), 0o666);
    expect(readStartOptions(100)).toBeNull();

    rmSync(startOptionsPath());
    const planted = join(home, 'planted.json');
    writeFileSync(planted, JSON.stringify({ pid: 100, options: { port: 4100 } }), { mode: 0o600 });
    symlinkSync(planted, startOptionsPath());
    expect(readStartOptions(100)).toBeNull();
  });

  test('drops a relative or NUL-carrying path from a hand-edited record', () => {
    writeFileSync(startOptionsPath(), JSON.stringify({
      pid: 100,
      options: { port: 4100, dataDir: 'relative/data', systemConfigPath: '/etc/j\u0000.yaml' },
    }), { mode: 0o600 });
    chmodSync(startOptionsPath(), 0o600); // whatever the umask

    expect(readStartOptions(100)).toEqual({ port: 4100 });
  });

  test('the daemon clears its own record on exit, and only its own', () => {
    recordStartOptions(100, { port: 4100 });
    clearStartOptions(101);
    expect(readStartOptions(100)).toEqual({ port: 4100 });
    clearStartOptions(100);
    expect(existsSync(startOptionsPath())).toBe(false);
    clearStartOptions(100);
  });

  test('reads nothing when there is no record or it is not JSON', () => {
    expect(readStartOptions(100)).toBeNull();
    writeFileSync(startOptionsPath(), 'not json');
    expect(readStartOptions(100)).toBeNull();
    expect(readFileSync(startOptionsPath(), 'utf-8')).toBe('not json');
  });
});

describe('restartStartArgs', () => {
  const recorded = { port: 4100, dataDir: '/srv/jarvis', noLocalTools: true };

  test('restarts with the recorded options when none are given', () => {
    expect(restartStartArgs(['-d'], recorded)).toEqual({
      args: ['-d', '--port', '4100', '--data-dir', '/srv/jarvis', '--no-local-tools'],
      reused: ['--port', '4100', '--data-dir', '/srv/jarvis', '--no-local-tools'],
    });
  });

  test('uses exactly what it is given when any start option is given', () => {
    for (const args of [['--port', '5000'], ['--no-local-tools'], ['--data-dir', '/x'], ['--system-config', '/s.yaml'], ['--system-config=/s.yaml']]) {
      expect(restartStartArgs(args, recorded)).toEqual({ args, reused: [] });
    }
  });

  test('adds nothing without a record', () => {
    expect(restartStartArgs(['-d'], null)).toEqual({ args: ['-d'], reused: [] });
  });
});

// cmdStart cannot be driven here without starting a real daemon, so its two
// uses are pinned at the source: the detached child gets every option, and
// the foreground start (which the child also is) records them.
describe('bin/jarvis.ts cmdStart', () => {
  const source = readFileSync(join(import.meta.dir, '../../bin/jarvis.ts'), 'utf-8');
  const options = String.raw`\{\s*port,\s*dataDir,\s*noLocalTools,\s*systemConfigPath\s*\}`;

  test('hands the detached child every start option', () => {
    expect(source).toMatch(new RegExp(String.raw`'start',\s*'--no-open',\s*\.\.\.daemonStartFlags\(${options}\)\]`));
  });

  test('records the options of the daemon it starts, and clears them on exit', () => {
    expect(source).toMatch(new RegExp(String.raw`recordStartOptions\(process\.pid,\s*${options}\);`));
    expect(source).toContain("process.on('exit', () => { clearStartOptions(process.pid); releaseLock(); });");
  });

  test('restart reads the record before the stop and starts with what restartStartArgs returns', () => {
    const restart = source.slice(source.indexOf('async function cmdRestart'));
    const read = restart.indexOf('readStartOptions(pid)');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(restart.indexOf('await cmdStop()'));
    expect(restart).toContain('await cmdStart(start.args);');
  });
});
