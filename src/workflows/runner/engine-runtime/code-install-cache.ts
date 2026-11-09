/**
 * The Bun install cache CODE-step installs use (#1154).
 *
 * Before, `bun install` for a CODE step used Bun's default cache,
 * `~/.bun/install/cache`: shared with everything else the user installs, never
 * pruned, and keeping the downloads of an install the step caps refused (a
 * 512 MiB install that was refused still left its packages in the cache).
 *
 * Now the installs use a cache of their own, `<code dir>/.install-cache`, set
 * through BUN_INSTALL_CACHE_DIR. Measured with bun 1.3.8: the variable wins
 * over both `--cache-dir` and a bunfig.toml `[install.cache] dir`, so a user's
 * own setting of either cannot point these installs elsewhere. Inside the code
 * directory on purpose: on the same filesystem as the trees, so Bun still
 * hard-links packages into them instead of copying, and under a dot name that
 * no version id can take, so the tree pruner never mistakes it for a version.
 *
 * Two rules keep it bounded:
 *   - an install that is refused or fails has the cache entries it added
 *     removed again. Installs run one at a time in this process
 *     (code-materialize.ts), so what appeared during one is that one's.
 *   - after every install the cache is trimmed to CODE_INSTALL_CACHE_MAX_BYTES,
 *     least recently used first. Bun does not touch an entry it reuses
 *     (measured: mtime unchanged on a warm install), so a successful install
 *     marks the entries of every package it installed as used.
 *
 * Bun's cache layout (bun 1.3.8), which is what "an entry" means here:
 *   <name>@<version>@@@<n>/            the extracted package
 *   @scope/<name>@<version>@@@<n>/     the same, scoped
 *   <name>/<version>@@@<n>             a symlink to the extracted package
 *   @scope/<name>/<version>@@@<n>      the same, scoped
 *   <hash>.npm                         a registry manifest (Bun rewrites it,
 *                                      and so its mtime, when it refreshes it)
 * Anything else at the top (a temporary directory an interrupted install left)
 * is an entry of its own.
 *
 * Removing an entry never breaks a tree: the tree holds hard links (or
 * copies) of the files, not references to the entry. A later install of the
 * same package just downloads it again.
 *
 * Another process sharing the code directory (an evaluation run) can have an
 * install of its own running while this one trims; it may then fail and is
 * retried by its next run.
 */
import { lstat, readdir, readFile, readlink, rm, rmdir, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { measureTree, type TreeLimit, type TreeSize } from "./code-tree-measure";

/**
 * Most bytes the CODE-step install cache keeps after a trim: about 1 GB, the
 * owner's budget (2026-11-06). Apparent size, as the step caps measure. For
 * scale: the largest single package measured for the step cap (googleapis)
 * installs to 246.5 MiB, so this holds it four times over.
 */
export const CODE_INSTALL_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Most entries (files, directories, links) the cache keeps, for the reason
 * the step caps have one: empty files measure next to nothing and still take
 * an inode each. In the step caps' own ratio: 1 GiB is twice the step byte
 * cap (512 MiB), so this is twice the step entry cap (65,536).
 */
export const CODE_INSTALL_CACHE_MAX_ENTRIES = 2 * 65_536;

export const CODE_INSTALL_CACHE_LIMIT: TreeLimit = {
  maxBytes: CODE_INSTALL_CACHE_MAX_BYTES,
  maxEntries: CODE_INSTALL_CACHE_MAX_ENTRIES,
};

/** The cache directory for the code directory `baseCodeDir`. */
export function codeInstallCacheDir(baseCodeDir: string): string {
  return resolve(baseCodeDir, ".install-cache");
}

const PACKAGE_ENTRY = /@@@\d+$/;

/**
 * The `name@version` an extracted package entry's name holds. Bun names it
 * `name@version@@@n` for the default registry and `name@version@@host@@@n`
 * for any other (measured, bun 1.3.8: `localdep@1.2.3@@127.0.0.1@@@1`); a
 * version never contains `@@`.
 */
function packageKey(entryName: string): string {
  return entryName.replace(PACKAGE_ENTRY, "").replace(/@@.*$/, "");
}

/** One cache entry: a path that is added, used and removed as a unit. */
interface CacheEntry {
  path: string;
  /** A symlink to an extracted package; follows its target out. */
  link: boolean;
}

/**
 * Every entry in the cache, as paths. A directory that is not a package
 * (a `<name>/` symlink holder or an `@scope/`) is looked into, two levels at
 * most, which is as deep as Bun's layout goes.
 */
export async function listCacheEntries(cacheDir: string): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) out.push({ path, link: true });
      // `@scope/` and `<name>/` (symlink holders) at the top, `<name>/` inside
      // a scope: looked into. Everything else is an entry.
      else if (entry.isDirectory() && !PACKAGE_ENTRY.test(entry.name) && !entry.name.startsWith(".") && depth < 2) {
        await walk(path, depth + 1);
      } else out.push({ path, link: false });
    }
  };
  await walk(resolve(cacheDir), 0);
  return out;
}

/** What `listCacheEntries` saw, to find what an install added. */
export async function snapshotCache(cacheDir: string): Promise<Set<string>> {
  return new Set((await listCacheEntries(cacheDir)).map((e) => e.path));
}

/**
 * Remove every entry that is not in `before`: what a refused or failed
 * install downloaded. Best effort; returns how many went.
 */
export async function removeCacheEntriesAddedSince(cacheDir: string, before: ReadonlySet<string>): Promise<number> {
  const added = (await listCacheEntries(cacheDir)).filter((e) => !before.has(e.path));
  await Promise.all(added.map((e) => rm(e.path, { recursive: true, force: true }).catch(() => {})));
  await removeEmptyHolders(cacheDir);
  return added.length;
}

/** `<name>/` and `@scope/` directories left empty by a removal. */
async function removeEmptyHolders(cacheDir: string): Promise<void> {
  const root = resolve(cacheDir);
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of top) {
    if (!entry.isDirectory() || PACKAGE_ENTRY.test(entry.name) || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    if (entry.name.startsWith("@")) {
      for (const inner of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (inner.isDirectory() && !PACKAGE_ENTRY.test(inner.name)) await rmdir(join(dir, inner.name)).catch(() => {});
      }
    }
    // Fails, as intended, unless it is empty.
    await rmdir(dir).catch(() => {});
  }
}

/**
 * Mark the cache entries of every package installed under `nodeModules` as
 * used now, so the trim keeps what installs keep needing. Reads each
 * package's own package.json for its name and version.
 */
export async function markInstalledPackagesUsed(cacheDir: string, nodeModules: string, now = new Date()): Promise<void> {
  const wanted = new Set<string>();
  const visit = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        await visit(path);
        continue;
      }
      try {
        const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (typeof pkg.name === "string" && typeof pkg.version === "string") wanted.add(`${pkg.name}@${pkg.version}`);
      } catch {
        // Not a package directory.
      }
      await visit(join(path, "node_modules"));
    }
  };
  await visit(resolve(nodeModules));
  if (wanted.size === 0) return;
  const root = resolve(cacheDir);
  for (const { path, link } of await listCacheEntries(root)) {
    if (link) continue;
    const name = basename(path);
    if (!PACKAGE_ENTRY.test(name)) continue;
    // `name@version...` or `@scope/name@version...`, keyed as `[@scope/]name@version`.
    const scope = basename(dirname(path));
    const key = (scope.startsWith("@") && dirname(dirname(path)) === root ? `${scope}/` : "") + packageKey(name);
    if (wanted.has(key)) await utimes(path, now, now).catch(() => {});
  }
}

export interface TrimResult {
  before: TreeSize;
  after: TreeSize;
  removed: string[];
}

/** What an entry measures to, itself included. */
async function entrySize(path: string): Promise<(TreeSize & { mtimeMs: number }) | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return { bytes: st.size, entries: 1, mtimeMs: st.mtimeMs };
  const inner = await measureTree(path);
  return { bytes: st.size + inner.bytes, entries: 1 + inner.entries, mtimeMs: st.mtimeMs };
}

const within = (size: TreeSize, limit: TreeLimit) => size.bytes <= limit.maxBytes && size.entries <= limit.maxEntries;

/**
 * Remove the least recently used entries until the cache holds at most
 * `limit`. A package entry and its symlink go together; an entry that could
 * not be removed is not counted as gone.
 */
export async function trimCodeInstallCache(cacheDir: string, limit: TreeLimit = CODE_INSTALL_CACHE_LIMIT): Promise<TrimResult> {
  const root = resolve(cacheDir);
  const entries = await listCacheEntries(root);
  const sized: Array<TreeSize & { path: string; mtimeMs: number }> = [];
  const links: string[] = [];
  const size: TreeSize = { bytes: 0, entries: 0 };
  for (const entry of entries) {
    if (entry.link) {
      links.push(entry.path);
      size.entries++;
      continue;
    }
    const measured = await entrySize(entry.path);
    if (!measured) continue;
    sized.push({ path: entry.path, ...measured });
    size.bytes += measured.bytes;
    size.entries += measured.entries;
  }
  const before = { ...size };
  const removed: string[] = [];
  if (!within(size, limit)) {
    sized.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of sized) {
      if (within(size, limit)) break;
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch {
        continue;
      }
      size.bytes -= entry.bytes;
      size.entries -= entry.entries;
      removed.push(entry.path);
    }
    // A symlink whose package went is dangling now.
    const gone = new Set(removed);
    for (const link of links) {
      const target = await readlink(link).catch(() => null);
      if (target === null || !gone.has(resolve(dirname(link), target))) continue;
      try {
        await rm(link, { force: true });
        size.entries--;
      } catch {
        // Left for the next trim.
      }
    }
    await removeEmptyHolders(root);
  }
  return { before, after: size, removed };
}

/**
 * How long the cache's size may be carried forward from the last full
 * measure before it is measured again: the tree pruner's interval. Between
 * full measures, an install only measures what it added. A full measure of a
 * synthetic 1,000-entry, 100,000-file cache took 665 ms on tmpfs (review of
 * #1154), and it runs inside the install queue, so it is not paid per install.
 * What another process sharing the cache adds meanwhile is seen at the next
 * full measure.
 */
export const CODE_INSTALL_CACHE_REMEASURE_MS = 60 * 60_000;

const known = new Map<string, { size: TreeSize; at: number }>();

/**
 * After a successful install: keep the cache within `limit`, measuring only
 * what the install added (the entries not in `before`) while a recent full
 * measure says the total is still within it, and trimming after a full
 * measure otherwise.
 */
export async function boundCacheAfterInstall(
  cacheDir: string,
  before: ReadonlySet<string>,
  limit: TreeLimit = CODE_INSTALL_CACHE_LIMIT,
  now = Date.now(),
): Promise<TrimResult | null> {
  const key = resolve(cacheDir);
  const last = known.get(key);
  if (last && now - last.at < CODE_INSTALL_CACHE_REMEASURE_MS) {
    const size = { ...last.size };
    for (const entry of await listCacheEntries(key)) {
      if (before.has(entry.path)) continue;
      const added = entry.link ? { bytes: 0, entries: 1 } : await entrySize(entry.path);
      if (!added) continue;
      size.bytes += added.bytes;
      size.entries += added.entries;
    }
    if (within(size, limit)) {
      known.set(key, { size, at: last.at });
      return null;
    }
  }
  const result = await trimCodeInstallCache(key, limit);
  known.set(key, { size: result.after, at: now });
  return result;
}

/** Forget carried-forward sizes. For tests. */
export function forgetCacheSizes(): void {
  known.clear();
}
