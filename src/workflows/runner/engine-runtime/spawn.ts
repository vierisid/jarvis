/**
 * Spawn the activepieces engine bundle as a child process and shape its
 * environment so it dials back to the SandboxApi's WS endpoint.
 *
 * The engine reads the env vars below at boot (see
 * `src/workflows/activepieces/packages/server/engine/src/main.ts` and
 * `lib/worker-socket.ts`):
 *
 *   - SANDBOX_ID                  required; doubles as the WS auth identifier
 *   - AP_SANDBOX_WS_PORT          required; daemon's WS server port
 *   - AP_EXECUTION_MODE           SANDBOX_PROCESS (we never use the others)
 *   - AP_BASE_CODE_DIRECTORY      where CODE actions are materialized
 *   - AP_PAUSED_FLOW_TIMEOUT_DAYS pausedFlow expiry cap
 *   - AP_NETWORK_MODE             optional; STRICT enables proxy rebinding
 *   - AP_CUSTOM_PIECES_PATHS      colon-separated piece search roots
 *   - AP_DEV_PIECES               CSV of dev piece names (matched in dist/)
 *
 * stdio is `[ignore, pipe, pipe]` so we can capture stdout/stderr -- the engine
 * forwards piece console output via the WorkerNotifyContract over socket.io,
 * but truly catastrophic startup failures (couldn't load the bundle, etc.) go
 * to stderr before the WS comes up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSecretEnvName } from "../../../util/subprocess-env";
import { assertBundleUnchanged } from "./bundle-integrity";
import {
  ENGINE_BUNDLE_ENV,
  ENGINE_MARKER_ENV,
  ENGINE_MARKER_VALUE,
  ENGINE_ORPHAN_POLL_ENV,
  ENGINE_OWNER_PID_ENV,
  ENGINE_OWNER_START_ENV,
  ENGINE_SHUTDOWN_GRACE_ENV,
  ENGINE_STARTED_AT_ENV,
} from "./engine-lifecycle";

/**
 * Headroom between the engine's own post-SIGTERM flush window and the
 * owner's SIGKILL deadline: enough for the exit itself to land before the
 * owner stops being polite.
 */
const GRACE_HEADROOM_MS = 250;

export interface SpawnedEngine {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /** The underlying child handle, for callers that need the raw streams. */
  child: ChildProcess;
  /**
   * Synchronously-checkable liveness flag. `true` from spawn until the
   * `close` event fires; `false` thereafter. Engine pool uses this to
   * decide whether to park or discard a released engine without racing
   * against `exited` (which only resolves on the next microtask).
   */
  alive(): boolean;
  /**
   * Rejects if the child emits `error` (failed exec, EAGAIN under fork
   * pressure, killed by the OS before exec). Never resolves otherwise.
   *
   * This also exists to KEEP a listener on the child's `error` event:
   * unhandled, that event is thrown, and an async one would take the whole
   * daemon down rather than failing one acquire.
   */
  spawnFailed: Promise<never>;
}

export interface SpawnEngineOptions {
  bundlePath: string;
  /**
   * sha256 `bundlePath` must hash to, or `null` when nothing verified it. See
   * `EngineRuntimeOptions.expectedDigest`; required for the same reason.
   */
  expectedDigest: string | null;
  sandboxId: string;
  sandboxWsPort: number;
  baseCodeDir: string;
  executionMode?: "SANDBOX_PROCESS" | "UNSANDBOXED";
  pausedFlowTimeoutDays?: number;
  networkMode?: "STRICT";
  customPiecesPaths?: string[];
  devPieces?: string[];
  /** Override `process.execPath`. Default: same Bun binary running the daemon. */
  runtime?: string;
  /** Extra env merged on top of the defaults; only engine names (isEngineEnvName) are kept. */
  env?: Record<string, string | undefined>;
  /**
   * The owner's SIGKILL deadline for this engine (`EngineRuntime`'s
   * `killGraceMs`). Used to size the engine's own post-SIGTERM flush window
   * so the two cannot drift apart. Omit and the engine falls back to the
   * shim's default.
   */
  ownerKillGraceMs?: number;
  /**
   * Working directory for the spawned engine. The piece-loader's dev-pieces
   * mode resolves `packages/pieces` relative to CWD, so this should point at
   * a directory where `packages/pieces/<piece>/dist/package.json` exists.
   */
  cwd?: string;
  /** See `EngineRuntimeOptions.warmTranspilerCache`. Build time only. */
  warmTranspilerCache?: boolean;
}

/**
 * This process's start time in clock ticks since boot (`/proc/self/stat`
 * field 22), or null off Linux. Travels with the owner pid so an engine can
 * tell "my owner is alive" from "something else now has my owner's pid".
 */
function ownerStartTime(): string | null {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    // comm (field 2) may contain spaces and parens; count from the last ')',
    // where the first token is field 3, so field 22 is index 19.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startedAt = fields[19];
    return startedAt && /^\d+$/.test(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

/**
 * The curated subset of the parent env the engine inherits. We avoid blasting
 * the whole process.env into the engine because that leaks secrets into a
 * sandboxed process; the engine only needs PATH / HOME / TMPDIR for
 * child-process sandboxing of CODE actions.
 *
 * Deliberately not `sanitizedEnv()` (src/util/subprocess-env.ts): that would
 * also forward proxy and CA settings, which changes how pieces reach the
 * network. Pinned by src/spawn-env-guard.test.ts, which is also what exempts
 * the spawn below from requiring `sanitizedEnv()`.
 */
export const ENGINE_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  // Not a secret — forwarding it lets the engine child hit the host's shared
  // read-only transpiler cache when it parses large piece SDK files
  // (multi-tenant hosting warms it per version). Bun is fail-open on an
  // unreadable/unwritable cache dir, so this can never break a spawn. For a
  // PINNED bundle it is forwarded only when root owns it and nothing here can
  // write it; see engineTranspilerCache (#835).
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  // Operator knobs read by the bundle's lifecycle shim (engine-lifecycle.ts):
  // how long the engine may keep flushing after SIGTERM, and how often it
  // checks whether its owner is still alive. Not secrets; forwarded so a
  // deployment can tune them without a rebuild.
  ENGINE_SHUTDOWN_GRACE_ENV,
  ENGINE_ORPHAN_POLL_ENV,
]);

/**
 * Names a caller's `opts.env` may set: the passthrough list and the engine's
 * own wiring namespaces. Anything else is dropped. Only tests set `opts.env`
 * today; without this a future caller handing it `process.env` would undo the
 * curation above while every check on ENGINE_ENV_PASSTHROUGH still passed.
 */
export function isEngineEnvName(name: string): boolean {
  const engineName = ENGINE_ENV_PASSTHROUGH.includes(name)
    || name === "SANDBOX_ID"
    || name.startsWith("AP_")
    || name.startsWith("JARVIS_ENGINE_");
  // The same credential-shaped backstop sanitizedEnv() applies, so a future
  // `AP_..._KEY` handed in from process.env still stays out.
  return engineName && !isSecretEnvName(name);
}

/**
 * The engine's complete environment, from `opts` and this process's env, pid,
 * clock and /proc entry. Warns (names only) about dropped overrides.
 */
export function engineEnv(opts: Omit<SpawnEngineOptions, "expectedDigest">): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENGINE_ENV_PASSTHROUGH) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Identity of this engine, for everyone who may later have to reclaim it:
  // the in-process registry below, the test leak guard, and the out-of-process
  // reaper (which reads them back from /proc/<pid>/environ). The owner pid is
  // also what the bundle's own orphan watchdog watches -- see engine-lifecycle.ts.
  env[ENGINE_MARKER_ENV] = ENGINE_MARKER_VALUE;
  env[ENGINE_OWNER_PID_ENV] = String(process.pid);
  env[ENGINE_BUNDLE_ENV] = opts.bundlePath;
  env[ENGINE_STARTED_AT_ENV] = String(Date.now());
  const ownerStart = ownerStartTime();
  if (ownerStart) env[ENGINE_OWNER_START_ENV] = ownerStart;
  // How long the engine may keep flushing after SIGTERM. Derived from the
  // owner's own SIGKILL deadline rather than left to a free-floating default:
  // a grace window that outlasts the deadline means the engine is killed
  // mid-flush every time, which is the failure it was meant to avoid. An
  // operator override still wins -- it is an escape hatch -- but it says so
  // when it has been set past the point of usefulness.
  const ownerKillGraceMs = opts.ownerKillGraceMs;
  if (ownerKillGraceMs !== undefined) {
    const override = process.env[ENGINE_SHUTDOWN_GRACE_ENV]?.trim();
    const parsed = override ? Number.parseInt(override, 10) : Number.NaN;
    const overrideUsable = Number.isFinite(parsed) && parsed >= 0;
    if (override && !overrideUsable) {
      console.warn(
        `[engine-spawn] ignoring ${ENGINE_SHUTDOWN_GRACE_ENV}=${JSON.stringify(override)}: ` +
          `must be a non-negative number of ms`,
      );
    }
    if (overrideUsable) {
      if (parsed >= ownerKillGraceMs) {
        console.warn(
          `[engine-spawn] ${ENGINE_SHUTDOWN_GRACE_ENV}=${override} is >= the owner's ` +
            `${ownerKillGraceMs}ms SIGKILL deadline; the engine will be killed before it ` +
            `finishes its shutdown flush.`,
        );
      }
    } else {
      // Always strictly inside the owner's deadline, including for the very
      // short grace periods tests use: a flush window that outlives the
      // SIGKILL behind it is the drift this derivation exists to prevent.
      env[ENGINE_SHUTDOWN_GRACE_ENV] = String(
        Math.max(
          0,
          Math.min(
            ownerKillGraceMs - GRACE_HEADROOM_MS,
            Math.floor(ownerKillGraceMs * 0.8),
          ),
        ),
      );
    }
  }
  env["SANDBOX_ID"] = opts.sandboxId;
  env["AP_SANDBOX_WS_PORT"] = String(opts.sandboxWsPort);
  env["AP_EXECUTION_MODE"] = opts.executionMode ?? "SANDBOX_PROCESS";
  env["AP_BASE_CODE_DIRECTORY"] = opts.baseCodeDir;
  env["AP_PAUSED_FLOW_TIMEOUT_DAYS"] = String(opts.pausedFlowTimeoutDays ?? 30);
  if (opts.networkMode) env["AP_NETWORK_MODE"] = opts.networkMode;
  if (opts.customPiecesPaths?.length) {
    env["AP_CUSTOM_PIECES_PATHS"] = opts.customPiecesPaths.join(":");
  }
  if (opts.devPieces?.length) {
    env["AP_DEV_PIECES"] = opts.devPieces.join(",");
  }
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else if (isEngineEnvName(k)) env[k] = v;
    else dropped.push(k);
  }
  if (dropped.length > 0) {
    // Names only: the values are exactly what must not be printed.
    console.warn(`[engine-spawn] dropped non-engine env override(s): ${dropped.join(", ")}`);
  }
  // `ws`'s own switches for its optional native helpers (#759), so it never
  // looks `bufferutil` / `utf-8-validate` up at all -- in the bundle, which
  // compiles both out anyway (ENGINE_ABSENT_MODULES in build.ts), and in any
  // piece module the engine imports that carries its own copy of `ws`. Set
  // AFTER the override loop, because that loop can DELETE a name (an
  // `undefined` value) as well as set one, and these are not the caller's to
  // remove.
  env["WS_NO_BUFFER_UTIL"] = "1";
  env["WS_NO_UTF_8_VALIDATE"] = "1";
  return env;
}

export const TRANSPILER_CACHE_ENV = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

/**
 * What the engine's BUN_RUNTIME_TRANSPILER_CACHE_PATH should be (#835);
 * `undefined` leaves it unset.
 *
 * WHY. Bun does not execute a large `main.js` as read: it executes the
 * TRANSPILED copy it cached on an earlier run, from
 * `$BUN_RUNTIME_TRANSPILER_CACHE_PATH`, or by default
 * `$HOME/.bun/install/cache/@t@/<hash>.pile` -- 3.5 MB for the engine, the
 * transpiled bundle plus its sourcemap behind a header of input and output
 * hashes. The digest pin (#671, #762) covers `main.js` on disk and never sees
 * that file. Bun does validate an entry (a naive same-length edit was detected
 * and rewritten), but with an unkeyed 64-bit hash whose function was not
 * identified, so whether an entry can be FORGED is open. This makes the
 * question moot for a pinned bundle instead of answering it: the engine either
 * caches nowhere, or caches only where nothing but root can write -- not this
 * uid, which is every CODE step, piece and file tool the instance runs.
 *
 * So, for a pinned bundle:
 *   - unset (the default path, under HOME): "0", which disables the cache.
 *   - a root-owned directory of root-owned files that nothing here can write
 *     or rename (isHostOwnedReadOnly): kept. That is the read-only cache
 *     multi-tenant hosting warms per version (build-shared-runtime.ts), which
 *     Bun reads without writing. It is only as trustworthy as the code that ran
 *     while it was being warmed, which today includes every catalog piece.
 *   - anything else, including a "daemon-owned" directory: "0". A directory
 *     the daemon owns is one every tenant workload at the daemon's uid owns
 *     too, so it would move the cache without making it any less forgeable.
 * An unpinned bundle (one adopted from the per-user cache that nothing
 * verified) is left as configured: there is no pin there for the cache to get
 * around.
 *
 * COST, measured on Bun 1.3.8, engine boot until it exits without a sandbox
 * id, median of 15: 119 ms with a warm cache, 184 ms disabled -- one parse of
 * the 1.8 MB bundle, about 65 ms per engine SPAWN (not per run: the pool keeps
 * engines warm). Importing four installed piece SDKs went from 743 ms to
 * 818 ms. A host-owned read-only cache keeps both.
 */
const WARNED_CACHE_VALUES = new Set<string>();

export function engineTranspilerCache(
  configured: string | undefined,
  pinned: boolean,
  isProtected: (dir: string) => boolean = (dir) => isHostOwnedReadOnly(dir),
): string | undefined {
  if (!pinned) return configured;
  const value = configured?.trim();
  if (!value || value === "0") return "0";
  if (isProtected(value)) return value;
  // Once per value, not once per spawn: a misconfigured host spawns often.
  if (WARNED_CACHE_VALUES.has(value)) return "0";
  WARNED_CACHE_VALUES.add(value);
  console.warn(
    `[engine-spawn] not forwarding ${TRANSPILER_CACHE_ENV}=${JSON.stringify(value)} to a pinned engine: ` +
      `it is not a normalized path to a root-owned directory of root-owned files that nothing here can write ` +
      `or rename, so a cached transpilation there could run code the bundle digest never checked. ` +
      `The cache is disabled for this engine instead (#835).`,
  );
  return "0";
}

/** The filesystem calls `isHostOwnedReadOnly` makes; injectable so its accepting case is testable. */
export interface CacheDirProbe {
  lstat(path: string): { uid: number; mode: number; isDirectory(): boolean; isFile(): boolean };
  realpath(path: string): string;
  readdir(path: string): string[];
  writable(path: string): boolean;
}

const REAL_PROBE: CacheDirProbe = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
  readdir: (path) => readdirSync(path),
  writable,
};

/**
 * True only when nothing but root can change what Bun would read from `dir`:
 *   - `dir` is absolute and already normalized, and is forwarded exactly as
 *     judged. `resolve()` collapses `..` lexically while the kernel follows
 *     symlinks first, so `/a/link/../b` would be judged at `/a/b` and opened
 *     wherever the link points (found in review);
 *   - it is a directory reached through no symlink;
 *   - it, every entry in it and every ancestor is OWNED BY ROOT. "Not this
 *     uid" is not enough: on a host with a uid per tenant, a neighbour owning
 *     any of them could rewrite or rename it (found in review);
 *   - every entry is a regular file. Bun's cache is flat, and the contents of
 *     a subdirectory, or the target of a link, would go unchecked;
 *   - neither it nor an entry is writable by this uid, and no ancestor is
 *     unless sticky (a sticky directory refuses to let us rename an entry root
 *     owns).
 * Conservative: any doubt is false, including Windows, where write access
 * cannot be judged this way, and a process running as root, which can write
 * everything.
 *
 * A `true` is remembered for the process: by construction only root can turn
 * it false again, and re-walking a warm cache of a whole piece catalog at
 * every spawn is not free (9 ms for a 1680-entry directory, measured). A
 * `false` is re-checked every time, so a host that fixes its permissions is
 * picked up without a restart.
 */
export function isHostOwnedReadOnly(dir: string, probe: CacheDirProbe = REAL_PROBE, uid = process.getuid?.()): boolean {
  if (process.platform === "win32" || uid === undefined || uid === 0) return false;
  if (!isAbsolute(dir) || resolve(dir) !== dir) return false;
  const memo = probe === REAL_PROBE;
  if (memo && PROTECTED_DIRS.has(`${uid}\0${dir}`)) return true;
  const verdict = judgeHostOwned(dir, probe);
  if (memo && verdict) PROTECTED_DIRS.add(`${uid}\0${dir}`);
  return verdict;
}

const PROTECTED_DIRS = new Set<string>();

function judgeHostOwned(dir: string, probe: CacheDirProbe): boolean {
  try {
    if (probe.realpath(dir) !== dir) return false;
    const top = probe.lstat(dir);
    if (!top.isDirectory() || top.uid !== 0 || probe.writable(dir)) return false;
    for (const entry of probe.readdir(dir)) {
      const path = join(dir, entry);
      const st = probe.lstat(path);
      if (!st.isFile() || st.uid !== 0 || probe.writable(path)) return false;
    }
    for (let cur = dirname(dir); ; cur = dirname(cur)) {
      const st = probe.lstat(cur);
      if (st.uid !== 0) return false;
      if (probe.writable(cur) && (st.mode & 0o1000) === 0) return false;
      if (dirname(cur) === cur) return true;
    }
  } catch {
    return false;
  }
}

function writable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function spawnEngine(opts: SpawnEngineOptions): SpawnedEngine {
  // A bundle that verified at resolution must still be those bytes (#671),
  // checked against the digest the caller carries rather than one looked up by
  // path (#762). Throws BEFORE anything is started, so a refusal leaves no
  // process behind. Per spawn, not per acquire: a warm pooled engine already
  // holds the code.
  //
  // ABSOLUTE only: the hash below resolves a relative path against THIS
  // process's cwd and the child resolves it against `opts.cwd`, so a relative
  // path would let the daemon verify one file and the engine run another.
  if (!isAbsolute(opts.bundlePath)) {
    throw new TypeError("spawnEngine: bundlePath must be absolute, or the bytes checked are not the bytes run");
  }
  assertBundleUnchanged(opts.bundlePath, opts.expectedDigest);
  const env = engineEnv(opts);
  // After engineEnv, so it judges the value a caller override left (#835). A
  // build-time warm-up is the one caller allowed to write a cache: it judges
  // the bundle as unpinned for this purpose only, so the configured directory
  // is used as is.
  const transpilerCache = engineTranspilerCache(
    env[TRANSPILER_CACHE_ENV],
    opts.expectedDigest !== null && opts.warmTranspilerCache !== true,
  );
  if (transpilerCache === undefined) delete env[TRANSPILER_CACHE_ENV];
  else env[TRANSPILER_CACHE_ENV] = transpilerCache;
  const runtime = opts.runtime ?? process.execPath;
  // --smol: the engine is a short-lived-to-parked sandbox that grows to
  // ~100MB under default JSC heap growth; the smaller-heap GC profile is the
  // right trade for a subprocess whose CPU time is dominated by piece I/O.
  // Bun-only flag, so skip it when opts.runtime overrides the binary.
  //
  // --no-install (#759): with no `node_modules` above `main.js` -- the per-user
  // cache has none -- Bun's default is to AUTO-INSTALL any bare name the code
  // requires, from the npm registry, at the latest version, and run it. That is
  // how a real engine fetched and loaded `bufferutil`, `node-gyp-build` and
  // `supports-color` on every cold cache (measured; see ENGINE_ABSENT_MODULES).
  // The build now refuses a bundle with a bare run-time name, but a `require`
  // of a COMPUTED name is invisible to that check, so the engine is also told
  // never to fetch one. It cannot break a piece: Bun only auto-installs for a
  // file with no `node_modules` above it, and pieces load from installed trees.
  const args = opts.runtime ? [opts.bundlePath] : ["--smol", "--no-install", opts.bundlePath];
  const child = spawn(runtime, args, {
    env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Mark the bundle as in use so the cache pruner leaves it alone. A daemon
  // holds one bundle for its whole life but only runs a process from it some
  // of the time (the idle pool evicts after minutes), so "no engine running"
  // is not "nobody needs this". Best-effort: a read-only shared bundle root
  // is not ours to touch.
  try {
    const when = new Date();
    utimesSync(dirname(opts.bundlePath), when, when);
  } catch {
    /* read-only or gone: only costs prune protection, never correctness */
  }

  let isAlive = true;
  const tracked: TrackedEngine = {
    pid: child.pid ?? -1,
    bundlePath: opts.bundlePath,
    sandboxId: opts.sandboxId,
    startedAt: Date.now(),
    child,
  };
  LIVE_ENGINES.add(tracked);
  installExitNet();

  // Liveness follows `exit` (the process is gone), NOT `close` (its stdio
  // pipes are also closed). They usually fire together, but a CODE action's
  // own subprocess inherits the engine's stdout and can hold the pipes open
  // after the engine itself is dead -- which would leave `alive()` true for a
  // corpse, cost every teardown its full grace window, and make the leak
  // guard report a pid that no longer exists.
  child.on("exit", () => {
    isAlive = false;
    LIVE_ENGINES.delete(tracked);
  });
  // `exited` still resolves on `close`, so a caller awaiting it has the
  // engine's last output before it continues.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => {
      child.on("close", (code, signal) => {
        isAlive = false;
        LIVE_ENGINES.delete(tracked);
        res({ code, signal });
      });
    },
  );

  const spawnFailed = new Promise<never>((_res, rej) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      isAlive = false;
      // An exec that never happened has no process to reclaim, and `close`
      // may never fire for it -- drop it from the registry here or the leak
      // guard reports a pid that never existed.
      LIVE_ENGINES.delete(tracked);
      rej(
        new Error(
          `engine process failed to start (${err.code ?? "unknown"}): ${err.message}`,
        ),
      );
    });
  });
  // The caller races this; swallow the rejection so a failure it never got
  // around to observing doesn't surface as an unhandled rejection.
  void spawnFailed.catch(() => {});

  return {
    pid: child.pid ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    child,
    exited,
    spawnFailed,
    kill: (signal = "SIGTERM") => child.kill(signal),
    alive: () => isAlive,
  };
}

/**
 * Every engine THIS process spawned and has not yet seen exit.
 *
 * The point of holding child handles rather than a list of pids is that every
 * kill downstream of here is addressed to a process we created. Nothing in
 * this file ever matches a process by name, cmdline or title: on a shared
 * machine (several worktrees, several agents, the developer's own daemon)
 * a pattern kill is how you take down someone else's work.
 */
const LIVE_ENGINES = new Set<TrackedEngine>();

interface TrackedEngine {
  pid: number;
  bundlePath: string;
  sandboxId: string;
  startedAt: number;
  child: ChildProcess;
}

/** A read-only view of the engines this process still owns. */
export interface LiveEngineInfo {
  pid: number;
  bundlePath: string;
  sandboxId: string;
  /** Milliseconds since this engine was spawned. */
  ageMs: number;
}

export function liveEngines(): LiveEngineInfo[] {
  const now = Date.now();
  return [...LIVE_ENGINES].map((e) => ({
    pid: e.pid,
    bundlePath: e.bundlePath,
    sandboxId: e.sandboxId,
    ageMs: now - e.startedAt,
  }));
}

/**
 * Kill every engine this process spawned that is still alive, politely first.
 *
 * SIGTERM -> wait `graceMs` -> SIGKILL the survivors. With the bundle's
 * lifecycle shim in place the first signal is normally enough; the escalation
 * exists for an engine wedged in native code, and for the transition period
 * where a cached bundle predates the shim.
 *
 * Returns what it reclaimed, so a caller can say so out loud. Safe to call
 * when nothing is running (returns an empty list) and safe to call twice.
 */
export async function killLiveEngines(opts?: {
  graceMs?: number;
}): Promise<LiveEngineInfo[]> {
  const victims = [...LIVE_ENGINES];
  if (victims.length === 0) return [];
  const reclaimed = liveEngines();
  const graceMs = opts?.graceMs ?? 2_000;

  for (const e of victims) {
    try {
      e.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Wait for the polite path, bounded. `close` removes each entry from the
  // registry, so this resolves as soon as the last one is out.
  const deadline = Date.now() + graceMs;
  while (victims.some((e) => LIVE_ENGINES.has(e)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  for (const e of victims) {
    if (!LIVE_ENGINES.has(e)) continue;
    try {
      e.child.kill("SIGKILL");
    } catch {
      /* raced with its own exit */
    }
  }
  return reclaimed;
}

/**
 * Last-ditch net: on our own exit, SIGKILL anything still tracked.
 *
 * `exit` handlers are synchronous, so there is no escalation to be had here
 * and no waiting -- by this point the owner is on its way out and a polite
 * signal we cannot wait on is indistinguishable from none.
 *
 * Two things this does NOT cover, each handled elsewhere:
 *   - A parent that dies without running handlers at all (SIGKILL, the
 *     pre-commit hook's `timeout --kill-after`). That is the engine's own
 *     orphan watchdog (engine-lifecycle.ts) and the reaper's job.
 *   - `bun test`, whose runner does not run `exit` handlers at all (measured,
 *     not assumed). The loud test guard therefore hangs off a run-level
 *     `afterAll` in the test preload -- see `assertNoLeakedEngines()`.
 *
 * Deliberately NOT hooked to SIGTERM/SIGINT of the parent. Registering a
 * listener for those replaces the runtime's default terminate-on-signal
 * behaviour -- which is precisely the bug that made the engine deaf to
 * SIGTERM in the first place (see engine-lifecycle.ts). Whoever owns the
 * daemon's signal handling owns that decision, not this module.
 */
let exitNetInstalled = false;
function installExitNet(): void {
  if (exitNetInstalled) return;
  exitNetInstalled = true;
  process.on("exit", () => {
    for (const e of [...LIVE_ENGINES]) {
      try {
        e.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

/**
 * Guard in the spirit of `assertKeyAccessAllowedUnderTest()` in
 * `src/workflows/db/encryption.ts`: make an invisible hazard loud.
 *
 * A test run that ends with an engine still tracked has leaked one. Nothing
 * will ever reclaim it -- that is the difference between this and a
 * legitimately pooled engine, which belongs to a live owner that can still
 * reuse or kill it. So: reclaim it, then FAIL the run, because the quiet
 * version of this bug is a 118MB subprocess per test run that nobody notices
 * until the machine is out of memory (#491).
 *
 * Called from the run-level `afterAll` in `src/test-preload.ts`, which is the
 * only place under `bun test` where this can both run and be heard.
 * `JARVIS_ALLOW_LEAKED_ENGINES=1` is the escape hatch for someone
 * deliberately reproducing the leak.
 */
export async function assertNoLeakedEngines(opts?: { graceMs?: number }): Promise<void> {
  // Reclaim FIRST, unconditionally: whether or not we are allowed to complain
  // about it, the machine should not be left carrying these. The return value
  // is the list as it was before the kills.
  const leaked = await killLiveEngines(opts);
  if (leaked.length === 0) return;
  const detail = leaked
    .map(
      (e) =>
        `  pid ${e.pid} sandbox ${e.sandboxId} age ${Math.round(e.ageMs / 1000)}s ` +
        `bundle ${e.bundlePath}`,
    )
    .join("\n");
  if (process.env["JARVIS_ALLOW_LEAKED_ENGINES"] === "1") {
    process.stderr.write(
      `[engine-leak-guard] reclaimed ${leaked.length} leaked engine(s); not failing ` +
        `the run because JARVIS_ALLOW_LEAKED_ENGINES=1:\n${detail}\n`,
    );
    return;
  }
  throw new Error(
    `[engine-leak-guard] this run left ${leaked.length} engine subprocess(es) running ` +
      `(now reclaimed):\n${detail}\n` +
      `Every acquired handle needs a release() (use try/finally), and every EngineRuntime ` +
      `needs an \`await runtime.shutdown()\` in afterAll -- a parked pooled engine outlives ` +
      `the run that parked it. Set JARVIS_ALLOW_LEAKED_ENGINES=1 only when reproducing this ` +
      `on purpose.`,
  );
}
