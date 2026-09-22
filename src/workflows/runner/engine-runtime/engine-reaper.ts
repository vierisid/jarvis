/**
 * Reclaiming engines and bundles that no longer belong to anyone.
 *
 * Two jobs, both run at daemon start:
 *
 *   1. REAP an engine subprocess whose owner is gone. The engine's own orphan
 *      watchdog (engine-lifecycle.ts) handles this from the inside, but only
 *      for bundles built since that shim existed -- a cache can hold older
 *      ones, and a machine can be carrying an orphan from before this fix
 *      landed at all. This is the outside view, and unlike the watchdog it
 *      also reports what it found.
 *   2. PRUNE the bundle cache. Each distinct engine source state produces a
 *      new content-addressed bundle directory and nothing ever removed the
 *      old ones: 13 bundles / 93MB when #491 was filed, growing with every
 *      change to a patched vendor source.
 *
 * WHAT COUNTS AS "AN ENGINE OF OURS"
 *
 * This module signals processes it did not spawn, on a machine that may be
 * running several checkouts, other developers' daemons, and unrelated Bun
 * processes. So identification is deliberately narrow and every condition
 * must hold:
 *
 *   - the process is owned by OUR uid;
 *   - its environment carries our exact versioned marker;
 *   - its argv contains the bundle path recorded in its own environment, and
 *     that path ends in `main.js`. This is not redundant with the marker: the
 *     engine spawns CODE actions with no env of their own, so user code
 *     inherits the marker too -- but it runs `bun --eval`, never a bundle
 *     path, so the argv check excludes it. (Deleting the vars from
 *     `process.env` inside the engine would not help: Bun's spawn still
 *     passes on the original environment block.)
 *   - its owner pid is no longer alive, or is alive but started at a
 *     different time than recorded -- i.e. the number was recycled.
 *
 * Anything that fails a check is left strictly alone. There is no pattern
 * matching on process names or command lines anywhere in here, which is the
 * mistake that makes a reaper dangerous on a shared machine (the pre-commit
 * hook's `pkill -f engine-bundle` matched nothing at all, but the next
 * pattern someone reaches for would match everything).
 */

import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENGINE_BUNDLE_ENV,
  ENGINE_MARKER_ENV,
  ENGINE_MARKER_VALUE,
  ENGINE_OWNER_PID_ENV,
  ENGINE_OWNER_START_ENV,
  ENGINE_STARTED_AT_ENV,
} from "./engine-lifecycle";
import { ENGINE_BUILD_PATHS, bundleHash } from "./build";

/** An engine process found on this machine. */
export interface FoundEngine {
  pid: number;
  /** Absolute path of the bundle it is running. */
  bundlePath: string;
  /** Pid recorded at spawn as its owner. */
  ownerPid: number;
  /** Epoch ms recorded at spawn, or null when absent/unparseable. */
  startedAt: number | null;
  /** True when the owner is gone (or its pid has been recycled). */
  orphaned: boolean;
}

export interface ReapOptions {
  /** Root to scan. Tests point this at a fixture tree. Default `/proc`. */
  procRoot?: string;
  /** Signal sender. Tests substitute a recorder. Default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Milliseconds between SIGTERM and SIGKILL. Default 2000. */
  graceMs?: number;
  /** Log sink for what was reclaimed. Default: silent. */
  log?: (line: string) => void;
}

const DEFAULT_GRACE_MS = 2_000;

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

/** Parse a NUL-separated /proc environ blob into a map. */
function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/**
 * Process start time in clock ticks since boot (`/proc/<pid>/stat` field 22).
 * `comm` (field 2) may contain spaces and parens, so fields are counted from
 * after the LAST ')': the first token there is field 3, making field 22 index
 * 19.
 */
function startTimeOf(procRoot: string, pid: number): string | null {
  try {
    const stat = readFileSync(resolve(procRoot, String(pid), "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const started = fields[19];
    return started && /^\d+$/.test(started) ? started : null;
  } catch {
    return null;
  }
}

/** Is `ownerPid` still the same process it was when the engine was spawned? */
function ownerIsAlive(
  procRoot: string,
  ownerPid: number,
  recordedStart: string | undefined,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    kill(ownerPid, 0);
  } catch (e) {
    // EPERM means the pid exists but belongs to someone else -- a recycled
    // pid, not our owner. Only ESRCH is "definitely gone", but either way it
    // is not the process that spawned this engine.
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EPERM" ? true : false;
  }
  if (!recordedStart) return true; // no start time recorded: pid alone stands
  const current = startTimeOf(procRoot, ownerPid);
  if (current === null) return true; // can't tell; assume alive (never over-kill)
  return current === recordedStart;
}

/**
 * Every engine process on this machine that we can positively identify as
 * ours, orphaned or not. Also used by the pruner, which must not delete a
 * bundle some live engine is still executing.
 */
export function findEngineProcesses(opts?: ReapOptions): FoundEngine[] {
  const procRoot = opts?.procRoot ?? "/proc";
  const kill = opts?.kill ?? defaultKill;
  const ourUid = typeof process.getuid === "function" ? process.getuid() : null;

  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return []; // no procfs (macOS, Windows): nothing to find this way
  }

  const found: FoundEngine[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === process.pid) continue;
    const dir = resolve(procRoot, entry);

    // Our uid only. A process we cannot own is never ours to signal.
    if (ourUid !== null) {
      try {
        if (statSync(dir).uid !== ourUid) continue;
      } catch {
        continue; // vanished mid-scan
      }
    }

    let env: Record<string, string>;
    try {
      env = parseEnviron(readFileSync(resolve(dir, "environ"), "utf8"));
    } catch {
      continue; // no permission or the process exited: not ours to touch
    }
    if (env[ENGINE_MARKER_ENV] !== ENGINE_MARKER_VALUE) continue;

    const bundlePath = env[ENGINE_BUNDLE_ENV];
    if (!bundlePath || !bundlePath.endsWith("main.js")) continue;
    // argv must actually name that bundle -- this is what separates the
    // engine from the CODE-action children that inherited its environment.
    let argv: string[];
    try {
      argv = readFileSync(resolve(dir, "cmdline"), "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.includes(bundlePath)) continue;

    const ownerPid = Number.parseInt(env[ENGINE_OWNER_PID_ENV] ?? "", 10);
    const startedAtRaw = Number.parseInt(env[ENGINE_STARTED_AT_ENV] ?? "", 10);
    found.push({
      pid,
      bundlePath,
      ownerPid: Number.isInteger(ownerPid) ? ownerPid : -1,
      startedAt: Number.isFinite(startedAtRaw) ? startedAtRaw : null,
      orphaned: !ownerIsAlive(procRoot, ownerPid, env[ENGINE_OWNER_START_ENV], kill),
    });
  }
  return found;
}

/**
 * Kill every engine whose owner is gone: SIGTERM, a grace window, then
 * SIGKILL for whatever ignored it (a bundle predating the lifecycle shim
 * will, every time).
 *
 * An engine whose owner is ALIVE is left alone even if it looks idle -- the
 * engine is pooled across runs by design, and a parked engine belonging to a
 * running daemon is exactly what that design looks like from out here.
 */
export async function reapOrphanedEngines(
  opts?: ReapOptions,
): Promise<{ reaped: FoundEngine[]; live: FoundEngine[] }> {
  const kill = opts?.kill ?? defaultKill;
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  const log = opts?.log;
  const all = findEngineProcesses(opts);
  const orphans = all.filter((e) => e.orphaned);
  const live = all.filter((e) => !e.orphaned);
  if (orphans.length === 0) return { reaped: [], live };

  const stillThere = (pid: number): boolean => {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const e of orphans) {
    try {
      kill(e.pid, "SIGTERM");
    } catch {
      /* exited between the scan and now */
    }
  }
  const deadline = Date.now() + graceMs;
  while (orphans.some((e) => stillThere(e.pid)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const e of orphans) {
    if (!stillThere(e.pid)) continue;
    try {
      kill(e.pid, "SIGKILL");
    } catch {
      /* raced with its own exit */
    }
  }

  if (log) {
    for (const e of orphans) {
      const age = e.startedAt ? `${Math.round((Date.now() - e.startedAt) / 60_000)}min` : "unknown age";
      log(
        `reaped orphaned engine pid ${e.pid} (owner ${e.ownerPid} gone, ${age}, ` +
          `bundle ${e.bundlePath})`,
      );
    }
  }
  return { reaped: orphans, live };
}

export interface PruneOptions {
  /** Cache root holding `<hash>/main.js` dirs. Default: the per-user cache. */
  root?: string;
  /** Keep at most this many bundles, newest first. 0 disables the count cap. */
  keep?: number;
  /** Delete bundles older than this. 0 disables the age cap. */
  maxAgeMs?: number;
  /** Bundle dirs that must never be deleted (in use right now). */
  protect?: string[];
  /** Log sink. Default: silent. */
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  now?: number;
}

export interface PruneResult {
  deleted: string[];
  kept: string[];
  freedBytes: number;
}

/** Keep this many bundles when nothing says otherwise. */
export const DEFAULT_KEEP_BUNDLES = 3;
/** Delete bundles untouched for this long when nothing says otherwise. */
export const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function dirSize(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const s = statSync(resolve(dir, name));
      total += s.isDirectory() ? dirSize(resolve(dir, name)) : s.size;
    } catch {
      /* vanished */
    }
  }
  return total;
}

/**
 * Prune the per-user engine bundle cache.
 *
 * Never prunes a SHARED bundle root: those are built and owned by the host,
 * read-only to us, and shared between tenants. Callers pass their own root
 * only for tests.
 *
 * Protection rules, in order:
 *   - the bundle for the CURRENT source hash is always kept, however old it
 *     is (it is what the next boot will use, and rebuilding costs a staging
 *     install);
 *   - any bundle an engine process is currently executing is kept, including
 *     engines belonging to another checkout's daemon on this machine. Ripping
 *     a `main.js` out from under a running engine is exactly the kind of
 *     mysterious failure a cache cleanup must never cause;
 *   - anything the caller lists in `protect`.
 *
 * What is left is sorted newest-first by mtime; everything past `keep`, and
 * anything older than `maxAgeMs`, goes.
 */
export function pruneEngineBundleCache(opts?: PruneOptions): PruneResult {
  const root = opts?.root ?? ENGINE_BUILD_PATHS.BUNDLE_ROOT;
  const keep = opts?.keep ?? DEFAULT_KEEP_BUNDLES;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts?.now ?? Date.now();
  const log = opts?.log;

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { deleted: [], kept: [], freedBytes: 0 }; // no cache yet
  }

  const protectedDirs = new Set<string>();
  for (const p of opts?.protect ?? []) protectedDirs.add(resolve(p));
  // The bundle this source state builds to, whether or not it exists yet.
  try {
    protectedDirs.add(resolve(root, bundleHash()));
  } catch {
    // Hashing reads vendored sources; if that fails we simply protect less,
    // and the in-use scan below still covers anything actually running.
  }
  // Anything a live engine is executing, ours or another checkout's.
  for (const e of findEngineProcesses()) {
    protectedDirs.add(resolve(e.bundlePath, ".."));
  }

  interface Candidate {
    dir: string;
    mtimeMs: number;
  }
  const candidates: Candidate[] = [];
  const kept: string[] = [];
  for (const name of names) {
    const dir = resolve(root, name);
    let s;
    try {
      s = statSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (protectedDirs.has(dir)) {
      kept.push(dir);
      continue;
    }
    candidates.push({ dir, mtimeMs: s.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const deleted: string[] = [];
  let freedBytes = 0;
  // Protected bundles already count against the budget: `keep` is how many
  // bundles the cache may hold in total, not how many extra it may hold.
  let keptCount = kept.length;
  for (const c of candidates) {
    const tooMany = keep > 0 && keptCount >= keep;
    const tooOld = maxAgeMs > 0 && now - c.mtimeMs > maxAgeMs;
    if (!tooMany && !tooOld) {
      kept.push(c.dir);
      keptCount++;
      continue;
    }
    const size = dirSize(c.dir);
    try {
      rmSync(c.dir, { recursive: true, force: true });
      deleted.push(c.dir);
      freedBytes += size;
    } catch {
      kept.push(c.dir); // in use, permissions: leave it
      keptCount++;
    }
  }

  if (log && deleted.length > 0) {
    log(
      `pruned ${deleted.length} stale engine bundle(s), freed ` +
        `${(freedBytes / 1_048_576).toFixed(1)}MB (kept ${kept.length})`,
    );
  }
  return { deleted, kept, freedBytes };
}
