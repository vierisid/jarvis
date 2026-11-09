/**
 * Measuring a directory tree's apparent size (#865), shared by the CODE-step
 * materializer, the tree pruner and the install cache. Its own module so the
 * install cache (code-install-cache.ts) and the materializer, which uses it,
 * do not import each other.
 */
import { lstat, opendir } from "node:fs/promises";
import { resolve } from "node:path";

/** What a tree measured to. A walk stopped at a limit reports what it saw. */
export interface TreeSize {
  bytes: number;
  entries: number;
}

/** The caps a tree is held to. */
export interface TreeLimit {
  maxBytes: number;
  maxEntries: number;
}

export function overLimit(size: TreeSize, limit: TreeLimit): boolean {
  return size.bytes > limit.maxBytes || size.entries > limit.maxEntries;
}

/** lstat calls in flight at once during a walk. */
const WALK_BATCH = 64;

/**
 * Apparent size and entry count of everything under `dir`: `lstat` sizes,
 * directories included, symlinks never followed. Entries that vanish mid-walk
 * (an install still moving files) are skipped; a missing `dir` is empty.
 *
 * Directories are streamed and stat'ed WALK_BATCH at a time, so memory does
 * not grow with the size of one directory, and with `stopPast` the walk ends
 * as soon as the answer to "is it over?" is yes.
 */
export async function measureTree(dir: string, stopPast?: TreeLimit): Promise<TreeSize> {
  const size: TreeSize = { bytes: 0, entries: 0 };
  const pending = [dir];
  const statBatch = async (base: string, names: string[]) => {
    const stats = await Promise.all(names.map((n) => lstat(resolve(base, n)).catch(() => null)));
    for (let i = 0; i < names.length; i++) {
      const st = stats[i];
      if (!st) continue;
      size.entries++;
      size.bytes += st.size;
      if (st.isDirectory()) pending.push(resolve(base, names[i]!));
    }
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue;
    }
    let batch: string[] = [];
    try {
      for await (const entry of handle) {
        batch.push(entry.name);
        if (batch.length < WALK_BATCH) continue;
        await statBatch(current, batch);
        batch = [];
        if (stopPast && overLimit(size, stopPast)) return size;
      }
    } catch {
      // The directory went away mid-read; what was read is counted.
    }
    if (batch.length > 0) await statBatch(current, batch);
    if (stopPast && overLimit(size, stopPast)) return size;
  }
  return size;
}
