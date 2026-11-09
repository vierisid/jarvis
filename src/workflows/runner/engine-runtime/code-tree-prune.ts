/**
 * Prune `workflow-codes/<versionId>` trees nothing needs any more (#865).
 *
 * Every flow version that ever ran a CODE step got a tree, with a full
 * `node_modules` per step, and none was ever removed: not the versions a
 * later publish replaced, not drafts' old test runs once published, not the
 * scratch copies the prepared dry runner makes and deletes, not the versions
 * of deleted flows.
 *
 * A tree is removed only when ALL of these hold:
 *   - its version is not in `needed()` (db/repos/code-tree-retention.ts: the
 *     published version and current draft of each flow, and the versions of
 *     runs that can still continue and of queued or running jobs);
 *   - no run in this process holds a lease on it (code-materialize.ts), so it
 *     is not being materialized or executed;
 *   - it was not used within `recentlyUsedMs` (24h, the engine bundle
 *     pruner's window), which is what covers another process sharing the
 *     directory, such as an evaluation run, whose leases this one cannot see.
 *
 * Then, if the trees left hold more than `maxBytes` or `maxEntries` (#1154), the least
 * recently used are removed until they fit, needed or not, except a tree a
 * run that can still continue needs (`pinned()`), one a run in this process
 * leases, and one used within `inUseMs` (two lease refreshes: a run in
 * another process refreshes its tree's mtime every CODE_TREE_LEASE_REFRESH_MS).
 * A published version or current draft whose tree went installs again on its
 * next run, from the install cache.
 *
 * The lease check and the move out of the way happen in one synchronous step,
 * so a run in this process cannot start in between; the actual delete runs
 * afterwards, on a name no run will ever materialize to. Another process can
 * still touch a tree between the mtime read and the rename (a window of
 * microseconds); that run fails and its next run installs again.
 */

import { lstatSync, readdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { CODE_TREE_LEASE_REFRESH_MS, CODE_VERSION_TREE_LIMIT, codeTreeLeased, refreshLeasedCodeTrees } from "./code-materialize";
import { measureTree } from "./code-tree-measure";
import { DEFAULT_RECENTLY_USED_MS } from "./engine-reaper";

/** A tree moved out of the way and not yet deleted. */
const PRUNING_PREFIX = ".pruning-";
/** A version directory's name: what `apId()` makes, and nothing with a dot. */
const VERSION_DIR = /^[A-Za-z0-9_-]+$/;

/**
 * How often a running daemon prunes. A tree stops being needed when a run
 * finishes or a version is replaced, which is not an event anything here
 * hears about, and the recent-use window keeps it 24h after its last run in
 * any case; hourly bounds the time a tree outlives that window to an hour.
 * Measured against 100,000 runs and 500 trees, the needed query took 7.4 ms
 * (median of 10) and the sweep 24.8 ms. Since #1154 a pass also walks every
 * tree left to size it (measureTree: 99 ms for googleapis' 3,508 entries),
 * asynchronously, so that part costs time, not the event loop.
 */
export const CODE_TREE_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Most bytes the version trees together may hold after a prune (#1154), as
 * the step caps measure (apparent size): two versions at their own limit
 * (CODE_VERSION_TREE_LIMIT, 2 GiB), so one version can never take the whole
 * budget. The install cache has its own (code-install-cache.ts).
 */
export const CODE_TREES_MAX_BYTES = 2 * CODE_VERSION_TREE_LIMIT.maxBytes;
/** Most entries the version trees together may hold after a prune: two versions at their entry limit. */
export const CODE_TREES_MAX_ENTRIES = 2 * CODE_VERSION_TREE_LIMIT.maxEntries;

export interface PruneCodeTreesOptions {
  baseCodeDir: string;
  /** Version ids whose trees must stay; read synchronously, just before the sweep. */
  needed: () => ReadonlySet<string>;
  /**
   * Version ids whose trees stay even over the size budget. Read
   * synchronously just before the budget pass. Without it, nothing is
   * removed for size.
   */
  pinned?: () => ReadonlySet<string>;
  /** The size budget. Default CODE_TREES_MAX_BYTES. */
  maxBytes?: number;
  /** The entry budget. Default CODE_TREES_MAX_ENTRIES. */
  maxEntries?: number;
  /** A tree touched more recently than this is never removed for size. */
  inUseMs?: number;
  now?: number;
  recentlyUsedMs?: number;
  log?: (line: string) => void;
}

export interface PruneCodeTreesResult {
  removed: string[];
  /** Of `removed`, the trees removed only to get under the size budget. */
  evicted: string[];
}

export async function pruneCodeTrees(opts: PruneCodeTreesOptions): Promise<PruneCodeTreesResult> {
  const base = resolve(opts.baseCodeDir);
  // Leased trees first: a run whose refresh timer has not fired yet (after
  // the machine slept, say) still looks in use to another process's pruner.
  refreshLeasedCodeTrees();
  const now = opts.now ?? Date.now();
  const recentlyUsedMs = opts.recentlyUsedMs ?? DEFAULT_RECENTLY_USED_MS;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return { removed: [], evicted: [] };
  }
  // From here to the end of the loop nothing awaits: the needed set, the
  // leases and the renames are one consistent view.
  const needed = opts.needed();
  const removed: string[] = [];
  const doomed: string[] = [];
  for (const entry of entries) {
    const path = resolve(base, entry.name);
    if (entry.name.startsWith(PRUNING_PREFIX)) {
      // Left by a prune that did not finish.
      if (entry.isDirectory()) doomed.push(path);
      continue;
    }
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    if (needed.has(entry.name) || codeTreeLeased(path)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < recentlyUsedMs) continue;
    const away = resolve(base, `${PRUNING_PREFIX}${entry.name}-${randomBytes(4).toString("hex")}`);
    try {
      renameSync(path, away);
    } catch {
      continue;
    }
    doomed.push(away);
    removed.push(entry.name);
  }
  await Promise.all(doomed.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
  if (removed.length > 0) {
    opts.log?.(`removed ${removed.length} unused CODE-step tree(s) from ${base}`);
  }
  const evicted = opts.pinned ? await evictOverBudget(base, opts.pinned, opts, now) : [];
  return { removed: [...removed, ...evicted], evicted };
}

async function evictOverBudget(
  base: string,
  pinned: () => ReadonlySet<string>,
  opts: PruneCodeTreesOptions,
  now: number,
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? CODE_TREES_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? CODE_TREES_MAX_ENTRIES;
  const inUseMs = opts.inUseMs ?? 2 * CODE_TREE_LEASE_REFRESH_MS;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const trees: Array<{ name: string; path: string; bytes: number; entries: number }> = [];
  let total = 0, totalEntries = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    const path = resolve(base, entry.name);
    const size = await measureTree(path);
    trees.push({ name: entry.name, path, ...size });
    total += size.bytes;
    totalEntries += size.entries;
  }
  const fits = () => total <= maxBytes && totalEntries <= maxEntries;
  if (fits()) return [];
  // From here to the renames nothing awaits, as in the sweep above.
  const keep = pinned();
  const candidates = trees
    .map((t) => {
      try {
        return { ...t, mtimeMs: lstatSync(t.path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const evicted: string[] = [];
  const doomed: string[] = [];
  for (const tree of candidates) {
    if (fits()) break;
    if (keep.has(tree.name) || codeTreeLeased(tree.path) || now - tree.mtimeMs < inUseMs) continue;
    const away = resolve(base, `${PRUNING_PREFIX}${tree.name}-${randomBytes(4).toString("hex")}`);
    try {
      renameSync(tree.path, away);
    } catch {
      continue;
    }
    doomed.push(away);
    evicted.push(tree.name);
    total -= tree.bytes;
    totalEntries -= tree.entries;
  }
  await Promise.all(doomed.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
  if (evicted.length > 0) {
    opts.log?.(
      `removed ${evicted.length} least recently used CODE-step tree(s) from ${base} to keep them under ${maxBytes} bytes ` +
        `and ${maxEntries} entries` + (fits() ? "" : ` (still ${total} bytes in ${totalEntries} entries: the rest are in use)`),
    );
  }
  return evicted;
}

/**
 * Prune now and then every `intervalMs` until stopped. Passes never overlap,
 * a failing one is logged and the next still runs, and the timer does not
 * keep the process alive.
 */
export function startCodeTreeRetention(opts: {
  baseCodeDir: string;
  needed: () => ReadonlySet<string>;
  /** Required here, unlike in pruneCodeTrees: without it nothing is ever removed for size. */
  pinned: () => ReadonlySet<string>;
  maxBytes?: number;
  log?: (line: string) => void;
  intervalMs?: number;
}): { stop: () => void; idle: () => Promise<void> } {
  let current: Promise<void> = Promise.resolve();
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    current = pruneCodeTrees(opts)
      .then(() => {}, (e: unknown) => {
        opts.log?.(`CODE-step tree prune failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  pass();
  const timer = setInterval(pass, opts.intervalMs ?? CODE_TREE_PRUNE_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    idle: () => current,
  };
}
