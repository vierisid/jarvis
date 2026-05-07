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

import { mkdirSync } from "node:fs";
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
  type ExecuteFlowOptions,
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
   * Where the engine materializes CODE-action source files. Defaults to
   * `~/.jarvis/workflow-codes`. The engine appends `${flowVersionId}/${stepName}/index.js`.
   */
  baseCodeDir?: string;
  /** Search roots for vendored pieces. Default: vendored `packages/pieces` tree. */
  customPiecesPaths?: string[];
  /** Engine WS handshake deadline. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Graceful kill deadline before SIGKILL. Default 2s. */
  killGraceMs?: number;
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
  /** Override the platformId the engine sees -- defaults to projectId. */
  platformId?: string;
}

export class EngineHandle {
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
  ) {}

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

    const operation = buildExecuteFlowOperation(baseExecuteFlowOptions);
    await this.engineClient.executeOperation(operation);

    const run = getFlowRun(this.runId);
    if (!run) throw new Error(`flow_run ${this.runId} disappeared after executeFlow`);
    return run;
  }

  /**
   * Stop the engine subprocess. SIGTERM first; SIGKILL after `killGraceMs`
   * if it hasn't exited. Always deregisters the sandbox so subsequent API
   * calls from a zombie engine are rejected.
   */
  async release(): Promise<void> {
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

  constructor(opts: EngineRuntimeOptions) {
    this.api = opts.api;
    this.bundlePath = opts.bundlePath;
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
  }

  /** Expose for callers that need to resolve files into the same baseCodeDir. */
  get codeBaseDir(): string {
    return this.baseCodeDir;
  }

  async acquire(opts: AcquireOptions): Promise<EngineHandle> {
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
      env: this.spawnEnvOverride,
    };
    if (this.runtime !== undefined) spawnOptions.runtime = this.runtime;
    const proc = spawnEngine(spawnOptions);

    let earlyExitMessage: string | null = null;
    const earlyExitWatcher = proc.exited.then(({ code, signal }) => {
      earlyExitMessage = `engine exited before handshake (code=${code}, signal=${signal})`;
    });

    try {
      const engineClient = await this.api.workerRpc.waitForConnection(
        sandboxId,
        this.handshakeTimeoutMs,
      );
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
}

function isUpstreamFlowVersion(
  v: JarvisFlowVersion | UpstreamFlowVersion,
): v is UpstreamFlowVersion {
  return typeof (v as UpstreamFlowVersion).created === "string";
}
