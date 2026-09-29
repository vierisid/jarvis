import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizedEnv } from '../../util/subprocess-env';

/** Version 2 hashes a framed inventory, including unstaged working-tree deletions. */
export function fingerprintSource(root: string, pathspecs: string[]) {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
    '--', ...pathspecs], { cwd: root, env: sanitizedEnv() }).toString().split('\0').filter(Boolean);
  const sourcePaths = [...new Set(listed)].sort();
  const entries = sourcePaths.map(path => {
    const absolute = join(root, path);
    // Only an absent entry is a deletion. Unreadable files, directories and
    // broken symlinks must still fail, rather than masquerading as a valid snapshot.
    if (!lstatSync(absolute, { throwIfNoEntry: false })) return { path, state: 'deleted' as const };
    return { path, state: 'present' as const,
      sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
  });
  return {
    sourceFingerprintVersion: 2,
    sourceSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    sourcePaths,
    deletedSourcePaths: entries.filter(entry => entry.state === 'deleted').map(entry => entry.path),
  };
}
