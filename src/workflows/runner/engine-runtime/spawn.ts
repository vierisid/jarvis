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
import { readFileSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
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
  /** Extra env merged on top of the defaults. */
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

export function spawnEngine(opts: SpawnEngineOptions): SpawnedEngine {
  const env: Record<string, string> = {};
  // Inherit a curated subset of the parent env. We avoid blasting the whole
  // process.env into the engine because that leaks secrets into a sandboxed
  // process; the engine only needs PATH / HOME / TMPDIR for child-process
  // sandboxing of CODE actions.
  // BUN_RUNTIME_TRANSPILER_CACHE_PATH: not a secret — forwarding it lets the
  // engine child hit the host's shared read-only transpiler cache when it
  // parses large piece SDK files (multi-tenant hosting warms it per version).
  // Bun is fail-open on an unreadable/unwritable cache dir, so this can never
  // break a spawn.
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    // Operator knobs read by the bundle's lifecycle shim (engine-lifecycle.ts):
    // how long the engine may keep flushing after SIGTERM, and how often it
    // checks whether its owner is still alive. Not secrets; forwarded so a
    // deployment can tune them without a rebuild.
    ENGINE_SHUTDOWN_GRACE_ENV,
    ENGINE_ORPHAN_POLL_ENV,
  ]) {
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
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const runtime = opts.runtime ?? process.execPath;
  // --smol: the engine is a short-lived-to-parked sandbox that grows to
  // ~100MB under default JSC heap growth; the smaller-heap GC profile is the
  // right trade for a subprocess whose CPU time is dominated by piece I/O.
  // Bun-only flag, so skip it when opts.runtime overrides the binary.
  const args = opts.runtime ? [opts.bundlePath] : ["--smol", opts.bundlePath];
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
