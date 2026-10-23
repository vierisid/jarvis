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
import { lstatSync, readlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';

/**
 * Where the Linux tools are taken from, in this order: the directories a
 * package manager or an administrator installs into, plus NixOS's system
 * profile (its /usr/bin holds only `env`). Each must also pass the ownership
 * checks in linuxSystemExe, so a /usr/local/bin handed to a user (a common
 * way to let `npm -g` work without sudo) is skipped, not trusted. NixOS's
 * per-user profile follows them: see linuxSystemDirs.
 */
export const LINUX_SYSTEM_DIRS: readonly string[] = ['/usr/local/bin', '/usr/bin', '/bin', '/run/current-system/sw/bin'];

/** NixOS's per-user profile, whose user name the error shows as $USER. */
const PER_USER_PREFIX = '/etc/profiles/per-user/';

/**
 * LINUX_SYSTEM_DIRS, then NixOS's per-user profile for `user`
 * (/etc/profiles/per-user/<user>/bin, which NixOS builds as root from the
 * system configuration's per-user packages and links into the store). It is
 * checked like the others, so it is used only where root owns every step.
 * Left out unless `user` is a plain account name.
 */
export function linuxSystemDirs(user: string | null = currentUser()): readonly string[] {
  if (user === null || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) return LINUX_SYSTEM_DIRS;
  return [...LINUX_SYSTEM_DIRS, `${PER_USER_PREFIX}${user}/bin`];
}

let cachedUser: string | null | undefined;

/**
 * This process's account name from the password database, not $USER, or
 * null. Looked up once: the uid does not change, and the lookup can go
 * through NSS (LDAP and the like) on every call otherwise.
 */
function currentUser(): string | null {
  if (cachedUser === undefined) {
    try { cachedUser = userInfo().username || null; } catch { cachedUser = null; }
  }
  return cachedUser;
}

/** The Linux programs the daemon runs. A closed set, so each new one is a reviewed addition. */
export type LinuxSystemTool =
  | 'xdotool' | 'xprop' | 'wmctrl' | 'xclip' | 'xsel' | 'scrot' | 'import' | 'notify-send' | 'wslpath';

/** What linuxSystemExe reads from the filesystem; injectable for tests. */
export type ExeFs = {
  /** lstat: null when nothing is there. */
  lstat(path: string): { uid: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null;
  readlink(path: string): string | null;
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
  /** Whose NixOS per-user profile to search (see linuxSystemDirs); this process's user by default, null for none. */
  user?: string | null;
};

let dirsForTests: readonly string[] | null = null;

/**
 * @internal Test only: look in `dirs` instead of linuxSystemDirs(), and also
 * accept what this process's own user owns there (a test's fakes are not
 * root's). null restores both. Not reachable from the environment on purpose:
 * a variable that could move the lookup would be the PATH problem again.
 */
export function __setLinuxSystemDirsForTests(dirs: readonly string[] | null): void {
  dirsForTests = dirs;
}

function defaults(opts: LinuxExeOptions): Required<Omit<LinuxExeOptions, 'user'>> {
  const testing = dirsForTests !== null && opts.dirs === undefined;
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    dirs: opts.dirs ?? dirsForTests ?? (opts.user === undefined ? linuxSystemDirs() : linuxSystemDirs(opts.user)),
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

/** `problem` is a reason, or 'missing' when nothing is there. */
type Walked = { real: string } | { problem: string };

/**
 * Resolve `path` one component at a time, as the kernel does when it runs it,
 * and check that nobody but `owners` could change any step: every directory
 * passed through, every symlink followed (wherever it sits in the path, and
 * through every hop of its target) and, when `program` is set, the program at
 * the end. Returns the resolved path, or why it cannot be trusted ('missing'
 * when nothing is there).
 *
 * Each entry is judged by the directory holding it, since whoever can write
 * that directory can replace the entry (#900 review, re-review): checking only
 * where a directory resolves to would trust /usr/local/bin/xclip when
 * /usr/local/bin is a link to /usr/bin inside a /usr/local handed to a user,
 * who could re-point the link between this check and the spawn. A directory
 * that is writable by others but sticky and root-owned (/tmp; /nix/store,
 * which is 1775 root:nixbld) may hold an entry that `owners` own, because only
 * that entry's owner could replace it; the directory holding the program gets
 * no such exception, since a stranger could add their own symlink beside it.
 */
function walkChecked(path: string, fs: ExeFs, owners: readonly number[], program: boolean, links: { count: number }): Walked {
  const root = fs.lstat('/');
  if (!root?.isDirectory) return { problem: 'missing' };
  const rootProblem = untrusted(root, owners);
  if (rootProblem) return { problem: `/ is ${rootProblem}` };
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  let cur = '/';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (part === '..') {
      // Every directory above `cur` was passed through, and checked, on the way to it.
      cur = dirname(cur);
      continue;
    }
    const holder = fs.lstat(cur);
    if (!holder?.isDirectory) return { problem: 'missing' };
    const entry = join(cur, part);
    const stat = fs.lstat(entry);
    if (stat === null) return { problem: 'missing' };
    const holderProblem = untrusted(holder, owners);
    if (holderProblem) {
      const sticky = holder.uid === 0 && (holder.mode & STICKY) !== 0 && holderProblem === 'writable by its group or by others';
      if (!sticky || (program && last)) return { problem: `${cur} is ${holderProblem}` };
      if (!owners.includes(stat.uid)) return { problem: `${entry} is owned by uid ${stat.uid} in sticky ${cur}` };
    }
    if (stat.isSymbolicLink) {
      if (++links.count > MAX_LINKS) return { problem: `more than ${MAX_LINKS} symlinks` };
      const target = fs.readlink(entry);
      if (target === null) return { problem: 'missing' };
      // Not join(): it would settle a `..` in the target as text, while the
      // kernel takes it from wherever the components before it lead.
      const next = walkChecked(isAbsolute(target) ? target : `${cur}/${target}`, fs, owners, program && last, links);
      if (!('real' in next) || (program && last)) return next;
      cur = next.real;
      continue;
    }
    if (program && last) {
      if (!stat.isFile) return { problem: `${entry} is not a regular file` };
      const problem = untrusted(stat, owners);
      if (problem) return { problem: `${entry} is ${problem}` };
      if ((stat.mode & 0o111) === 0) return { problem: `${entry} is not executable` };
      return { real: entry };
    }
    if (!stat.isDirectory) return { problem: 'missing' };
    cur = entry;
  }
  return program ? { problem: 'missing' } : { real: cur };
}

/**
 * Whether anything, even a dangling link, is at `path`, found the way the
 * kernel would find it but without judging who owns what.
 */
function present(path: string, fs: ExeFs): boolean {
  let cur = '/';
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  for (let i = 0, links = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '..') { cur = dirname(cur); continue; }
    const entry = join(cur, part);
    const stat = fs.lstat(entry);
    if (stat === null) return false;
    if (i === parts.length - 1) return true;
    if (stat.isSymbolicLink) {
      const target = fs.readlink(entry);
      if (target === null || ++links > MAX_LINKS) return false;
      parts.splice(0, i + 1, ...(isAbsolute(target) ? target : `${cur}/${target}`).split('/').filter(p => p !== '' && p !== '.'));
      cur = '/';
      i = -1;
      continue;
    }
    if (!stat.isDirectory) return false;
    cur = entry;
  }
  return false;
}

/**
 * Why the program at `candidate` cannot be trusted, null when it can, or
 * 'missing' when nothing is there. See walkChecked.
 */
function checkChain(candidate: string, fs: ExeFs, owners: readonly number[]): string | null | 'missing' {
  const walked = walkChecked(candidate, fs, owners, true, { count: 0 });
  if ('real' in walked) return null;
  if (walked.problem === `more than ${MAX_LINKS} symlinks`) return `${candidate} has more than ${MAX_LINKS} symlinks`;
  return walked.problem;
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
  const reasons = new Set<string>();
  for (const dir of dirs) {
    const candidate = join(dir, name);
    const problem = checkChain(candidate, fs, owners);
    if (problem === null) return { path: candidate };
    // Refused on the way to a name that is not there (a group-writable
    // /usr/local/bin on Debian, root:staff 2775): nothing to report.
    if (problem !== 'missing' && !present(candidate, fs)) continue;
    // /bin is /usr/bin on a merged-/usr system: name the same reason once.
    // Every directory is still looked in, since a link to one can be
    // untrusted where the directory itself is not.
    if (problem !== 'missing' && !reasons.has(problem)) {
      reasons.add(problem);
      rejected.push(`${candidate} (${problem})`);
    }
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
  const user = opts.user === undefined ? currentUser() : opts.user;
  const notUsed = [
    ...found.rejected,
    ...copiesElsewhereOnPath(name, dirs, fs).map(p => `${p} (not a system directory)`),
  ];
  // The per-user profile is named only where NixOS has made one: elsewhere
  // it is noise in a message the model reads.
  const shown = fs.lstat(PER_USER_PREFIX.slice(0, -1)) === null ? dirs.filter(dir => !dir.startsWith(PER_USER_PREFIX)) : dirs;
  const where = found.rejected.length ? 'has no usable copy in a system directory' : 'is not installed in a system directory';
  throw new SystemExeNotFoundError(name, userAsVariable(
    `${name} ${where} (${shown.join(', ')})` +
    (notUsed.length ? `; not used: ${notUsed.map(homeAsTilde).join('; ')}` : ''), user));
}

/**
 * The per-user profile's account name as `$USER`, for the reason homeAsTilde
 * gives: the exact name, as a whole path segment after any `per-user/` (a
 * reason can name where the profile's link leads, such as
 * /etc/static/profiles/per-user/<user>), wherever the path ends.
 */
function userAsVariable(text: string, user: string | null): string {
  if (user === null) return text;
  const prefix = '/per-user/' + user;
  let out = '';
  let from = 0;
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + prefix.length)) {
    const next = text[at + prefix.length];
    if (next !== undefined && next !== '/' && next !== ' ' && next !== ')' && next !== ';') continue;
    out += text.slice(from, at) + '/per-user/$USER';
    from = at + prefix.length;
  }
  return out + text.slice(from);
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
 * trailing dots and spaces, so `.. ` can mean `..`), a bare drive root, an
 * alternate data stream or a character no Windows path holds.
 */
export function win32AbsolutePath(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^[A-Za-z]:\\/.test(value)) return null;
  if (/[\x00-\x1f"*?<>|/]/.test(value) || value.indexOf(':', 2) !== -1) return null;
  const segments = value.slice(3).split('\\').filter(segment => segment !== '');
  // A drive root alone names no directory to run from, and would normalize to `C:`, which is drive-relative.
  if (segments.length === 0 || segments.some(segment => /^[. ]+$/.test(segment))) return null;
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
