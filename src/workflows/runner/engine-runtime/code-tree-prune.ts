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
 *     unfinished runs, including paused ones, and of queued or running jobs);
 *   - no run in this process holds a lease on it (code-materialize.ts), so it
 *     is not being materialized or executed;
 *   - it was not used within `recentlyUsedMs` (24h, the engine bundle
 *     pruner's window), which is what covers another process sharing the
 *     directory, such as an evaluation run, whose leases this one cannot see.
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
import { codeTreeLeased } from "./code-materialize";
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
 * A pass is cheap: measured against 100,000 runs and 500 trees, the needed
 * query took 7.4 ms (median of 10) and the whole pass 24.8 ms.
 */
export const CODE_TREE_PRUNE_INTERVAL_MS = 60 * 60_000;

export interface PruneCodeTreesOptions {
  baseCodeDir: string;
  /** Version ids whose trees must stay; read synchronously, just before the sweep. */
  needed: () => ReadonlySet<string>;
  now?: number;
  recentlyUsedMs?: number;
  log?: (line: string) => void;
}

export interface PruneCodeTreesResult {
  removed: string[];
}

export async function pruneCodeTrees(opts: PruneCodeTreesOptions): Promise<PruneCodeTreesResult> {
  const base = resolve(opts.baseCodeDir);
  const now = opts.now ?? Date.now();
  const recentlyUsedMs = opts.recentlyUsedMs ?? DEFAULT_RECENTLY_USED_MS;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return { removed: [] };
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
  return { removed };
}

/**
 * Prune now and then every `intervalMs` until stopped. Passes never overlap,
 * a failing one is logged and the next still runs, and the timer does not
 * keep the process alive.
 */
export function startCodeTreeRetention(opts: {
  baseCodeDir: string;
  needed: () => ReadonlySet<string>;
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
