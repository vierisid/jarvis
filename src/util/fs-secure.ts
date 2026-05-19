/**
 * File system helpers for handling local secrets safely.
 *
 * - `secureDirectory` / `secureParentDirectory` create or tighten directory
 *   permissions to 0o700 by default so secrets stored under them cannot leak
 *   to other local users.
 * - `secureWriteFile` writes secret data with `O_NOFOLLOW` so a hostile or
 *   stale symlink at the target path cannot redirect the write to an
 *   unrelated file (e.g. `~/.bash_history`).
 * - `chmodWithWarning` re-applies a mode after writes (defeating the process
 *   umask) and surfaces failures via `console.warn` instead of silently
 *   swallowing them.
 */

import { chmod, mkdir, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';

/** Create `dirPath` (recursively) and chmod it to `mode` (default 0o700). */
export async function secureDirectory(dirPath: string, mode: number = 0o700): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode });
  await chmod(dirPath, mode);
}

/**
 * Secure the parent directory of `filePath`.
 *
 * Skips when `dirname` resolves to `.` or `''` so callers that pass a
 * bare-relative path (e.g. `config.yaml`) don't end up chmod'ing the current
 * working directory.
 */
export async function secureParentDirectory(filePath: string, mode: number = 0o700): Promise<void> {
  const dir = dirname(filePath);
  if (dir === '.' || dir === '') return;
  await secureDirectory(dir, mode);
}

/**
 * Write `data` to `filePath` with the requested `mode`, using `O_NOFOLLOW`
 * so the open call fails (with `ELOOP`) if `filePath` is a symlink. This
 * prevents an attacker (or stale state) from redirecting a secret write to
 * an unrelated target.
 *
 * Re-chmods after the write to defeat the process umask, and surfaces
 * chmod failures via `console.warn` (labeled with `label`).
 *
 * Note: `O_NOFOLLOW` is a POSIX feature; on Windows the constant is `0` and
 * has no effect, which matches Node's behavior for the rest of the path
 * constants.
 */
export async function secureWriteFile(
  filePath: string,
  data: string | Uint8Array,
  mode: number,
  label: string,
): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await open(filePath, flags, mode);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  await chmodWithWarning(filePath, mode, label);
}

/** Chmod with a `console.warn` on failure rather than silently swallowing. */
export async function chmodWithWarning(filePath: string, mode: number, label: string): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[${label}] Failed to chmod ${filePath} to ${mode.toString(8)}: ${message}`);
  }
}
