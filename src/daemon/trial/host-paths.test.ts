/**
 * The path translation, which is exactly the kind of thing that works on the
 * machine it was written on and silently does the wrong thing everywhere else.
 *
 * So every test here names the machine it is standing on. None of them asks
 * the real kernel what it is, none of them touches `/mnt`, and the three hosts
 * that matter (WSL, native Windows, Linux) are all exercised from whichever
 * one the suite happens to be running on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UNIX_HOST,
  WINDOWS_HOST,
  candidatePaths,
  detectHostShape,
  folderCandidates,
  isDriveRootPath,
  looksLikeWindowsPath,
  parseAutomountRoot,
  probeFolder,
  resolveIgnoringCase,
  sayPath,
  searchBases,
  windowsPathToHost,
  windowsProfiles,
  type HostProbe,
} from './host-paths.ts';

/** A machine, described rather than detected. */
function probe(over: Partial<HostProbe> = {}): HostProbe {
  return {
    platform: 'linux',
    env: {},
    readText: () => null,
    exists: () => false,
    ...over,
  };
}

const WSL = { kind: 'wsl' as const, driveRoot: '/mnt' };

/* ─────────────────────── which machine is this ─────────────────────── */

describe('detectHostShape', () => {
  test('WSL, from the environment every WSL2 session sets', () => {
    expect(detectHostShape(probe({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, exists: (p) => p === '/mnt/c' })))
      .toEqual({ kind: 'wsl', driveRoot: '/mnt' });
    expect(detectHostShape(probe({ env: { WSL_INTEROP: '/run/WSL/1_interop' }, exists: (p) => p === '/mnt/c' })).kind)
      .toBe('wsl');
  });

  test('WSL, from the kernel, when the environment was not inherited', () => {
    // A daemon started by systemd does not necessarily have WSL_DISTRO_NAME.
    const p = probe({
      readText: (path) => (path === '/proc/version' ? 'Linux version 6.6.87.2-microsoft-standard-WSL2' : null),
      exists: (path) => path === '/mnt/c',
    });
    expect(detectHostShape(p)).toEqual({ kind: 'wsl', driveRoot: '/mnt' });
  });

  test('WSL, from osrelease alone', () => {
    const p = probe({
      readText: (path) => (path === '/proc/sys/kernel/osrelease' ? '6.6.87.2-microsoft-standard-WSL2' : null),
      exists: (path) => path === '/mnt/c',
    });
    expect(detectHostShape(p).kind).toBe('wsl');
  });

  test('NATIVE WINDOWS is never WSL, so C:\\ keeps working there', () => {
    // The dangerous false positive: translating on Windows would break the one
    // machine where the founder's path is already correct.
    const p = probe({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } });
    expect(detectHostShape(p)).toEqual(WINDOWS_HOST);
    expect(windowsPathToHost('C:\\Users\\vieri\\Docs', detectHostShape(p))).toBeNull();
  });

  test('ORDINARY LINUX is not WSL, and gets no translation', () => {
    const p = probe({ readText: (path) => (path === '/proc/version' ? 'Linux version 6.8.0-51-generic' : null) });
    expect(detectHostShape(p)).toEqual(UNIX_HOST);
    expect(windowsPathToHost('C:\\Users\\vieri\\Docs', UNIX_HOST)).toBeNull();
  });

  test('macOS is not WSL either', () => {
    expect(detectHostShape(probe({ platform: 'darwin' }))).toEqual(UNIX_HOST);
  });

  test('a moved automount root is read out of /etc/wsl.conf', () => {
    const p = probe({
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      readText: (path) => (path === '/etc/wsl.conf' ? '[automount]\nroot = /windows/\n' : null),
      exists: (path) => path === '/windows/c',
    });
    expect(detectHostShape(p)).toEqual({ kind: 'wsl', driveRoot: '/windows' });
  });

  test('a wsl.conf that does not mention automount falls back to /mnt', () => {
    const p = probe({
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      readText: (path) => (path === '/etc/wsl.conf' ? '[boot]\nsystemd=true\n' : null),
      exists: (path) => path === '/mnt/c',
    });
    expect(detectHostShape(p).driveRoot).toBe('/mnt');
  });

  test('drives mounted at the root, which some setups do', () => {
    const p = probe({
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      readText: (path) => (path === '/etc/wsl.conf' ? '[automount]\nroot = /\n' : null),
      exists: (path) => path === '/c',
    });
    expect(detectHostShape(p).driveRoot).toBe('');
    expect(windowsPathToHost('C:\\x', detectHostShape(p))).toBe('/c/x');
  });
});

describe('parseAutomountRoot', () => {
  test('reads root only inside [automount], and strips quotes and slashes', () => {
    expect(parseAutomountRoot('[automount]\nroot = /mnt/\n')).toBe('/mnt');
    expect(parseAutomountRoot('[automount]\nroot="/win/"')).toBe('/win');
    expect(parseAutomountRoot('[network]\nroot = /nope/\n')).toBeNull();
    expect(parseAutomountRoot('[automount]\n# root = /commented/\n')).toBeNull();
    expect(parseAutomountRoot('')).toBeNull();
  });
});

/* ─────────────────────── the translation itself ─────────────────────── */

describe('windowsPathToHost', () => {
  test('the path a founder actually says', () => {
    expect(windowsPathToHost('C:\\Users\\vieri\\Documents', WSL)).toBe('/mnt/c/Users/vieri/Documents');
  });

  test('forward slashes, which is how half of them type it', () => {
    expect(windowsPathToHost('C:/Users/vieri/Documents', WSL)).toBe('/mnt/c/Users/vieri/Documents');
  });

  test('a lower case drive letter, and a drive that is not C', () => {
    expect(windowsPathToHost('d:\\work\\kestrel', WSL)).toBe('/mnt/d/work/kestrel');
    expect(windowsPathToHost('G:\\Shared drives\\Design', WSL)).toBe('/mnt/g/Shared drives/Design');
  });

  test('the bare drive, which is the whole disk and has to survive to be refused', () => {
    expect(windowsPathToHost('C:', WSL)).toBe('/mnt/c');
    expect(windowsPathToHost('C:\\', WSL)).toBe('/mnt/c');
    expect(isDriveRootPath('/mnt/c', WSL)).toBe(true);
    expect(isDriveRootPath('/mnt/c/Users', WSL)).toBe(false);
    expect(isDriveRootPath('/mnt/c', UNIX_HOST)).toBe(false);
  });

  test('the UNC path Explorer shows when they are looking at their WSL files', () => {
    expect(windowsPathToHost('\\\\wsl$\\Ubuntu\\home\\vieri\\kestrel', WSL)).toBe('/home/vieri/kestrel');
    expect(windowsPathToHost('\\\\wsl.localhost\\Ubuntu\\home\\vieri', WSL)).toBe('/home/vieri');
  });

  test('a Unix path is not a Windows path and is left alone', () => {
    expect(windowsPathToHost('/home/vieri/kestrel', WSL)).toBeNull();
    expect(windowsPathToHost('Documents', WSL)).toBeNull();
    expect(windowsPathToHost('~/kestrel', WSL)).toBeNull();
    expect(looksLikeWindowsPath('/home/vieri')).toBe(false);
    expect(looksLikeWindowsPath('C:\\x')).toBe(true);
  });

  test('nothing is translated on Windows or on Linux, whatever it looks like', () => {
    for (const shape of [WINDOWS_HOST, UNIX_HOST]) {
      expect(windowsPathToHost('C:\\Users\\vieri', shape)).toBeNull();
      expect(windowsPathToHost('\\\\wsl$\\Ubuntu\\home\\vieri', shape)).toBeNull();
    }
  });
});

describe('sayPath gives the founder back their own spelling', () => {
  test('under WSL, a mounted Windows path is said as Windows says it', () => {
    expect(sayPath('/mnt/c/Users/vieri/Documents', WSL)).toBe('C:\\Users\\vieri\\Documents');
    expect(sayPath('/mnt/c', WSL)).toBe('C:\\');
  });

  test('a Linux path under WSL is still a Linux path', () => {
    expect(sayPath('/home/vieri/kestrel', WSL)).toBe('/home/vieri/kestrel');
  });

  test('elsewhere it is the identity', () => {
    expect(sayPath('/home/vieri/kestrel', UNIX_HOST)).toBe('/home/vieri/kestrel');
    expect(sayPath('C:\\Users\\vieri', WINDOWS_HOST)).toBe('C:\\Users\\vieri');
  });
});

/* ───────────────── the real filesystem, in a temp directory ───────────────── */

let home: string;
let drive: string;
let shape: { kind: 'wsl'; driveRoot: string };

function put(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'host-home-'));
  drive = mkdtempSync(join(tmpdir(), 'host-drive-'));
  // A fake WSL mount: <drive>/c/Users/vieri, exactly the shape of the real one.
  mkdirSync(join(drive, 'c', 'Users', 'vieri'), { recursive: true });
  mkdirSync(join(drive, 'c', 'Users', 'Public'), { recursive: true });
  shape = { kind: 'wsl', driveRoot: drive };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(drive, { recursive: true, force: true });
});

describe('windowsProfiles', () => {
  test('finds the person and skips the accounts that are not people', () => {
    const profiles = windowsProfiles(shape);
    expect(profiles).toEqual([join(drive, 'c', 'Users', 'vieri')]);
  });

  test('is empty on a machine that is not WSL, whatever is on disk', () => {
    expect(windowsProfiles(UNIX_HOST)).toEqual([]);
    expect(windowsProfiles(WINDOWS_HOST)).toEqual([]);
  });
});

describe('searchBases', () => {
  test('the Linux home, the Windows profile, and the OneDrive inside it', () => {
    mkdirSync(join(drive, 'c', 'Users', 'vieri', 'OneDrive - Kestrel'), { recursive: true });
    const bases = searchBases(home, shape);
    expect(bases).toContain(home);
    expect(bases).toContain(join(drive, 'c', 'Users', 'vieri'));
    expect(bases).toContain(join(drive, 'c', 'Users', 'vieri', 'OneDrive - Kestrel'));
  });

  test('on Linux there is only the home', () => {
    expect(searchBases(home, UNIX_HOST)).toEqual([home]);
  });
});

describe('candidatePaths', () => {
  test('THE BUG: a Windows path no longer becomes a folder under the Linux home', () => {
    const said = 'C:\\Users\\vieri\\Documents';
    const candidates = candidatePaths(said, home, shape);
    expect(candidates).toContain(join(drive, 'c', 'Users', 'vieri', 'Documents'));
    // The old behaviour, and the reason it answered "there is no folder at
    // /home/vieri/C:\\Users\\vieri\\Documents".
    expect(candidates.some((c) => c.includes('C:\\'))).toBe(false);
  });

  test('on Linux the same string resolves the old way, because there is nowhere else', () => {
    const candidates = candidatePaths('C:\\Users\\vieri\\Documents', home, UNIX_HOST);
    expect(candidates).toEqual([join(home, 'C:\\Users\\vieri\\Documents')]);
  });

  test('a bare name is looked for on both sides of the boundary', () => {
    const candidates = candidatePaths('Documents', home, shape);
    expect(candidates[0]).toBe(join(home, 'Documents'));
    expect(candidates).toContain(join(drive, 'c', 'Users', 'vieri', 'Documents'));
  });

  test('an absolute Unix path is taken as it is', () => {
    expect(candidatePaths('/srv/kestrel', home, shape)[0]).toBe('/srv/kestrel');
  });

  test('~ still expands against the Linux home', () => {
    expect(candidatePaths('~/kestrel', home, shape)[0]).toBe(join(home, 'kestrel'));
  });
});

describe('resolveIgnoringCase', () => {
  test('documents finds Documents', () => {
    mkdirSync(join(home, 'Documents', 'Kestrel'), { recursive: true });
    expect(resolveIgnoringCase(home, 'documents')).toBe(join(home, 'Documents'));
    expect(resolveIgnoringCase(home, 'documents/kestrel')).toBe(join(home, 'Documents', 'Kestrel'));
    expect(resolveIgnoringCase(home, 'documents/nope')).toBeNull();
  });
});

describe('probeFolder', () => {
  test('counts what is in there and says how much of it is readable', () => {
    put(join(home, 'Kestrel', 'deck.md'));
    put(join(home, 'Kestrel', 'money', 'pricing.md'));
    put(join(home, 'Kestrel', 'logo.png'));
    const p = probeFolder(join(home, 'Kestrel'))!;
    expect(p.files).toBe(3);
    expect(p.readable).toBe(2);
  });

  test('a file is not a folder, and a missing path is not an error', () => {
    put(join(home, 'x.md'));
    expect(probeFolder(join(home, 'x.md'))).toBeNull();
    expect(probeFolder(join(home, 'nope'))).toBeNull();
  });
});

describe('folderCandidates', () => {
  test('offers real folders with content, on both sides, best first', () => {
    put(join(home, 'Projects', 'notes.md'));
    put(join(drive, 'c', 'Users', 'vieri', 'Documents', 'deck.md'));
    put(join(drive, 'c', 'Users', 'vieri', 'Documents', 'pricing.md'));
    put(join(drive, 'c', 'Users', 'vieri', 'Documents', 'plan.md'));
    const found = folderCandidates({ home, shape });
    const paths = found.map((f) => f.path);
    expect(paths).toContain(join(drive, 'c', 'Users', 'vieri', 'Documents'));
    expect(paths).toContain(join(home, 'Projects'));
    // Three readable beats one.
    expect(found[0]!.path).toBe(join(drive, 'c', 'Users', 'vieri', 'Documents'));
    expect(found[0]!.says).toBe('Documents, on Windows');
    expect(found.find((f) => f.path === join(home, 'Projects'))!.says).toBe('Projects');
  });

  test('an empty folder is not offered, because offering it is the original bug', () => {
    mkdirSync(join(home, 'Empty'), { recursive: true });
    expect(folderCandidates({ home, shape }).map((f) => f.path)).not.toContain(join(home, 'Empty'));
  });

  test('a folder the founder actually named is offered, not just the Microsoft ones', () => {
    put(join(drive, 'c', 'Users', 'vieri', 'Kestrel', 'deck.md'));
    expect(folderCandidates({ home, shape }).map((f) => f.path))
      .toContain(join(drive, 'c', 'Users', 'vieri', 'Kestrel'));
  });

  test('machine plumbing is never offered as somewhere the company lives', () => {
    put(join(drive, 'c', 'Users', 'vieri', 'AppData', 'Local', 'thing.json'));
    put(join(drive, 'c', 'Users', 'vieri', 'Recent', 'x.txt'));
    const paths = folderCandidates({ home, shape }).map((f) => f.path);
    expect(paths).not.toContain(join(drive, 'c', 'Users', 'vieri', 'AppData'));
    expect(paths).not.toContain(join(drive, 'c', 'Users', 'vieri', 'Recent'));
  });

  test('it suggests rather than enumerating: the list is capped', () => {
    for (let i = 0; i < 20; i++) put(join(home, `folder-${i}`, 'a.md'));
    expect(folderCandidates({ home, shape, limit: 4 }).length).toBe(4);
  });

  test('on a Linux box it never invents a Windows side', () => {
    put(join(home, 'Projects', 'notes.md'));
    const found = folderCandidates({ home, shape: UNIX_HOST });
    expect(found.every((f) => f.where === 'here')).toBe(true);
    expect(found.map((f) => f.path)).toContain(join(home, 'Projects'));
  });
});
