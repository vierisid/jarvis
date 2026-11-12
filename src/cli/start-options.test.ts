import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { daemonStartFlags, readStartOptions, recordStartOptions, startOptionsPath } from './start-options.ts';

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
    }));

    expect(readStartOptions(100)).toEqual({});
  });

  test('reads nothing when there is no record or it is not JSON', () => {
    expect(readStartOptions(100)).toBeNull();
    writeFileSync(startOptionsPath(), 'not json');
    expect(readStartOptions(100)).toBeNull();
    expect(readFileSync(startOptionsPath(), 'utf-8')).toBe('not json');
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

  test('records the options of the daemon it starts', () => {
    expect(source).toMatch(new RegExp(String.raw`recordStartOptions\(process\.pid,\s*${options}\);`));
  });
});
