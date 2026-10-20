/**
 * Absolute paths for the fixed system programs the daemon runs on the local
 * machine, so that none of them is found by name.
 *
 * Linux (#900): a bare `xclip` runs the first `xclip` on PATH, and a stock
 * PATH puts the user's own bin directories first. Measured on the dev machine
 * this was written on: ~/.local/bin and ~/.bun/bin ahead of /usr/local/bin and
 * /usr/bin, and `Bun.spawn(['xsel'])` ran a fake `xsel` placed in a directory
 * ahead of /usr/bin. A package whose bin entry is named `xclip` (bun links bin
 * entries even with lifecycle scripts off) would then see every clipboard
 * read. linuxSystemExe looks only in fixed system directories, and only takes
 * a program that nobody but root could have put or changed there.
 *
 * Native Windows (#907): see win32SystemExe. WSL's way to the Windows side
 * is windowsSystemExe in actions/terminal/wsl-bridge.ts, which finds the
 * Windows directory through the mount table instead.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, win32 } from 'node:path';

/**
 * Where the Linux tools are taken from, in this order: the directories a
 * package manager or an administrator installs into, plus NixOS's system
 * profile (its /usr/bin holds only `env`). Each must also pass the ownership
 * checks in linuxSystemExe, so a /usr/local/bin handed to a user (a common
 * way to let `npm -g` work without sudo) is skipped, not trusted.
 */
export const LINUX_SYSTEM_DIRS: readonly string[] = ['/usr/local/bin', '/usr/bin', '/bin', '/run/current-system/sw/bin'];

/** The Linux programs the daemon runs. A closed set, so each new one is a reviewed addition. */
export type LinuxSystemTool =
  | 'xdotool' | 'xprop' | 'wmctrl' | 'xclip' | 'xsel' | 'scrot' | 'import' | 'notify-send' | 'wslpath';

/** What linuxSystemExe reads from the filesystem; injectable for tests. */
export type ExeFs = {
  /** lstat: null when nothing is there. */
  lstat(path: string): { uid: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null;
  readlink(path: string): string | null;
  realpath(path: string): string | null;
};

const realFs: ExeFs = {
  lstat(path) {
    try {
      const s = lstatSync(path);
      return { uid: s.uid, mode: s.mode, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
    } catch {
      return null;
    }
  },
  readlink(path) {
    try { return readlinkSync(path); } catch { return null; }
  },
  realpath(path) {
    try { return realpathSync(path); } catch { return null; }
  },
};

/** Symlink hops followed before giving up, as the kernel's own limit. */
const MAX_LINKS = 40;

export type LinuxExeLookup =
  | { path: string }
  | { path: null; rejected: string[] };

export type LinuxExeOptions = {
  dirs?: readonly string[];
  fs?: ExeFs;
  /** Owners a directory or program may have. Root only, unless a test says otherwise. */
  owners?: readonly number[];
};

let dirsForTests: readonly string[] | null = null;

/**
 * @internal Test only: look in `dirs` instead of LINUX_SYSTEM_DIRS, and also
 * accept what this process's own user owns there (a test's fakes are not
 * root's). null restores both. Not reachable from the environment on purpose:
 * a variable that could move the lookup would be the PATH problem again.
 */
export function __setLinuxSystemDirsForTests(dirs: readonly string[] | null): void {
  dirsForTests = dirs;
}

function defaults(opts: LinuxExeOptions): Required<LinuxExeOptions> {
  const testing = dirsForTests !== null && opts.dirs === undefined;
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    dirs: opts.dirs ?? dirsForTests ?? LINUX_SYSTEM_DIRS,
    fs: opts.fs ?? realFs,
    owners: opts.owners ?? (testing ? [0, ownUid] : [0]),
  };
}

/**
 * Why `stat` cannot be trusted, or null when it can: owned by someone other
 * than `owners`, or writable by its group or by anyone.
 */
function untrusted(stat: { uid: number; mode: number }, owners: readonly number[]): string | null {
  if (!owners.includes(stat.uid)) return `owned by uid ${stat.uid}`;
  if ((stat.mode & 0o022) !== 0) return 'writable by its group or by others';
  return null;
}

/** The sticky bit: in such a directory only an entry's owner can rename or remove it. */
const STICKY = 0o1000;

/**
 * Why the directory `dir` (already resolved, no symlinks in it) cannot be
 * trusted, or null when it can: it and every directory above it, up to `/`,
 * must be owned by `owners` and not writable by its group or others (#900
 * review). Checking only `dir` would let whoever owns a parent (a `/usr/local`
 * handed to a user, an `/opt/x` above a root-owned `/opt/x/bin`) move `dir`
 * aside and put their own in its place. An ancestor that is writable by others
 * but sticky and root-owned (/tmp; /nix/store, which is 1775 root:nixbld)
 * passes, because the entry below it is checked in turn and only its owner
 * could replace it; `dir` itself gets no such exception, since a stranger
 * could add their own symlink beside a program there.
 */
function untrustedDir(dir: string, fs: ExeFs, owners: readonly number[]): string | null | 'missing' {
  const parts = dir.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const path = '/' + parts.slice(0, i).join('/');
    const stat = fs.lstat(path);
    if (!stat?.isDirectory) return 'missing';
    const problem = untrusted(stat, owners);
    if (!problem) continue;
    const stickyAncestor = i < parts.length && stat.uid === 0 && (stat.mode & STICKY) !== 0
      && problem === 'writable by its group or by others';
    if (!stickyAncestor) return `${path} is ${problem}`;
  }
  return null;
}

/**
 * Follow `candidate` to the program it names, checking every directory a hop
 * sits in (after resolving that directory's own symlinks), together with the
 * directories above it, and the program at the end. Returns null when it can
 * be trusted, the reason otherwise, or 'missing' when nothing is there.
 */
function checkChain(candidate: string, fs: ExeFs, owners: readonly number[]): string | null | 'missing' {
  let path = candidate;
  for (let hop = 0; hop <= MAX_LINKS; hop++) {
    const dir = fs.realpath(dirname(path));
    if (dir === null) return 'missing';
    const dirProblem = untrustedDir(dir, fs, owners);
    if (dirProblem) return dirProblem;
    const here = join(dir, basename(path));
    const stat = fs.lstat(here);
    if (stat === null) return 'missing';
    if (stat.isSymbolicLink) {
      const target = fs.readlink(here);
      if (target === null) return 'missing';
      path = isAbsolute(target) ? target : join(dir, target);
      continue;
    }
    if (!stat.isFile) return `${here} is not a regular file`;
    const problem = untrusted(stat, owners);
    if (problem) return `${here} is ${problem}`;
    if ((stat.mode & 0o111) === 0) return `${here} is not executable`;
    return null;
  }
  return `${candidate} has more than ${MAX_LINKS} symlinks`;
}

/**
 * Find `name` in the system directories without spawning anything. The path
 * returned is the one in the system directory, not where its symlinks lead:
 * wslpath is a link to /init, which decides what to be from argv[0], and
 * `import` is often an alternatives link. Every hop was checked, so the link
 * cannot be pointed somewhere else by anyone but root.
 */
export function findLinuxSystemExe(name: LinuxSystemTool, opts: LinuxExeOptions = {}): LinuxExeLookup {
  // Native Windows has no such directories: `/usr/bin` there would mean
  // \usr\bin on the current drive, which any user can create.
  if (process.platform === 'win32' && opts.fs === undefined) return { path: null, rejected: [] };
  const { dirs, fs, owners } = defaults(opts);
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    // /bin is /usr/bin on a merged-/usr system: look there once.
    const real = fs.realpath(dir);
    if (real !== null) {
      if (seen.has(real)) continue;
      seen.add(real);
    }
    const candidate = join(dir, name);
    const problem = checkChain(candidate, fs, owners);
    if (problem === null) return { path: candidate };
    if (problem !== 'missing') rejected.push(`${candidate} (${problem})`);
  }
  return { path: null, rejected };
}

/** Copies of `name` on PATH outside the system directories: named in the error, never run. */
function copiesElsewhereOnPath(name: string, dirs: readonly string[], fs: ExeFs): string[] {
  const system = new Set(dirs);
  const found: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || system.has(dir) || !isAbsolute(dir)) continue;
    const path = join(dir, name);
    if (fs.lstat(path) !== null && !found.includes(path)) found.push(path);
  }
  return found;
}

/** Thrown when a Linux tool is not installed where linuxSystemExe looks. */
export class SystemExeNotFoundError extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = 'SystemExeNotFoundError';
    this.tool = tool;
  }
}

/**
 * The absolute path of a Linux system tool, or a SystemExeNotFoundError that
 * says where it looked, which installed copies it would not use and why.
 */
export function linuxSystemExe(name: LinuxSystemTool, opts: LinuxExeOptions = {}): string {
  const found = findLinuxSystemExe(name, opts);
  if (found.path !== null) return found.path;
  const { dirs, fs } = defaults(opts);
  const notUsed = [
    ...found.rejected,
    ...copiesElsewhereOnPath(name, dirs, fs).map(p => `${p} (not a system directory)`),
  ];
  const where = found.rejected.length ? 'has no usable copy in a system directory' : 'is not installed in a system directory';
  throw new SystemExeNotFoundError(name,
    `${name} ${where} (${dirs.join(', ')})` +
    (notUsed.length ? `; not used: ${notUsed.map(homeAsTilde).join('; ')}` : ''));
}

/**
 * The home directory as `~`: the message can reach the model in a tool
 * result, which needs to know where a copy is, not the account's name.
 */
function homeAsTilde(text: string): string {
  const home = process.env.HOME;
  if (!home || home === '/' || !isAbsolute(home)) return text;
  return text.split(home.replace(/\/+$/, '') + '/').join('~/');
}

/** The Windows programs the daemon runs natively, under the Windows directory. */
const WIN32_SYSTEM_EXES = {
  'powershell.exe': ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'cmd.exe': ['System32', 'cmd.exe'],
} as const;
export type Win32SystemExe = keyof typeof WIN32_SYSTEM_EXES;

/**
 * A drive-absolute Windows path as the environment gives it, normalized, or
 * null unless it is a plain one: `C:\Windows`, not a relative path, a UNC
 * share (`\\server\share`, which would load the program from the network), a
 * device path (`\\?\`, `\\.\`), a path with `/` in it (which Windows also
 * reads as a separator, so `C:\Windows/../Users` would get past a `..` check
 * on `\` alone), a `.`/`..` or dots-and-spaces-only segment (Windows drops
 * trailing dots and spaces, so `.. ` can mean `..`), an alternate data stream
 * or a character no Windows path holds.
 */
export function win32AbsolutePath(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^[A-Za-z]:\\/.test(value)) return null;
  if (/[\x00-\x1f"*?<>|/]/.test(value) || value.indexOf(':', 2) !== -1) return null;
  const segments = value.slice(3).split('\\').filter(segment => segment !== '');
  if (segments.some(segment => /^[. ]+$/.test(segment))) return null;
  return win32.normalize(value).replace(/\\+$/, '');
}

/** Case-insensitive, as Windows reads its environment. */
export function win32EnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

function isWin32File(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

export type Win32ExeOptions = {
  env?: Record<string, string | undefined>;
  /**
   * Checks the program is there. Defaults to a real check on Windows and none
   * elsewhere (tests on Linux build the path only); null skips it.
   */
  isFile?: ((path: string) => boolean) | null;
};

/**
 * The absolute path of a Windows system program, under %SystemRoot% (or
 * %WINDIR%), never found by name (#907). With neither set to a plain
 * drive-absolute path it refuses rather than guess C:\Windows: on a machine
 * whose Windows is on another drive, C:\ may let any user create that folder.
 *
 * A bare name is searched for, and on Windows that search can start in the
 * working directory. Read from Bun's source: Bun 1.4 (src/which/lib.rs
 * which_for_spawn) looks in the working directory before PATH for every bare
 * name, as CreateProcessW does, unless NoDefaultCurrentDirectoryInExePath is
 * set; Bun 1.3.8 (js_bun_spawn_bindings.zig getArgv0) searched PATH itself
 * when the spawn's env had an exact-case `PATH` key or was inherited, but an
 * env object without one (Windows spells it `Path`, and a spread or filtered
 * copy keeps that spelling) handed the bare name to libuv, whose search looks
 * in the working directory first. An absolute path is not searched for at all.
 */
export function win32SystemExe(name: Win32SystemExe, opts: Win32ExeOptions = {}): string {
  const env = opts.env ?? process.env;
  const root = win32AbsolutePath(win32EnvValue(env, 'SystemRoot')) ?? win32AbsolutePath(win32EnvValue(env, 'WINDIR'));
  if (root === null) {
    throw new Error(`${name} was not run: neither %SystemRoot% nor %WINDIR% names the Windows directory`);
  }
  const path = win32.join(root, ...WIN32_SYSTEM_EXES[name]);
  const isFile = opts.isFile === undefined ? (process.platform === 'win32' ? isWin32File : null) : opts.isFile;
  if (isFile && !isFile(path)) {
    throw new Error(`${name} was not run: it is not at ${path}`);
  }
  return path;
}
