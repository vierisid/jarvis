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
 *     that path ends in `main.js`. This is not redundant with the marker:
 *     bundles built before #512 spawn CODE actions with an inherited env, so
 *     user code from one of those carries the marker too -- but it runs `bun
 *     --eval`, never a bundle path, so the argv check excludes it. Current
 *     bundles give that child `sanitizedEnv()`, which drops the marker, but a
 *     cache can still hold the older ones. (Deleting the vars from
 *     `process.env` inside the engine would not have helped: Bun's spawn
 *     still passes on the original environment block when env is omitted.)
 *   - its owner pid is no longer alive, or is alive but started at a
 *     different time than recorded -- i.e. the number was recycled.
 *
 * Anything that fails a check is left strictly alone, and every condition is
 * re-checked immediately before each signal, because a pid can be freed and
 * reused while we are working. There is no pattern matching on process names
 * or command lines anywhere in here, which is the mistake that makes a reaper
 * dangerous on a shared machine (the pre-commit hook's `pkill -f
 * engine-bundle` matched nothing at all, but the next pattern someone reaches
 * for would match everything).
 *
 * KNOWN RESIDUE: a CODE action's own subprocess (`bun --eval ...`) is NOT
 * matched -- it may be mid-step, and killing it would fail a live workflow.
 * When its engine is reaped it is orphaned in turn. It carries no pooled state
 * and no socket, so it is a much smaller version of this problem, but it is
 * not zero. Since #512 it no longer carries the marker at all (the engine
 * hands it `sanitizedEnv()`), so if those start accumulating, match them by
 * their ppid being a just-reaped engine; the marker cannot find them.
 */

import { lstatSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
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
import { liveEngines } from "./spawn";

/** An engine process found on this machine. */
export interface FoundEngine {
  pid: number;
  /** Absolute path of the bundle it is running. */
  bundlePath: string;
  /** Pid recorded at spawn as its owner. */
  ownerPid: number;
  /** Epoch ms recorded at spawn, or null when absent/unparseable. */
  startedAt: number | null;
  /**
   * The process's OWN start time in clock ticks (`/proc/<pid>/stat` field
   * 22). Re-checked before every signal: a pid identified during the scan
   * can exit and be reused before the kill lands, and on a machine shared
   * with other same-uid work that would mean signalling a stranger.
   */
  startTicks: string | null;
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
  /**
   * Restrict the reap to these pids. A test that spawns one stand-in engine
   * uses this so it cannot reach anything else on the machine; production
   * callers leave it unset and reap every orphan.
   */
  only?: number[];
  /**
   * Override the uid every candidate must match. Tests use it to prove the
   * uid gate actually excludes other users' processes.
   */
  uid?: number;
}

const DEFAULT_GRACE_MS = 2_000;

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

/** Parse a NUL-separated /proc environ blob into a map. */
function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
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
  const ourUid = opts?.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  // No way to tell whose processes these are means no way to tell ours from
  // anyone else's, and the uid check is load-bearing. Find nothing rather
  // than quietly drop a condition.
  if (ourUid === null) return [];

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
    const engine = identifyEngine(procRoot, pid, ourUid, kill);
    if (engine) found.push(engine);
  }
  return found;
}

/**
 * Is `pid` an engine of ours right now? Returns its details, or null for
 * anything that fails a single condition.
 *
 * Kept as one function so the scan and the re-check before each signal ask
 * exactly the same question -- a pid identified during a scan can exit and
 * have its number reused before the kill lands, and "it was ours a second
 * ago" is not a good enough reason to signal a stranger.
 */
function identifyEngine(
  procRoot: string,
  pid: number,
  ourUid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
): FoundEngine | null {
  if (pid === process.pid) return null;
  const dir = resolve(procRoot, String(pid));

  // Our uid only. A process we cannot own is never ours to signal.
  try {
    if (statSync(dir).uid !== ourUid) return null;
  } catch {
    return null; // vanished mid-scan
  }

  let env: Record<string, string>;
  try {
    env = parseEnviron(readFileSync(resolve(dir, "environ"), "utf8"));
  } catch {
    return null; // no permission or the process exited: not ours to touch
  }
  if (env[ENGINE_MARKER_ENV] !== ENGINE_MARKER_VALUE) return null;

  const bundlePath = env[ENGINE_BUNDLE_ENV];
  if (!bundlePath || !bundlePath.endsWith("main.js")) return null;
  // argv must actually name that bundle -- this is what separates the engine
  // from the CODE-action children of a pre-#512 bundle, which inherited its
  // environment.
  let argv: string[];
  try {
    argv = readFileSync(resolve(dir, "cmdline"), "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
  if (!argv.includes(bundlePath)) return null;

  const ownerPid = Number.parseInt(env[ENGINE_OWNER_PID_ENV] ?? "", 10);
  const startedAtRaw = Number.parseInt(env[ENGINE_STARTED_AT_ENV] ?? "", 10);
  // An engine with no usable owner pid is NOT an orphan: "we cannot tell who
  // owns this" must not read as "nobody does". Everything else here errs the
  // same way.
  const ownerUnknown = !Number.isInteger(ownerPid) || ownerPid <= 0;
  return {
    pid,
    bundlePath,
    ownerPid: ownerUnknown ? -1 : ownerPid,
    startedAt: Number.isFinite(startedAtRaw) ? startedAtRaw : null,
    startTicks: startTimeOf(procRoot, pid),
    orphaned: ownerUnknown
      ? false
      : !ownerIsAlive(procRoot, ownerPid, env[ENGINE_OWNER_START_ENV], kill),
  };
}

/**
 * The same process we identified earlier, still an engine, still orphaned?
 * Guards every signal against the pid having been recycled in between.
 */
function stillOurs(
  procRoot: string,
  ourUid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
  e: FoundEngine,
): boolean {
  const now = identifyEngine(procRoot, e.pid, ourUid, kill);
  if (!now) return false;
  if (now.bundlePath !== e.bundlePath) return false;
  // Start time is the only thing that distinguishes this process from a new
  // one wearing its pid. Where procfs gave us nothing, the rest still stands.
  if (e.startTicks !== null && now.startTicks !== e.startTicks) return false;
  return now.orphaned;
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
): Promise<{ reaped: FoundEngine[]; live: FoundEngine[]; survived: FoundEngine[] }> {
  const procRoot = opts?.procRoot ?? "/proc";
  const kill = opts?.kill ?? defaultKill;
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  const log = opts?.log;
  const ourUid = opts?.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (ourUid === null) return { reaped: [], live: [], survived: [] };

  const all = findEngineProcesses(opts);
  const only = opts?.only ? new Set(opts.only) : null;
  const scoped = only ? all.filter((e) => only.has(e.pid)) : all;
  const orphans = scoped.filter((e) => e.orphaned);
  const live = scoped.filter((e) => !e.orphaned);
  if (orphans.length === 0) return { reaped: [], live, survived: [] };

  // Re-verified before EVERY signal, not just once at scan time. In the
  // seconds this function can span, an orphan may exit on its own (its
  // in-bundle watchdog does exactly that) and its pid be handed to something
  // else with the same uid -- another agent's bun, on this machine.
  const ours = (e: FoundEngine): boolean => stillOurs(procRoot, ourUid, kill, e);

  for (const e of orphans) {
    if (!ours(e)) continue;
    try {
      kill(e.pid, "SIGTERM");
    } catch {
      /* exited between the check and now */
    }
  }
  const deadline = Date.now() + graceMs;
  while (orphans.some(ours) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const e of orphans) {
    if (!ours(e)) continue;
    try {
      kill(e.pid, "SIGKILL");
    } catch {
      /* raced with its own exit */
    }
  }

  // Report what actually went, not what we aimed at: a process in
  // uninterruptible sleep survives even SIGKILL, and a caller that fails a
  // build on "engines were leaked" deserves the truth.
  const survived = orphans.filter(ours);
  const reaped = orphans.filter((e) => !survived.includes(e));
  if (log) {
    for (const e of reaped) {
      const age = e.startedAt ? `${Math.round((Date.now() - e.startedAt) / 60_000)}min` : "unknown age";
      log(
        `reaped orphaned engine pid ${e.pid} (owner ${e.ownerPid} gone, ${age}, ` +
          `bundle ${e.bundlePath})`,
      );
    }
    for (const e of survived) {
      log(`WARNING: orphaned engine pid ${e.pid} survived SIGKILL (bundle ${e.bundlePath})`);
    }
  }
  return { reaped, live, survived };
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
  /**
   * How recently a bundle must have been used to be protected outright,
   * regardless of the caps. A bundle's dir mtime is touched whenever it is
   * resolved or spawned from, so this is "somebody is actually using this".
   * Default 24h. 0 disables the protection.
   */
  recentlyUsedMs?: number;
  /**
   * Passed to the in-use process scan. Tests point it at a fixture tree so
   * the "a bundle a live engine is executing is never deleted" rule can be
   * exercised without spawning anything.
   */
  scan?: ReapOptions;
  /**
   * Bundle dirs a live engine is already known to be running from. A caller
   * that has just reaped (and therefore just walked `/proc`) passes its
   * result here and the pruner skips a second walk -- that walk reads three
   * files per process on the machine, synchronously, on the daemon's boot
   * path.
   */
  inUseBundleDirs?: string[];
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
/** A bundle used this recently is in active use and is never pruned. */
export const DEFAULT_RECENTLY_USED_MS = 24 * 60 * 60_000;

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
      // lstat, not stat: a symlink must be counted as a link, not followed.
      // Following one would let a link cycle turn this into an unbounded
      // synchronous walk on the daemon's boot path.
      const s = lstatSync(resolve(dir, name));
      total += s.isDirectory() ? dirSize(resolve(dir, name)) : s.size;
    } catch {
      /* vanished */
    }
  }
  return total;
}

// Note: the "mark a bundle as in use" touch lives at its two call sites
// (`findCachedBundle` in build.ts, `spawnEngine` in spawn.ts) rather than as a
// helper here. This module imports `build.ts`, so a helper here that they
// imported back would close an import cycle for two lines of `utimesSync`.

/**
 * Prune the per-user engine bundle cache.
 *
 * Never prunes a SHARED bundle root: those are built and owned by the host,
 * read-only to us, and shared between tenants. Callers pass their own root
 * only for tests.
 *
 * Protection rules, all of which beat both caps:
 *   - the bundle for the CURRENT source hash is always kept, however old it
 *     is (it is what the next boot will use, and rebuilding costs a staging
 *     install);
 *   - any bundle an engine process is currently executing is kept, including
 *     engines belonging to another checkout's daemon on this machine. Ripping
 *     a `main.js` out from under a running engine is exactly the kind of
 *     mysterious failure a cache cleanup must never cause;
 *   - any bundle THIS process has an engine running from (`liveEngines()`),
 *     which also covers platforms with no procfs, where the scan above finds
 *     nothing at all;
 *   - any bundle used within `recentlyUsedMs` (default 24h). A daemon holds
 *     its bundle path for its whole life but only has a process running some
 *     of the time -- the idle pool evicts after five minutes -- so "no engine
 *     running right now" is nowhere near "nobody needs this". Without this
 *     rule, one checkout's boot-time prune deletes another checkout's bundle
 *     and its next run fails with ENOENT until it rebuilds;
 *   - anything the caller lists in `protect`.
 *
 * What is left -- the UNPROTECTED bundles -- is sorted newest-first by mtime;
 * everything past `keep` of those, and anything older than `maxAgeMs`, goes.
 * The caps apply only to that remainder: the count cap is per MACHINE, not
 * per checkout, so several active worktrees would otherwise spend the whole
 * budget between them and take each other's bundles down with them.
 */
export function pruneEngineBundleCache(opts?: PruneOptions): PruneResult {
  const root = resolve(opts?.root ?? ENGINE_BUILD_PATHS.BUNDLE_ROOT);
  const keep = opts?.keep ?? DEFAULT_KEEP_BUNDLES;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const recentlyUsedMs = opts?.recentlyUsedMs ?? DEFAULT_RECENTLY_USED_MS;
  const now = opts?.now ?? Date.now();
  const log = opts?.log;

  // A shared root is built and owned by the host, read-only to us and shared
  // between tenants. Deleting from it is never ours to do; enforce that here
  // rather than relying on every caller to know it.
  const shared = process.env["JARVIS_ENGINE_CACHE_ROOT"]?.trim();
  if (shared && resolve(shared) === root) {
    return { deleted: [], kept: [], freedBytes: 0 };
  }

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
    // and the in-use scans below still cover anything actually running.
  }
  // Anything a live engine is executing, ours or another checkout's. A caller
  // that already walked /proc hands the answer over instead of paying for a
  // second walk.
  if (opts?.inUseBundleDirs) {
    for (const dir of opts.inUseBundleDirs) protectedDirs.add(resolve(dir));
  } else {
    for (const e of findEngineProcesses(opts?.scan)) {
      protectedDirs.add(resolve(e.bundlePath, ".."));
    }
  }
  // Anything THIS process is running, which needs no procfs.
  for (const e of liveEngines()) {
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
      // lstat: a symlink in the cache root is not a bundle dir of ours, and
      // rmSync would only remove the link while dirSize walked the target.
      s = lstatSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (protectedDirs.has(dir)) {
      kept.push(dir);
      continue;
    }
    if (recentlyUsedMs > 0 && now - s.mtimeMs <= recentlyUsedMs) {
      kept.push(dir);
      continue;
    }
    candidates.push({ dir, mtimeMs: s.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const deleted: string[] = [];
  let freedBytes = 0;
  // The budget applies to bundles nothing is protecting. Counting protected
  // ones against it would mean that on a machine with `keep` active worktrees
  // -- each holding its own bundle, each protected -- the budget is already
  // spent and EVERY other bundle goes on the next boot, including one a
  // colleague's checkout will want again on Monday. Protections beat caps;
  // that is what makes them protections.
  let keptCount = 0;
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
