import { isAbsolute, relative, sep } from 'node:path';

/**
 * Strict path-containment check.
 *
 * Returns true iff `resolvedPath` is `basePath` itself or a descendant of it.
 *
 * Both arguments are expected to be absolute, already-resolved paths. We rely
 * on `path.relative` rather than `startsWith`, because string-prefix checks
 * accept sibling-prefix traversal (e.g. base `/foo/app` matching `/foo/app-backup`).
 *
 * - `rel === ''` is the same-directory case (resolvedPath === basePath) and is allowed.
 * - `rel === '..'` and `rel.startsWith('..' + sep)` mean we'd have to walk up out
 *   of basePath, so the path escapes containment.
 * - `isAbsolute(rel)` catches the Windows case where `relative` returns an
 *   absolute path (e.g. different drive letters), which also means escape.
 */
export function isWithin(resolvedPath: string, basePath: string): boolean {
  const rel = relative(basePath, resolvedPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Code points HFS+ drops when it compares names, so `.g\u200cit` opens `.git`
 * on a Mac. The same list git uses for `is_hfs_dotgit` (CVE-2014-9390).
 */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Whether one path component names a git directory on SOME filesystem.
 *
 * Deliberately wider than `name === '.git'`, following git's own
 * `is_ntfs_dotgit`/`is_hfs_dotgit`: a case-insensitive filesystem opens `.GIT`
 * as `.git`, Windows strips trailing dots and spaces (`.git.`, `.git `) and
 * reads `.git::$INDEX_ALLOCATION` as the directory itself, NTFS gives `.git`
 * the 8.3 short name `GIT~1`, and HFS+ ignores the code points above. All of
 * them are refused on every platform: a false positive costs a name nobody
 * uses on purpose, a false negative costs the repository's config.
 *
 * `.gitignore`, `.gitkeep`, `.github` and `repo.git` are not matches.
 */
export function isGitDirName(name: string): boolean {
  return /^(?:\.git|git~\d+)[. ]*(?::.*)?$/.test(name.replace(HFS_IGNORABLE, '').toLowerCase());
}
