import { isAbsolute, relative, sep } from 'node:path';

export function isWithin(resolvedPath: string, basePath: string): boolean {
  const rel = relative(basePath, resolvedPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
