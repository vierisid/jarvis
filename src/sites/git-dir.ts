/**
 * Site Builder — where a path lands, and which directories are git's.
 *
 * Shared by the site file tools (project-manager.ts, #516) and the generic
 * file tools' path policy (actions/tools/file-path-policy.ts, #522), so the
 * two answer "is this git's own file?" the same way. Each caller picks its
 * behaviour through options; neither has state here.
 */

import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isWithin, isWithinCI } from '../util/path.ts';

/** The symlink-hop budget, as the kernel's ELOOP limit. */
const MAX_LINK_HOPS = 40;

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── Where a path lands ───────────────────────────────────────────────────────

/**
 * How a dangling symlink on the way is treated.
 *
 * - `refuse` (the site file tools): the real path of `path` itself when it
 *   exists, else of its deepest existing ancestor with the missing tail
 *   appended. A component that exists only as a symlink -- its target is
 *   missing -- is refused rather than walked past: `Bun.write` through
 *   `x -> .git/new` creates `.git/new`, so a dangling link has to be judged
 *   by where it points, and where it points does not exist to be judged.
 *   Errors other than ENOENT/ENOTDIR are thrown. `path` is already resolved.
 *
 * - `follow` (the generic file tools' policy): resolved the way the kernel
 *   resolves `path` relative to `base` -- component by component, a symlink
 *   replaced by its target before the next component, so `h/../config` with
 *   `h -> .git/hooks` is `.git/config` where a lexical normalize says
 *   `config` -- and a dangling link followed by reading it, since a write
 *   through it creates its target. Once a component is missing the rest is
 *   appended as spelled. Never throws; an unreadable component counts as
 *   missing. On Windows (no kernel-order `..` to mirror) it is the realpath
 *   of the deepest existing ancestor.
 */
export type LandingOptions = { dangling: 'refuse'; requested: string } | { dangling: 'follow'; base?: string };

export function landingPath(path: string, opts: LandingOptions): string {
  return opts.dangling === 'refuse' ? realpathOfDeepest(path, opts.requested) : followPath(path, opts.base ?? '/');
}

function realpathOfDeepest(path: string, requested: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    if (isSymlink(current)) {
      throw new Error(`Access denied: "${requested}" goes through a symlink whose target does not exist`);
    }
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
}

function followPath(path: string, base: string): string {
  const start = isAbsolute(path) ? path : `${base}/${path}`;
  try {
    return realpathSync.native(start);
  } catch { /* missing, dangling, or unreadable: walk it */ }
  if (process.platform === 'win32') return realOfDeepestExisting(resolve(start));
  const pending = start.split('/').filter(Boolean).reverse();
  let current = '/';
  let missing = false;
  for (let hops = 0; pending.length > 0;) {
    const c = pending.pop()!;
    if (c === '.') continue;
    if (c === '..') { current = dirname(current); continue; }
    const next = current === '/' ? `/${c}` : `${current}/${c}`;
    if (!missing) {
      let target: string | null = null;
      try {
        if (lstatSync(next).isSymbolicLink() && ++hops <= MAX_LINK_HOPS) target = readlinkSync(next);
      } catch {
        missing = true;
      }
      if (target !== null) {
        if (isAbsolute(target)) current = '/';
        pending.push(...target.split('/').filter(Boolean).reverse());
        continue;
      }
    }
    current = next;
  }
  return current;
}

function realOfDeepestExisting(path: string): string {
  const tail: string[] = [];
  for (let current = path; ;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch { /* keep walking up */ }
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(current.slice(parent.length).replace(/^[\\/]/, ''));
    current = parent;
  }
}

/**
 * Where a git dir named by a gitfile or symlink really is -- or, when it does
 * not exist yet, where it WILL be once something creates it. A missing target
 * still has to be protected: a write that creates `gitdata/config` is exactly
 * the write that makes it a repository config.
 *
 * A dangling symlink on the way (`.git -> a`, `a -> b`, `b` missing) is
 * replaced by its target and resolution starts over, hop by hop, so the
 * answer is `b` -- where a write through the chain would land -- not `a`.
 */
function realOrLexical(path: string): string {
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    try {
      return realpathOfDeepest(current, current);
    } catch { /* a dangling link, or a loop */ }
    const link = deepestDanglingLink(current);
    if (!link) return current;
    let target: string;
    try {
      target = readlinkSync(link);
    } catch {
      return current;
    }
    current = join(resolve(dirname(link), target), relative(link, current));
  }
  return current;
}

/**
 * The component of `path` that stops realpathOfDeepest: walking up from the
 * path itself, the first one that exists only as a symlink.
 */
function deepestDanglingLink(path: string): string | null {
  let current = path;
  for (;;) {
    try {
      realpathSync(current);
      return null;
    } catch { /* missing, or dangling */ }
    if (isSymlink(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Git's own files ──────────────────────────────────────────────────────────

/**
 * The contents of `path` if it is a regular file (a symlink to one is fine;
 * git follows it too), else null. `commondir` sits in a directory the tree
 * may control, and a FIFO by that name would block the read -- and with it
 * every file-tool call -- forever. So the file is opened non-blocking and
 * checked on the open descriptor: a stat-then-read would let a FIFO be
 * swapped in between the two. Capped at `maxBytes` (64 KiB by default), since
 * the answer is one path. Throws when it cannot be opened at all.
 */
export function readRegularFile(path: string, maxBytes = 64 * 1024): string | null {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether `dir` is a git directory by git's own test (setup.c,
 * is_git_directory): a HEAD, plus objects/ and refs/ or a commondir file.
 * This recognises a git dir whatever it is called -- the target of a `.git`
 * gitfile or symlink, a linked worktree's gitdir, a bare repo -- without
 * following any pointer to it.
 */
export function isGitDirectory(dir: string): boolean {
  if (!exists(join(dir, 'HEAD'))) return false;
  return (isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'))) || exists(join(dir, 'commondir'));
}

export type LinkedGitDirOptions = {
  /**
   * Keep targets outside `root`. The site tools drop them (containment
   * already refuses anything outside the project); the generic file tools
   * have no containment and keep them, except a target that contains `root`
   * itself or `home` -- a `.git` pointing at `/` or the home dir would make
   * every path a git path, and git would not use such a dir either.
   */
  keepOutside?: boolean;
  /**
   * Resolve targets the way git does (strbuf_realpath): from where the
   * `.git` really is, in the kernel's order, dangling links followed
   * (landingPath `follow`). For a project that is itself a symlink, a
   * relative target like `../main/.git/worktrees/site` (what `git worktree
   * add --relative-paths` writes) is relative to the link's TARGET, not to the
   * link. The default resolves lexically from `root` as given, which is right
   * when `root` is already a real path, as the site tools' is.
   */
  kernelOrder?: boolean;
  /**
   * The largest gitfile or commondir read, default 64 KiB. Git itself reads a
   * gitfile up to 1 MiB, and strips only trailing newlines, so a caller with
   * no containment of its own reads as far as git does.
   */
  maxRead?: number;
  /**
   * Also return the real path of a `.git` that is an ordinary directory. For
   * a project reached through a symlink, that `.git` sits under a path no
   * site root contains.
   */
  includeDotGitDir?: boolean;
  /** The home dir excluded under keepOutside. */
  home?: string;
};

/**
 * Git directories of the project at `root` whose own path need not contain a
 * `.git` component: a `.git` that is a gitfile (`gitdir: <path>`, as linked
 * worktrees and absorbed submodules use) or a symlink, pointing at an
 * ordinary-looking directory, plus that directory's `commondir` for a linked
 * worktree. A target that does not exist yet, or sits at the end of a
 * dangling chain, is where a write would create it: creating it is what makes
 * it a repository. Only the ROOT `.git` is followed: a nested gitfile is not,
 * and the daemon never runs git there.
 */
export function linkedGitDirs(root: string, opts: LinkedGitDirOptions = {}): string[] {
  const dotGit = join(root, '.git');
  // Where `target` lands relative to `base`; `base` is a real path in the
  // kernel order (followPath resolves it), `root` as given otherwise.
  const at = (target: string, base: string) =>
    (opts.kernelOrder ? followPath(target, base) : realOrLexical(resolve(base, target)));
  const found: string[] = [];
  try {
    const st = lstatSync(dotGit);
    if (st.isSymbolicLink()) {
      found.push(opts.kernelOrder ? followPath(dotGit, '/') : realOrLexical(resolve(root, readlinkSync(dotGit))));
    } else if (st.isFile()) {
      // readRegularFile, though lstat just said "file": it may not be one by
      // the time it is opened.
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readRegularFile(dotGit, opts.maxRead) ?? '');
      if (match) found.push(at(match[1]!, opts.kernelOrder ? followPath(root, '/') : root));
    } else if (st.isDirectory() && opts.includeDotGitDir) {
      found.push(opts.kernelOrder ? followPath(dotGit, '/') : realOrLexical(dotGit));
    }
  } catch { /* no .git */ }
  for (const gitDir of [...found]) {
    try {
      const text = readRegularFile(join(gitDir, 'commondir'), opts.maxRead);
      if (text !== null) found.push(at(text.trim(), gitDir));
    } catch { /* not a linked worktree */ }
  }
  if (!opts.keepOutside) return found.filter((dir) => isWithin(dir, root));
  // Both spellings of the project: a symlinked project's real parent is an
  // ancestor too.
  const roots = [root, opts.kernelOrder ? followPath(root, '/') : realOrLexical(root)];
  return found.filter((dir) => !roots.some((r) => isWithinCI(r, dir)) && !(opts.home && isWithinCI(opts.home, dir)));
}
