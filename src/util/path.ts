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
