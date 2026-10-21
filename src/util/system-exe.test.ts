/**
 * #900: the Linux tools the daemon runs are taken from fixed system
 * directories, and only when nobody but root could have put or changed them
 * there. These tests drive findLinuxSystemExe/linuxSystemExe through an
 * injected filesystem, so ownership and modes can be anything; the last block
 * uses the real one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  LINUX_SYSTEM_DIRS, SystemExeNotFoundError, __setLinuxSystemDirsForTests, findLinuxSystemExe, linuxSystemExe, win32AbsolutePath, win32SystemExe,
  type ExeFs,
} from './system-exe.ts';

type Entry =
  | { kind: 'dir'; uid?: number; mode?: number }
  | { kind: 'file'; uid?: number; mode?: number }
  | { kind: 'link'; target: string; uid?: number };

/** A fake filesystem: absolute path -> entry. Parents must be listed too. */
function fakeFs(entries: Record<string, Entry>): ExeFs {
  const get = (path: string) => entries[posix.normalize(path)];
  return {
    lstat(path) {
      const entry = get(path);
      if (!entry) return null;
      if (entry.kind === 'link') return { uid: entry.uid ?? 0, mode: 0o120777, isFile: false, isDirectory: false, isSymbolicLink: true };
      return {
        uid: entry.uid ?? 0,
        mode: entry.mode ?? (entry.kind === 'dir' ? 0o40755 : 0o100755),
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'dir',
        isSymbolicLink: false,
      };
    },
    readlink(path) {
      const entry = get(path);
      return entry?.kind === 'link' ? entry.target : null;
    },
  };
}

/** The usual system layout: every LINUX_SYSTEM_DIRS entry root-owned, 0755. */
const SYSTEM: Record<string, Entry> = {
  '/': { kind: 'dir' },
  '/usr': { kind: 'dir' },
  '/usr/local': { kind: 'dir' },
  '/usr/local/bin': { kind: 'dir' },
  '/usr/bin': { kind: 'dir' },
  '/bin': { kind: 'link', target: 'usr/bin' },
  '/home': { kind: 'dir' },
  '/home/u': { kind: 'dir', uid: 1000 },
  '/home/u/.local': { kind: 'dir', uid: 1000 },
  '/home/u/.local/bin': { kind: 'dir', uid: 1000 },
  '/etc': { kind: 'dir' },
  '/etc/alternatives': { kind: 'dir' },
};

const UID = 1000;
const look = (entries: Record<string, Entry>, name: Parameters<typeof findLinuxSystemExe>[0] = 'xclip') =>
  findLinuxSystemExe(name, { fs: fakeFs({ ...SYSTEM, ...entries }) });

afterEach(() => __setLinuxSystemDirsForTests(null));

describe('findLinuxSystemExe (#900)', () => {
  test('looks in /usr/local/bin, /usr/bin, /bin and the NixOS system profile, in that order', () => {
    expect(LINUX_SYSTEM_DIRS).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/run/current-system/sw/bin']);
    expect(look({ '/usr/bin/xclip': { kind: 'file' } })).toEqual({ path: '/usr/bin/xclip' });
    expect(look({ '/usr/bin/xclip': { kind: 'file' }, '/usr/local/bin/xclip': { kind: 'file' } }))
      .toEqual({ path: '/usr/local/bin/xclip' });
  });

  test('a copy outside the system directories is never found, whatever PATH says', () => {
    expect(look({ '/home/u/.local/bin/xclip': { kind: 'file', uid: UID } })).toEqual({ path: null, rejected: [] });
  });

  test('a program not owned by root, or writable by its group or others, is skipped for the next directory', () => {
    for (const bad of [{ uid: UID }, { mode: 0o100775 }, { mode: 0o100757 }]) {
      expect(look({ '/usr/local/bin/xclip': { kind: 'file', ...bad }, '/usr/bin/xclip': { kind: 'file' } }))
        .toEqual({ path: '/usr/bin/xclip' });
    }
    const alone = look({ '/usr/local/bin/xclip': { kind: 'file', uid: UID } });
    expect(alone).toEqual({ path: null, rejected: ['/usr/local/bin/xclip (/usr/local/bin/xclip is owned by uid 1000)'] });
  });

  test('a system directory handed to a user (npm -g without sudo) is not trusted', () => {
    const userLocal = { '/usr/local/bin': { kind: 'dir', uid: UID } as Entry, '/usr/local/bin/xclip': { kind: 'file' } as Entry };
    expect(look(userLocal)).toEqual({ path: null, rejected: ['/usr/local/bin/xclip (/usr/local/bin is owned by uid 1000)'] });
    expect(look({ ...userLocal, '/usr/bin/xclip': { kind: 'file' } })).toEqual({ path: '/usr/bin/xclip' });
    expect(look({ '/usr/local/bin': { kind: 'dir', mode: 0o40777 }, '/usr/local/bin/xclip': { kind: 'file' } }))
      .toEqual({ path: null, rejected: ['/usr/local/bin/xclip (/usr/local/bin is writable by its group or by others)'] });
  });

  test('every directory above a checked one must be root\'s too (#900 review)', () => {
    // A /usr/local handed to a user above a root-owned bin: the user could
    // move bin aside and make their own.
    expect(look({ '/usr/local': { kind: 'dir', uid: UID }, '/usr/local/bin/xclip': { kind: 'file' }, '/usr/bin/xclip': { kind: 'file' } }))
      .toEqual({ path: '/usr/bin/xclip' });
    expect(look({ '/usr/local': { kind: 'dir', uid: UID }, '/usr/local/bin/xclip': { kind: 'file' } }))
      .toEqual({ path: null, rejected: ['/usr/local/bin/xclip (/usr/local is owned by uid 1000)'] });
    expect(look({ '/usr': { kind: 'dir', mode: 0o40775 }, '/usr/bin/xclip': { kind: 'file' } }).path).toBeNull();
    // Through a link: the hop's directory resolves under a user-owned parent.
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '/opt/x/bin/xclip' },
      '/opt': { kind: 'dir' }, '/opt/x': { kind: 'dir', uid: UID }, '/opt/x/bin': { kind: 'dir' }, '/opt/x/bin/xclip': { kind: 'file' },
    })).toEqual({ path: null, rejected: ['/usr/bin/xclip (/opt/x is owned by uid 1000)'] });
  });

  test('a root-owned sticky ancestor passes (the NixOS store); a sticky directory holding the program does not', () => {
    const nix: Record<string, Entry> = {
      '/run': { kind: 'dir' }, '/run/current-system': { kind: 'link', target: '/nix/store/abc-system' },
      '/nix': { kind: 'dir' }, '/nix/store': { kind: 'dir', mode: 0o41775 },
      '/nix/store/abc-system': { kind: 'dir', mode: 0o40555 }, '/nix/store/abc-system/sw': { kind: 'dir', mode: 0o40555 },
      '/nix/store/abc-system/sw/bin': { kind: 'dir', mode: 0o40555 },
      '/nix/store/abc-system/sw/bin/xclip': { kind: 'link', target: '/nix/store/def-xclip/bin/xclip' },
      '/nix/store/def-xclip': { kind: 'dir', mode: 0o40555 }, '/nix/store/def-xclip/bin': { kind: 'dir', mode: 0o40555 },
      '/nix/store/def-xclip/bin/xclip': { kind: 'file', mode: 0o100555 },
    };
    expect(look(nix)).toEqual({ path: '/run/current-system/sw/bin/xclip' });
    // The same store, owned by a user (single-user Nix): not root's.
    expect(look({ ...nix, '/nix/store': { kind: 'dir', uid: UID, mode: 0o41775 } }).path).toBeNull();
    // A sticky, world-writable directory holding the program itself.
    expect(look({ '/usr/local/bin': { kind: 'dir', mode: 0o41777 }, '/usr/local/bin/xclip': { kind: 'file' } }))
      .toEqual({ path: null, rejected: ['/usr/local/bin/xclip (/usr/local/bin is writable by its group or by others)'] });
  });

  test('a program that is not executable or not a regular file is skipped', () => {
    expect(look({ '/usr/bin/xclip': { kind: 'file', mode: 0o100644 } }))
      .toEqual({ path: null, rejected: ['/usr/bin/xclip (/usr/bin/xclip is not executable)'] });
    expect(look({ '/usr/bin/xclip': { kind: 'dir' } }).path).toBeNull();
  });

  test('a symlink is followed and every hop checked, and the path returned is the link, not its target', () => {
    // An alternatives link, as `import` often is.
    expect(look({
      '/usr/bin/import': { kind: 'link', target: '/etc/alternatives/import' },
      '/etc/alternatives/import': { kind: 'link', target: '../../usr/bin/import-im6.q16' },
      '/usr/bin/import-im6.q16': { kind: 'file' },
    }, 'import')).toEqual({ path: '/usr/bin/import' });
    // wslpath -> /init, which picks what to be from argv[0]: the link must be run.
    expect(look({ '/init': { kind: 'file' }, '/usr/bin/wslpath': { kind: 'link', target: '/init' } }, 'wslpath'))
      .toEqual({ path: '/usr/bin/wslpath' });
  });

  test('a link that leads through or into a directory a user controls is rejected', () => {
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '/home/u/.local/bin/xclip' },
      '/home/u/.local/bin/xclip': { kind: 'file' },
    }).path).toBeNull();
    // Through a user's link that currently points back at a root-owned file:
    // the user could re-point it at any time, so the chain is not trusted.
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '/home/u/.local/bin/hop' },
      '/home/u/.local/bin/hop': { kind: 'link', target: '/usr/bin/xclip-real' },
      '/usr/bin/xclip-real': { kind: 'file' },
    }).path).toBeNull();
  });

  test('every component of the path run is checked, not only where its directories resolve to (#900 re-review)', () => {
    // /usr/local handed to a user, with /usr/local/bin a link to /usr/bin:
    // the files are root's, but the user can re-point /usr/local/bin between
    // the check and the spawn, so /usr/local/bin/xclip must not be returned.
    const userLocalLink: Record<string, Entry> = {
      '/usr/local': { kind: 'dir', uid: UID }, '/usr/local/bin': { kind: 'link', target: '/usr/bin' }, '/usr/bin/xclip': { kind: 'file' },
    };
    expect(look(userLocalLink)).toEqual({ path: '/usr/bin/xclip' });
    expect(look({ ...userLocalLink, '/usr/bin/xclip': { kind: 'file', mode: 0o100644 } })).toEqual({
      path: null,
      rejected: ['/usr/local/bin/xclip (/usr/local is owned by uid 1000)', '/usr/bin/xclip (/usr/bin/xclip is not executable)'],
    });
    // The same through a later hop: a root link whose target passes through a
    // user-owned directory's link back into root-owned ones.
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '/opt/x/bin/xclip' },
      '/opt': { kind: 'dir' }, '/opt/x': { kind: 'dir', uid: UID }, '/opt/x/bin': { kind: 'link', target: '/usr/lib/xclip' },
      '/usr/lib': { kind: 'dir' }, '/usr/lib/xclip': { kind: 'dir' }, '/usr/lib/xclip/xclip': { kind: 'file' },
    })).toEqual({ path: null, rejected: ['/usr/bin/xclip (/opt/x is owned by uid 1000)'] });
    // A link in a root-owned sticky directory: only its owner can replace it,
    // so it must be root's.
    const stickyLink: Record<string, Entry> = {
      '/usr/bin/xclip': { kind: 'link', target: '/tmp/d/xclip' },
      '/tmp': { kind: 'dir', mode: 0o41777 }, '/tmp/d': { kind: 'link', target: '/usr/lib' },
      '/usr/lib': { kind: 'dir' }, '/usr/lib/xclip': { kind: 'file' },
    };
    expect(look(stickyLink)).toEqual({ path: '/usr/bin/xclip' });
    expect(look({ ...stickyLink, '/tmp/d': { kind: 'link', target: '/usr/lib', uid: UID } }))
      .toEqual({ path: null, rejected: ['/usr/bin/xclip (/tmp/d is owned by uid 1000 in sticky /tmp)'] });
  });

  test('`..` in a link target is taken from where the link before it leads, as the kernel does (#900 re-review)', () => {
    // sub/../xclip-real is not xclip-real beside the link: sub leads into
    // a user's directory, and `..` from there is the user's home.
    const viaUserDir: Record<string, Entry> = {
      '/usr/bin/sub': { kind: 'link', target: '/home/u/d' }, '/home/u/d': { kind: 'dir', uid: UID },
      '/usr/bin/xclip-real': { kind: 'file' }, '/home/u/xclip-real': { kind: 'file', uid: UID },
    };
    for (const target of ['sub/../xclip-real', '/usr/bin/sub/../xclip-real']) {
      expect(look({ ...viaUserDir, '/usr/bin/xclip': { kind: 'link', target } }))
        .toEqual({ path: null, rejected: ['/usr/bin/xclip (/home/u is owned by uid 1000)'] });
    }
    // Through root's own directories `..` is fine.
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '../lib/x/../xclip-real' },
      '/usr/lib': { kind: 'dir' }, '/usr/lib/x': { kind: 'dir' }, '/usr/lib/xclip-real': { kind: 'file' },
    })).toEqual({ path: '/usr/bin/xclip' });
  });

  test('the last hop may not end in a sticky directory either (#900 re-review)', () => {
    expect(look({
      '/usr/bin/xclip': { kind: 'link', target: '/tmp/xclip' }, '/tmp': { kind: 'dir', mode: 0o41777 }, '/tmp/xclip': { kind: 'file' },
    })).toEqual({ path: null, rejected: ['/usr/bin/xclip (/tmp is writable by its group or by others)'] });
  });

  test('a symlink loop is rejected, not followed forever', () => {
    const result = look({
      '/usr/bin/xclip': { kind: 'link', target: '/usr/bin/xclip-b' },
      '/usr/bin/xclip-b': { kind: 'link', target: '/usr/bin/xclip' },
    });
    expect(result.path).toBeNull();
    expect((result as { rejected: string[] }).rejected[0]).toContain('has more than 40 symlinks');
  });
});

describe('linuxSystemExe (#900)', () => {
  test('throws a SystemExeNotFoundError naming where it looked and the copies it did not use', () => {
    const saved = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '/home/u/.local/bin:/usr/bin';
    process.env.HOME = '/home/u';
    try {
      const fs = fakeFs({ ...SYSTEM, '/home/u/.local/bin/xclip': { kind: 'file', uid: UID }, '/usr/local/bin/xclip': { kind: 'file', uid: UID } });
      let error: unknown;
      try { linuxSystemExe('xclip', { fs }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(SystemExeNotFoundError);
      expect((error as SystemExeNotFoundError).tool).toBe('xclip');
      expect((error as Error).message).toBe(
        'xclip has no usable copy in a system directory (/usr/local/bin, /usr/bin, /bin, /run/current-system/sw/bin); ' +
        'not used: /usr/local/bin/xclip (/usr/local/bin/xclip is owned by uid 1000); ~/.local/bin/xclip (not a system directory)');
      // Nothing there at all: not installed.
      expect(() => linuxSystemExe('xsel', { fs: fakeFs(SYSTEM) })).toThrow(
        'xsel is not installed in a system directory (/usr/local/bin, /usr/bin, /bin, /run/current-system/sw/bin)');
    } finally {
      process.env.PATH = saved;
      process.env.HOME = savedHome;
    }
  });

  test('returns the path when it is there', () => {
    expect(linuxSystemExe('xdotool', { fs: fakeFs({ ...SYSTEM, '/usr/bin/xdotool': { kind: 'file' } }) })).toBe('/usr/bin/xdotool');
  });
});

describe.skipIf(process.platform === 'win32')('on the real filesystem', () => {
  test('the test seam trusts this user\'s own files only while it is set; root\'s are trusted either way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-system-exe-'));
    try {
      writeFileSync(join(dir, 'xclip'), '#!/bin/sh\n');
      chmodSync(join(dir, 'xclip'), 0o755);
      __setLinuxSystemDirsForTests([dir]);
      expect(findLinuxSystemExe('xclip')).toEqual({ path: join(dir, 'xclip') });
      chmodSync(join(dir, 'xclip'), 0o775);
      expect(findLinuxSystemExe('xclip').path).toBeNull();
      chmodSync(join(dir, 'xclip'), 0o755);
      // Explicit dirs, no seam: root only.
      __setLinuxSystemDirsForTests(null);
      const own = findLinuxSystemExe('xclip', { dirs: [dir] });
      if (process.getuid?.() === 0) expect(own.path).toBe(join(dir, 'xclip'));
      else expect(own.path).toBeNull();
      // A link to a root-owned program, from the seam's directory.
      __setLinuxSystemDirsForTests([dir]);
      rmSync(join(dir, 'xclip'));
      symlinkSync('/bin/sh', join(dir, 'xclip'));
      expect(findLinuxSystemExe('xclip')).toEqual({ path: join(dir, 'xclip') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('win32SystemExe (#907)', () => {
  const PS = ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'].join('\\');

  test('builds the path from %SystemRoot%, read case-insensitively as Windows does', () => {
    expect(win32SystemExe('powershell.exe', { env: { SystemRoot: 'D:\\Windows' }, isFile: null })).toBe(`D:\\Windows\\${PS}`);
    expect(win32SystemExe('powershell.exe', { env: { SYSTEMROOT: 'D:\\Windows\\' }, isFile: null })).toBe(`D:\\Windows\\${PS}`);
  });

  test('falls back to %WINDIR%, and refuses rather than guess C:\\Windows when neither is usable', () => {
    expect(win32SystemExe('powershell.exe', { env: { windir: 'E:\\WINNT' }, isFile: null })).toBe(`E:\\WINNT\\${PS}`);
    expect(win32SystemExe('powershell.exe', { env: { SystemRoot: 'C:Windows', WINDIR: 'D:\\Windows' }, isFile: null })).toBe(`D:\\Windows\\${PS}`);
    expect(() => win32SystemExe('powershell.exe', { env: {}, isFile: null }))
      .toThrow('powershell.exe was not run: neither %SystemRoot% nor %WINDIR% names the Windows directory');
  });

  test('a SystemRoot that is not a plain drive-absolute path is not used', () => {
    for (const bad of ['Windows', '.\\Windows', 'C:Windows', '\\\\evil\\share\\Windows', '\\\\?\\C:\\Windows', 'C:\\Windows\\..\\Users\\x',
      'C:\\Win"dows', 'C:\\Windows:stream', 'C:\\Windows::$DATA', '/mnt/c/Windows', '',
      // #907 review: Windows also reads `/` as a separator, and drops
      // trailing dots and spaces, so these reach outside C:\Windows too.
      'C:\\Windows/../Users/x', 'C:\\Windows/../..', 'C:/Windows', 'C:\\Windows\\.. \\Users', 'C:\\Windows\\. \\x', 'C:\\Windows\\...',
      'C:\\Win\ndows', 'C:\\Win\tdows']) {
      expect(() => win32SystemExe('powershell.exe', { env: { SystemRoot: bad }, isFile: null })).toThrow('neither %SystemRoot% nor %WINDIR%');
    }
  });

  test('a drive root alone is not a Windows directory, and no path collapses to a bare drive (#907 re-review)', () => {
    for (const root of ['C:\\', 'C:\\\\', 'D:\\\\\\']) {
      expect(win32AbsolutePath(root)).toBeNull();
      expect(() => win32SystemExe('powershell.exe', { env: { SystemRoot: root }, isFile: null })).toThrow('neither %SystemRoot% nor %WINDIR%');
    }
    expect(win32AbsolutePath('C:\\Windows\\')).toBe('C:\\Windows');
    expect(win32AbsolutePath('C:\\Windows\\\\System32')).toBe('C:\\Windows\\System32');
  });

  test('cmd.exe is under System32', () => {
    expect(win32SystemExe('cmd.exe', { env: { SystemRoot: 'C:\\Windows' }, isFile: null })).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  test('refuses, naming the path, when the program is not there', () => {
    const seen: string[] = [];
    expect(() => win32SystemExe('powershell.exe', { env: { SystemRoot: 'D:\\Windows' }, isFile: (p) => { seen.push(p); return false; } }))
      .toThrow(`powershell.exe was not run: it is not at D:\\Windows\\${PS}`);
    expect(seen).toEqual([`D:\\Windows\\${PS}`]);
  });

  test.skipIf(process.platform === 'win32')('off Windows the default builds the path without checking it', () => {
    expect(win32SystemExe('powershell.exe', { env: { SystemRoot: 'C:\\Windows' } })).toBe(`C:\\Windows\\${PS}`);
  });
});
