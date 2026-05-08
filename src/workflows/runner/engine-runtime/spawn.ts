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
   * Working directory for the spawned engine. The piece-loader's dev-pieces
   * mode resolves `packages/pieces` relative to CWD, so this should point at
   * a directory where `packages/pieces/<piece>/dist/package.json` exists.
   */
  cwd?: string;
}

export function spawnEngine(opts: SpawnEngineOptions): SpawnedEngine {
  const env: Record<string, string> = {};
  // Inherit a curated subset of the parent env. We avoid blasting the whole
  // process.env into the engine because that leaks secrets into a sandboxed
  // process; the engine only needs PATH / HOME / TMPDIR for child-process
  // sandboxing of CODE actions.
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
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
  const child = spawn(runtime, [opts.bundlePath], {
    env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let isAlive = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => {
      child.on("close", (code, signal) => {
        isAlive = false;
        res({ code, signal });
      });
    },
  );

  return {
    pid: child.pid ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    child,
    exited,
    kill: (signal = "SIGTERM") => child.kill(signal),
    alive: () => isAlive,
  };
}
