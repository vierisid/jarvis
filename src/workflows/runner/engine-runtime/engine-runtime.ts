/**
 * EngineRuntime: spawns the activepieces engine bundle, registers a sandbox in
 * the SandboxApi, waits for the engine's socket.io handshake, and exposes the
 * EngineContract RPC client for the caller to drive operations through.
 *
 * Lifecycle per run:
 *   acquire(runId)
 *     -> mint engineToken
 *     -> register sandbox
 *     -> spawn engine subprocess (one per acquire)
 *     -> waitForConnection (engine dials the WS server)
 *     -> hand back an EngineHandle wrapping the engineClient + process
 *
 *   handle.release()
 *     -> SIGTERM the engine; SIGKILL after 2s if still alive
 *     -> deregister sandbox
 *
 * The daemon owns one EngineRuntime instance shared across runs; per-job
 * spawning lives at acquire-call granularity. Pooling and reuse can be
 * layered on without changing the acquire contract.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { EngineContract } from "../../sandbox-api/contracts";
import type { SandboxApi } from "../../sandbox-api/server";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import { workflowLogsBase } from "../../sandbox-api/config";
import { spawnEngine, type SpawnedEngine, type SpawnEngineOptions } from "./spawn";
import { ENGINE_BUILD_PATHS } from "./build";
import { materializeCodeActions } from "./code-materialize";
import {
  buildExecuteFlowOperation,
  buildExecuteTriggerHookOperation,
  buildExtractPieceMetadataOperation,
  type ExecuteFlowOptions,
  type ExecuteTriggerHookOptions,
  type TriggerHookType,
} from "./operation-builder";
import {
  toUpstreamFlowVersion,
  type UpstreamFlowVersion,
} from "./flow-version-adapter";
import type { FlowVersion as JarvisFlowVersion } from "../../db/repos/flow-version";
import { getFlowRun, type FlowRun } from "../../db/repos/flow-run";

export interface EngineRuntimeOptions {
  api: SandboxApi;
  /** Absolute path to the built engine bundle (`main.js`). */
  bundlePath: string;
  /**
   * When true, `release()` returns the engine to a single-slot warm pool
   * instead of killing it. The next `acquire()` reuses the same process,
   * mints a fresh engineToken, and rebinds the registry sandbox to the new
   * (runId, projectId). Saves the ~1.5-3s cold-spawn cost on every cron
   * tick / webhook fire. Defaults to `false` -- per-job spawn behaviour
   * matches what tests expect.
   *
   * Concurrency = 1: a second concurrent `acquire()` while the warm engine
   * is in use spawns a fresh one and that one is killed on release (the
   * pool only holds the most-recently-released idle engine).
   */
  pool?: boolean;
  /**
   * Where the engine materializes CODE-action source files. Defaults to
   * `~/.jarvis/workflow-codes`. The engine appends `${flowVersionId}/${stepName}/index.js`.
   */
  baseCodeDir?: string;
  /**
   * Working directory for the spawned engine. The piece-loader's dev-pieces
   * mode resolves `packages/pieces` relative to CWD, so we default to the
   * vendored activepieces dir which has the right layout for finding
   * `packages/pieces/jarvis/<name>/dist/package.json`.
   */
  cwd?: string;
  /** Search roots for vendored pieces. Default: vendored `packages/pieces` tree. */
  customPiecesPaths?: string[];
  /** CSV of dev-piece names exposed via AP_DEV_PIECES. Default: jarvis pieces. */
  devPieces?: string[];
  /** Engine WS handshake deadline. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Graceful kill deadline before SIGKILL. Default 2s. */
  killGraceMs?: number;
  /**
   * Idle TTL for the warm engine, in milliseconds. After this much time
   * sitting parked in the pool with no acquires, the engine is killed and
   * the slot is cleared. Default 5 minutes -- long enough to absorb bursty
   * cron firings, short enough that an idle daemon doesn't keep a dead-weight
   * Bun subprocess. Pass 0 (or undefined with pool=false) to disable.
   */
  poolIdleTtlMs?: number;
  /** Override extra env for the spawned engine -- mostly for tests. */
  spawnEnvOverride?: Record<string, string | undefined>;
  /** Override the runtime binary (default: process.execPath). */
  runtime?: string;
}

export interface AcquireOptions {
  runId: string;
  projectId: string;
  /** Per-run engineToken TTL in seconds. Default 1 hour. */
  tokenTtlSeconds?: number;
}

export interface ExecuteFlowOnHandleOptions {
  /** Either our DB-shaped FlowVersion, or a pre-adapted upstream FlowVersion. */
  flowVersion: JarvisFlowVersion | UpstreamFlowVersion;
  /** Trigger payload (webhook body, manual run input). Default: empty object. */
  triggerPayload?: unknown;
  /** When true, the engine first invokes the trigger's `run` hook. Default: false. */
  executeTrigger?: boolean;
  runEnvironment?: ExecuteFlowOptions["runEnvironment"];
  streamStepProgress?: ExecuteFlowOptions["streamStepProgress"];
  timeoutInSeconds?: number;
  stepNameToTest?: string | null;
  /**
   * Per-step sample outputs surfaced to the engine when running with
   * `stepNameToTest`. Keyed by step name; the engine populates each
   * preceding step's output from the corresponding entry so template
   * references resolve without re-executing the chain. Ignored when
   * `stepNameToTest` is unset.
   */
  sampleData?: Record<string, unknown>;
  /** Override the platformId the engine sees -- defaults to projectId. */
  platformId?: string;
  /** `BEGIN` for a fresh start, `RESUME` to wake a paused run. Default `BEGIN`. */
  executionType?: "BEGIN" | "RESUME";
  /** Payload delivered to the paused step on RESUME. */
  resumePayload?: Record<string, unknown>;
  /** Prior execution state to restore on RESUME (engine reads steps + tags from it). */
  executionState?: { steps: Record<string, unknown>; tags?: string[] };
}

export class EngineHandle {
  /**
   * Strategy invoked by `release()`. Defaults to the kill-and-terminate path
   * (legacy behaviour). When the runtime acquires from the warm pool, it
   * supplies a different strategy that returns the engine to the idle slot
   * without killing it. The handle itself doesn't care which.
   */
  private readonly releaseImpl: () => Promise<void>;

  constructor(
    public readonly sandboxId: string,
    public readonly runId: string,
    public readonly projectId: string,
    public readonly engineClient: EngineContract,
    public readonly engineToken: string,
    private readonly proc: SpawnedEngine,
    private readonly registry: SandboxRegistry,
    private readonly killGraceMs: number,
    private readonly api: SandboxApi,
    private readonly baseCodeDir: string,
    releaseImpl?: () => Promise<void>,
  ) {
    this.releaseImpl = releaseImpl ?? (() => this.killAndTerminate());
  }

  /** Inspect the spawned process without exposing the full child handle. */
  get pid(): number {
    return this.proc.pid;
  }

  get stdout(): NodeJS.ReadableStream | null {
    return this.proc.stdout;
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.proc.stderr;
  }

  /**
   * Run a flow end-to-end through this engine: materialize CODE-action source
   * to disk, send EXECUTE_FLOW, wait for the engine's flow-executor to settle.
   *
   * Activepieces' EXECUTE_FLOW returns void; the run state lands via
   * WorkerContract.uploadRunLog before executeOperation resolves (upstream
   * runs `await runProgressService.shutdown()` after the flow-executor is
   * done). After this method resolves, the flow_run row reflects the run's
   * terminal state.
   *
   * Throws if executeOperation itself errors (e.g., engine validation
   * rejection, IPC failure, sandbox terminated mid-call). Run-level failures
   * (FAILED / INTERNAL_ERROR / TIMEOUT) succeed at this level and are visible
   * via the returned FlowRun row.
   */
  async executeFlow(opts: ExecuteFlowOnHandleOptions): Promise<FlowRun> {
    const upstream = isUpstreamFlowVersion(opts.flowVersion)
      ? opts.flowVersion
      : toUpstreamFlowVersion(opts.flowVersion);
    materializeCodeActions(upstream, this.baseCodeDir);

    const baseExecuteFlowOptions: ExecuteFlowOptions = {
      flowVersion: upstream,
      flowRunId: this.runId,
      projectId: this.projectId,
      platformId: opts.platformId ?? this.projectId,
      engineToken: this.engineToken,
      internalApiUrl: this.api.baseUrl,
      // The engine's run-progress backup PUTs zstd to this URL without auth
      // headers (upstream uses S3 presigned URLs). We bake the engineToken
      // into the query string so our auth middleware accepts the call.
      logsUploadUrl:
        `${this.api.baseUrl}/v1/logs/${encodeURIComponent(this.runId)}` +
        `?token=${encodeURIComponent(this.engineToken)}`,
      logsFileId: `logs_${this.runId}`,
    };
    if (opts.triggerPayload !== undefined) baseExecuteFlowOptions.triggerPayload = opts.triggerPayload;
    if (opts.executeTrigger !== undefined) baseExecuteFlowOptions.executeTrigger = opts.executeTrigger;
    if (opts.runEnvironment !== undefined) baseExecuteFlowOptions.runEnvironment = opts.runEnvironment;
    if (opts.streamStepProgress !== undefined) baseExecuteFlowOptions.streamStepProgress = opts.streamStepProgress;
    if (opts.timeoutInSeconds !== undefined) baseExecuteFlowOptions.timeoutInSeconds = opts.timeoutInSeconds;
    if (opts.stepNameToTest !== undefined) baseExecuteFlowOptions.stepNameToTest = opts.stepNameToTest;
    if (opts.sampleData !== undefined) baseExecuteFlowOptions.sampleData = opts.sampleData;
    if (opts.executionType !== undefined) baseExecuteFlowOptions.executionType = opts.executionType;
    if (opts.resumePayload !== undefined) baseExecuteFlowOptions.resumePayload = opts.resumePayload;
    if (opts.executionState !== undefined) baseExecuteFlowOptions.executionState = opts.executionState;

    const operation = buildExecuteFlowOperation(baseExecuteFlowOptions);
    await this.engineClient.executeOperation(operation);

    const run = getFlowRun(this.runId);
    if (!run) throw new Error(`flow_run ${this.runId} disappeared after executeFlow`);
    return run;
  }

  /**
   * Send EXECUTE_TRIGGER_HOOK for one of the trigger lifecycle hooks
   * (`ON_ENABLE` / `ON_DISABLE` / `RUN` / `TEST` / `RENEW`).
   *
   * Response shapes (per upstream `ExecuteTriggerResponse<H>`):
   *   - ON_ENABLE  -> `{ listeners: AppEventListener[], scheduleOptions?: { cronExpression, timezone? } }`
   *   - ON_DISABLE -> `{}`
   *   - RUN / TEST -> `{ output: unknown[], message? }`
   *   - RENEW      -> `{}`
   *
   * Caller is responsible for adapting the supplied flow version to the
   * upstream shape and persisting the response (engine_listeners +
   * engine_schedule columns on flow_version, in the case of ON_ENABLE).
   *
   * Throws on non-OK engine status; returns the typed-as-unknown response on
   * success.
   */
  async executeTriggerHook(
    hookType: TriggerHookType,
    opts: Omit<
      ExecuteTriggerHookOptions,
      | "hookType"
      | "engineToken"
      | "internalApiUrl"
      | "projectId"
      | "platformId"
      | "flowRunId"
    > & {
      flowRunId?: string;
      projectId?: string;
      platformId?: string;
    },
  ): Promise<unknown> {
    const merged: ExecuteTriggerHookOptions = {
      hookType,
      flowVersion: opts.flowVersion,
      flowRunId: opts.flowRunId ?? this.runId,
      projectId: opts.projectId ?? this.projectId,
      platformId: opts.platformId ?? this.projectId,
      engineToken: this.engineToken,
      internalApiUrl: this.api.baseUrl,
    };
    if (opts.publicApiUrl !== undefined) merged.publicApiUrl = opts.publicApiUrl;
    if (opts.webhookUrl !== undefined) merged.webhookUrl = opts.webhookUrl;
    if (opts.test !== undefined) merged.test = opts.test;
    if (opts.triggerPayload !== undefined) merged.triggerPayload = opts.triggerPayload;
    if (opts.appWebhookUrl !== undefined) merged.appWebhookUrl = opts.appWebhookUrl;
    if (opts.webhookSecret !== undefined) merged.webhookSecret = opts.webhookSecret;
    if (opts.timeoutInSeconds !== undefined) merged.timeoutInSeconds = opts.timeoutInSeconds;

    const op = buildExecuteTriggerHookOperation(merged);
    const reply = await this.engineClient.executeOperation(op);
    if (reply.status !== "OK") {
      throw new Error(`executeTriggerHook(${hookType}) -> ${reply.status}`);
    }
    return reply.response;
  }

  /**
   * Send EXTRACT_PIECE_METADATA for a single piece and return the upstream
   * piece metadata. Multiple pieces can be extracted on the same handle in
   * sequence (the engine subprocess handles operations one at a time over
   * the same socket).
   *
   * Return type is the loose `RawPieceMetadata` shape (`{ name, displayName,
   * description, actions, triggers }` with `props` per action/trigger).
   * Callers that need stricter validation parse further; the catalog layer
   * is the only consumer today.
   *
   * Throws if the engine reports a non-OK status (treats USER_FAILURE /
   * INTERNAL_ERROR / TIMEOUT as fatal -- callers should surface to the user).
   */
  async extractPieceMetadata(opts: {
    pieceName: string;
    pieceVersion: string;
    timeoutInSeconds?: number;
  }): Promise<import("../../runtime/piece-catalog").RawPieceMetadata> {
    const baseOpts: Parameters<typeof buildExtractPieceMetadataOperation>[0] = {
      pieceName: opts.pieceName,
      pieceVersion: opts.pieceVersion,
      projectId: this.projectId,
      platformId: this.projectId,
      engineToken: this.engineToken,
      internalApiUrl: this.api.baseUrl,
    };
    if (opts.timeoutInSeconds !== undefined) {
      baseOpts.timeoutInSeconds = opts.timeoutInSeconds;
    }
    const op = buildExtractPieceMetadataOperation(baseOpts);
    const reply = await this.engineClient.executeOperation(op);
    if (reply.status !== "OK") {
      throw new Error(
        `extractPieceMetadata(${opts.pieceName}@${opts.pieceVersion}) -> ${reply.status}`,
      );
    }
    return reply.response as import("../../runtime/piece-catalog").RawPieceMetadata;
  }

  /**
   * Per-acquire teardown. Default: kill the subprocess and terminate the
   * sandbox in the registry so subsequent calls from a zombie engine are
   * rejected. When the runtime is pooled, the runtime supplies a different
   * strategy that returns the engine to the idle slot.
   */
  async release(): Promise<void> {
    return this.releaseImpl();
  }

  /**
   * The default kill-and-terminate strategy, exposed so the runtime's pool
   * code can call it for forced shutdown of an idle engine.
   */
  async killAndTerminate(): Promise<void> {
    this.proc.kill("SIGTERM");
    const settled = await Promise.race([
      this.proc.exited.then(() => "exited" as const),
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), this.killGraceMs)),
    ]);
    if (settled === "timeout") {
      this.proc.kill("SIGKILL");
      // Give SIGKILL a moment to deliver; we don't await indefinitely.
      await Promise.race([
        this.proc.exited,
        new Promise<void>((res) => setTimeout(res, 500)),
      ]);
    }
    this.registry.terminate(this.sandboxId);
  }

  /** Internal: pool reuse needs the spawned engine + RPC client; expose to runtime only. */
  _internals(): { proc: SpawnedEngine; engineClient: EngineContract } {
    return { proc: this.proc, engineClient: this.engineClient };
  }
}

interface WarmEngine {
  sandboxId: string;
  proc: SpawnedEngine;
  engineClient: EngineContract;
}

/**
 * Walk the vendored Jarvis pieces directory and return each piece's
 * short alias (the part the engine's `getPieceNameFromAlias` strips
 * `piece-` from). Used as the default `devPieces` list so adding a
 * new Jarvis piece doesn't require an engine-runtime edit.
 *
 * Failure-tolerant: returns an empty list if the vendor tree is
 * missing or unreadable, so the runtime still constructs (the engine
 * will just fail piece extraction with a clearer error than "missing
 * dir").
 */
function discoverJarvisDevPieces(): string[] {
  const root = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = resolve(root, name);
    let s;
    try { s = statSync(dir); } catch { continue; }
    if (!s.isDirectory()) continue;
    const pkgPath = resolve(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
      if (typeof pkg.name === "string" && pkg.name.length > 0) {
        // Drop the npm scope so the alias matches the format the engine
        // expects: `@jarvispieces/piece-jarvis-foo` -> `jarvis-foo`.
        const short = pkg.name.replace(/^@[^/]+\//, "").replace(/^piece-/, "");
        out.push(short);
      }
    } catch {
      // Malformed package.json -- skip; the engine will surface a clear
      // PieceNotFoundError if this piece is later referenced.
    }
  }
  return out;
}

export class EngineRuntime {
  private readonly api: SandboxApi;
  private readonly bundlePath: string;
  private readonly baseCodeDir: string;
  private readonly customPiecesPaths: string[];
  private readonly handshakeTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly spawnEnvOverride: Record<string, string | undefined> | undefined;
  private readonly runtime: string | undefined;
  private readonly cwd: string;
  private readonly devPieces: string[];
  private readonly poolEnabled: boolean;
  private readonly poolIdleTtlMs: number;
  /**
   * Single-slot warm pool. When pooling is enabled, `release()` parks the
   * engine here instead of killing it, and the next `acquire()` reuses it.
   * Only one engine fits -- a second concurrent acquire spawns a fresh one
   * and that one is killed on its release.
   */
  private idleEngine: WarmEngine | null = null;
  /**
   * Pending idle-eviction timer for the parked engine. Set when an engine
   * enters the pool, cleared when it's reused or the pool is torn down.
   * `.unref()`-ed so the timer alone doesn't keep the daemon alive.
   */
  private idleEvictionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: EngineRuntimeOptions) {
    this.api = opts.api;
    this.bundlePath = opts.bundlePath;
    this.poolEnabled = opts.pool ?? false;
    // 5 minutes by default. The engine cold-spawn is ~3s, so an idle TTL
    // shorter than the gap between cron fires defeats the pool's purpose;
    // 5 minutes covers the common "fire every minute or two" pattern with
    // headroom, while a long-idle daemon (overnight) reclaims memory.
    this.poolIdleTtlMs = opts.poolIdleTtlMs ?? 5 * 60_000;
    this.baseCodeDir =
      opts.baseCodeDir ?? resolve(workflowLogsBase(), "..", "workflow-codes");
    this.customPiecesPaths =
      opts.customPiecesPaths ?? [
        resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"),
      ];
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.killGraceMs = opts.killGraceMs ?? 2_000;
    this.spawnEnvOverride = opts.spawnEnvOverride;
    this.runtime = opts.runtime;
    // Default to the vendored activepieces dir so dev-pieces resolution finds
    // packages/pieces/jarvis/*/dist/package.json without further env setup.
    this.cwd = opts.cwd ?? resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "..");
    // Accept piece names with or without the `piece-` prefix; the engine's
    // `getPieceNameFromAlias` normalizes by stripping `piece-` so we
    // match its own behaviour.
    //
    // Auto-discover Jarvis pieces from the vendored tree so adding a
    // new piece (regex, anything-next) doesn't need an edit here. The
    // hardcoded list was an easy oversight: forgot one entry and the
    // engine raised PieceNotFoundError at extraction time. Caller can
    // still override via `opts.devPieces` for tests.
    this.devPieces = opts.devPieces ?? discoverJarvisDevPieces();
  }

  /** Expose for callers that need to resolve files into the same baseCodeDir. */
  get codeBaseDir(): string {
    return this.baseCodeDir;
  }

  async acquire(opts: AcquireOptions): Promise<EngineHandle> {
    // Warm path: reuse the idle engine if pooling is on and one is parked.
    // Mint a fresh engineToken bound to the new (runId, projectId) and
    // rebind the registry sandbox; the engine's own SANDBOX_ID env was
    // fixed at spawn time and stays the same across runs.
    //
    // Defensive: if the parked engine died while idle (OOM, manual kill,
    // upstream bug), skip it and fall through to a fresh spawn. The
    // synchronous `alive()` check avoids racing against `proc.exited`.
    if (this.poolEnabled && this.idleEngine && !this.idleEngine.proc.alive()) {
      this.api.registry.terminate(this.idleEngine.sandboxId);
      this.idleEngine = null;
      this.clearIdleEvictionTimer();
    }
    if (this.poolEnabled && this.idleEngine) {
      const warm = this.idleEngine;
      this.idleEngine = null;
      // Reusing the warm engine -- cancel its pending eviction; the next
      // release will arm a fresh one.
      this.clearIdleEvictionTimer();
      const { token, expiresAt } = await this.api.signer.mint(
        { sandboxId: warm.sandboxId, runId: opts.runId, projectId: opts.projectId },
        opts.tokenTtlSeconds,
      );
      try {
        this.api.registry.rebind(warm.sandboxId, {
          runId: opts.runId,
          projectId: opts.projectId,
          engineToken: token,
          expiresAt,
        });
      } catch (e) {
        // Sandbox was unexpectedly terminated (e.g. proc died and registry
        // was cleaned up out-of-band). Fall through to a fresh spawn.
        warm.proc.kill("SIGKILL");
        return this.spawnFresh(opts);
      }
      return new EngineHandle(
        warm.sandboxId,
        opts.runId,
        opts.projectId,
        warm.engineClient,
        token,
        warm.proc,
        this.api.registry,
        this.killGraceMs,
        this.api,
        this.baseCodeDir,
        () => this.returnToPoolOrKill(warm),
      );
    }
    return this.spawnFresh(opts);
  }

  private async spawnFresh(opts: AcquireOptions): Promise<EngineHandle> {
    const sandboxId = SandboxRegistry.newSandboxId();
    const { token, expiresAt } = await this.api.signer.mint(
      { sandboxId, runId: opts.runId, projectId: opts.projectId },
      opts.tokenTtlSeconds,
    );
    this.api.registry.register({
      sandboxId,
      runId: opts.runId,
      projectId: opts.projectId,
      engineToken: token,
      expiresAt,
      terminatedAt: null,
    });

    mkdirSync(this.baseCodeDir, { recursive: true });

    const spawnOptions: SpawnEngineOptions = {
      bundlePath: this.bundlePath,
      sandboxId,
      sandboxWsPort: this.api.sandboxWsPort,
      baseCodeDir: this.baseCodeDir,
      customPiecesPaths: this.customPiecesPaths,
      devPieces: this.devPieces,
      cwd: this.cwd,
      env: this.spawnEnvOverride,
    };
    if (this.runtime !== undefined) spawnOptions.runtime = this.runtime;
    const proc = spawnEngine(spawnOptions);

    // CRITICAL: drain the engine's stdout + stderr or the engine WILL hang.
    // The bundle is spawned with `stdio: [ignore, pipe, pipe]` and the
    // engine's `worker-socket.ts` overrides `console.log` / `warn` /
    // `error` to fire-and-forget the message over socket.io AND then call
    // the original (which writes to stdout/stderr). Without a reader on
    // those pipes the OS buffer (~64KB on Linux) fills, the next write
    // blocks the engine event loop, and the engine deadlocks mid-flow --
    // EXECUTE_FLOW returns its RPC reply (the engine's RPC handler was
    // dispatched before the deadlock) but uploadRunLog never lands and
    // the run sits forever at RUNNING.
    //
    // We forward each line to the daemon's stdout with a sandbox prefix
    // so engine crashes are visible during debugging. The error / warn
    // streams differentiate by prefix; production daemons that want to
    // suppress this can pipe their output through a filter.
    bindEngineStream(proc.stdout, "stdout", sandboxId);
    bindEngineStream(proc.stderr, "stderr", sandboxId);

    let earlyExitMessage: string | null = null;
    const earlyExitWatcher = proc.exited.then(({ code, signal }) => {
      earlyExitMessage = `engine exited before handshake (code=${code}, signal=${signal})`;
    });

    try {
      const engineClient = await this.api.workerRpc.waitForConnection(
        sandboxId,
        this.handshakeTimeoutMs,
      );
      const warm: WarmEngine = { sandboxId, proc, engineClient };
      const releaseImpl = this.poolEnabled
        ? () => this.returnToPoolOrKill(warm)
        : undefined;
      return new EngineHandle(
        sandboxId,
        opts.runId,
        opts.projectId,
        engineClient,
        token,
        proc,
        this.api.registry,
        this.killGraceMs,
        this.api,
        this.baseCodeDir,
        releaseImpl,
      );
    } catch (e) {
      // Make sure the subprocess is gone before bubbling. If it already exited,
      // surface that reason; otherwise SIGKILL.
      if (earlyExitMessage === null) {
        proc.kill("SIGKILL");
      }
      this.api.registry.terminate(sandboxId);
      const reason = earlyExitMessage ?? (e instanceof Error ? e.message : String(e));
      throw new Error(`EngineRuntime.acquire failed: ${reason}`);
    } finally {
      // Don't leak the watcher Promise.
      void earlyExitWatcher;
    }
  }

  /**
   * Pool release strategy: park the engine in the idle slot so the next
   * `acquire()` can reuse it. If the proc died mid-run we'd otherwise pool
   * a corpse and the next acquire would rebind to a dead pid; check the
   * synchronous `alive()` flag so the decision doesn't race against
   * `proc.exited`. If a different engine is already parked, kill this one
   * (slot holds at most one warm engine).
   */
  private async returnToPoolOrKill(engine: WarmEngine): Promise<void> {
    if (!engine.proc.alive()) {
      this.api.registry.terminate(engine.sandboxId);
      return;
    }
    if (this.idleEngine === null) {
      this.idleEngine = engine;
      this.armIdleEvictionTimer();
      return;
    }
    // Slot full -- kill the duplicate.
    engine.proc.kill("SIGTERM");
    setTimeout(() => engine.proc.kill("SIGKILL"), this.killGraceMs).unref();
    this.api.registry.terminate(engine.sandboxId);
  }

  /**
   * Arm the idle-eviction timer. Called when an engine parks in the pool.
   * Re-arming replaces any prior pending timer (defensive -- the pool only
   * holds one engine, but the helper should be idempotent).
   */
  private armIdleEvictionTimer(): void {
    if (this.poolIdleTtlMs <= 0) return;
    this.clearIdleEvictionTimer();
    this.idleEvictionTimer = setTimeout(() => {
      this.idleEvictionTimer = null;
      const engine = this.idleEngine;
      if (!engine) return;
      this.idleEngine = null;
      // Same SIGTERM-then-SIGKILL grace pattern as `EngineHandle.killAndTerminate`.
      engine.proc.kill("SIGTERM");
      setTimeout(() => engine.proc.kill("SIGKILL"), this.killGraceMs).unref();
      this.api.registry.terminate(engine.sandboxId);
    }, this.poolIdleTtlMs);
    // unref so a parked engine alone doesn't keep the daemon's event loop
    // alive past shutdown.
    this.idleEvictionTimer.unref();
  }

  private clearIdleEvictionTimer(): void {
    if (this.idleEvictionTimer) {
      clearTimeout(this.idleEvictionTimer);
      this.idleEvictionTimer = null;
    }
  }

  /**
   * Tear down the warm pool. Called by the daemon's shutdown path after
   * the worker has stopped accepting jobs. Safe to call when pooling is
   * disabled (no-op).
   */
  async shutdown(): Promise<void> {
    // Cancel the eviction timer first -- otherwise it fires post-shutdown
    // and the kill-then-terminate against an already-gone engine surfaces
    // as noise in logs.
    this.clearIdleEvictionTimer();
    if (!this.idleEngine) return;
    const engine = this.idleEngine;
    this.idleEngine = null;
    engine.proc.kill("SIGTERM");
    await Promise.race([
      engine.proc.exited,
      new Promise<void>((res) => setTimeout(res, this.killGraceMs)),
    ]);
    engine.proc.kill("SIGKILL");
    this.api.registry.terminate(engine.sandboxId);
  }
}

function isUpstreamFlowVersion(
  v: JarvisFlowVersion | UpstreamFlowVersion,
): v is UpstreamFlowVersion {
  return typeof (v as UpstreamFlowVersion).created === "string";
}

/**
 * Attach a no-op-with-side-effect reader to one of the engine subprocess's
 * pipes. The side effect is forwarding each newline-delimited chunk to the
 * daemon's own stdout / stderr with a `[engine <sandboxId> <stream>]`
 * prefix so the operator can see engine output in the daemon log.
 *
 * The "no-op" part is the important one: just by being a reader, this
 * drains the OS pipe buffer so the engine never blocks on write -- see
 * the deadlock note next to the `spawnEngine` call site.
 *
 * Resilient by design:
 *   - `proc.stdout` / `proc.stderr` are nullable when stdio isn't piped;
 *     skip silently if so.
 *   - "data" events arrive as `Buffer` chunks; we don't try to split into
 *     lines (one chunk may carry partial lines). Each chunk is prefixed,
 *     which is enough for diagnosability.
 */
function bindEngineStream(
  stream: NodeJS.ReadableStream | null,
  kind: "stdout" | "stderr",
  sandboxId: string,
): void {
  if (!stream) return;
  const prefix = `[engine ${sandboxId.slice(0, 8)} ${kind}]`;
  const sink: NodeJS.WriteStream =
    kind === "stderr" ? process.stderr : process.stdout;
  stream.on("data", (chunk: Buffer) => {
    // Trim a trailing newline so the daemon log doesn't double-space; we
    // re-add a single newline ourselves.
    const text = chunk.toString("utf8").replace(/\n$/, "");
    if (text.length === 0) return;
    sink.write(`${prefix} ${text}\n`);
  });
  // Errors on the pipe itself (rare: e.g. the proc exited mid-read) are
  // ignored -- the spawned process is gone, nothing to do about it.
  stream.on("error", () => {});
}
