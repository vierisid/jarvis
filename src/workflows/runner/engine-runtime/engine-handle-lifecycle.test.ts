/**
 * `EngineHandle` operation lifecycle, exercised against a fake EngineContract
 * so it runs without the engine bundle on disk.
 *
 * Covers the three things that turned one slow flow into "every run fails":
 *   1. the RPC ack deadline is derived from the budget we hand the engine,
 *      not from the client-wide default;
 *   2. a non-OK engine reply is surfaced instead of swallowed (swallowing it
 *      left the caller polling a run row the engine would never settle);
 *   3. an engine with an abandoned / in-flight operation is destroyed on
 *      release instead of being parked in the warm pool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, lockVersion } from "../../db/repos/flow-version";
import { createFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { SandboxRegistry } from "../../sandbox-api/sandbox-registry";
import { EngineTokenSigner } from "../../sandbox-api/engine-token";
import { SandboxApi } from "../../sandbox-api/server";
import { CredentialResolver } from "../../credentials/adapter";
import type { EngineContract, EngineResponse } from "../../sandbox-api/contracts";
import type { SpawnedEngine } from "./spawn";
import { EngineHandle } from "./engine-runtime";
import { CONTROL_OPERATION_TIMEOUT_S, ENGINE_ACK_MARGIN_MS } from "./operation-builder";
import type { UpstreamFlowVersion } from "./flow-version-adapter";

interface FakeEngine extends EngineContract {
  calls: Array<{ operationType: string; timeoutMs: number | undefined }>;
}

/** An engine whose reply is driven by the supplied responder. */
function fakeEngine(
  responder: (operationType: string) => Promise<EngineResponse<unknown>>,
): FakeEngine {
  const calls: FakeEngine["calls"] = [];
  return {
    calls,
    async executeOperation(input, opts) {
      calls.push({ operationType: input.operationType, timeoutMs: opts?.timeoutMs });
      return responder(input.operationType);
    },
  };
}

function fakeProc(): SpawnedEngine & { killed: NodeJS.Signals[] } {
  const killed: NodeJS.Signals[] = [];
  let alive = true;
  let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    resolveExit = r;
  });
  return {
    killed,
    pid: 4242,
    stdout: null,
    stderr: null,
    child: {} as SpawnedEngine["child"],
    exited,
    // This fake never fails to spawn, so the promise just stays pending.
    spawnFailed: new Promise<never>(() => {}),
    alive: () => alive,
    kill(signal = "SIGTERM") {
      killed.push(signal);
      alive = false;
      resolveExit({ code: null, signal });
    },
  };
}

describe("EngineHandle operation lifecycle", () => {
  let registry: SandboxRegistry;
  let baseCodeDir: string;
  let runId: string;
  const sandboxId = "sandbox-under-test";

  const flowVersion = (id: string): UpstreamFlowVersion => ({
    id,
    created: new Date(0).toISOString(),
    updated: new Date(0).toISOString(),
    flowId: "flow-1",
    displayName: "briefing",
    trigger: {
      name: "trigger",
      valid: true,
      displayName: "Manual",
      lastUpdatedDate: new Date(0).toISOString(),
      type: "EMPTY",
      settings: {},
    },
    updatedBy: null,
    valid: true,
    schemaVersion: null,
    agentIds: [],
    state: "LOCKED",
    connectionIds: [],
    backupFiles: null,
    notes: [],
  });

  function makeHandle(
    engine: EngineContract,
    proc: SpawnedEngine,
    releaseImpl?: () => Promise<void>,
  ): EngineHandle {
    return new EngineHandle(
      sandboxId,
      runId,
      DEFAULT_IDS.project,
      engine,
      "engine-token",
      proc,
      registry,
      5,
      { baseUrl: "http://127.0.0.1:1234", workerRpc: { engineClient: () => engine } } as never,
      baseCodeDir,
      releaseImpl,
    );
  }

  beforeEach(() => {
    initWorkflowDb(":memory:");
    registry = new SandboxRegistry();
    baseCodeDir = mkdtempSync(resolve(tmpdir(), "engine-handle-"));
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    lockVersion(v.id);
    runId = createFlowRun({ flowId: flow.id, flowVersionId: v.id }).id;
    registry.register({
      sandboxId,
      runId,
      projectId: DEFAULT_IDS.project,
      engineToken: "engine-token",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
  });

  afterEach(() => {
    rmSync(baseCodeDir, { recursive: true, force: true });
    closeWorkflowDb();
  });

  test("executeFlow's ack deadline follows the budget handed to the engine", async () => {
    const engine = fakeEngine(async () => ({ status: "OK", response: undefined }));
    const handle = makeHandle(engine, fakeProc());

    await handle.executeFlow({
      flowVersion: flowVersion("v-budget"),
      timeoutInSeconds: 900,
    });

    expect(engine.calls[0]?.operationType).toBe("EXECUTE_FLOW");
    expect(engine.calls[0]?.timeoutMs).toBe(900_000 + ENGINE_ACK_MARGIN_MS);
  });

  // The regression itself: the flow budget defaults to 600s, so the ack
  // deadline must be far above the 60s the RPC client defaults to. A flow
  // that legitimately runs for minutes (an LLM step, say) used to die at 60s
  // while the engine kept executing it.
  test("the default ack deadline is well past the RPC client's 60s default", async () => {
    const engine = fakeEngine(async () => ({ status: "OK", response: undefined }));
    const handle = makeHandle(engine, fakeProc());

    await handle.executeFlow({ flowVersion: flowVersion("v-default") });

    expect(engine.calls[0]?.timeoutMs).toBeGreaterThan(60_000);
  });

  // Control-plane operations keep a tight deadline: they sit on the trigger
  // manager's polling path, where a hung hook must not stall a flow's polling
  // for a flow-sized budget.
  test("trigger hooks and metadata extraction keep a short deadline", async () => {
    const engine = fakeEngine(async () => ({ status: "OK", response: {} }));
    const handle = makeHandle(engine, fakeProc());
    const expected = CONTROL_OPERATION_TIMEOUT_S * 1000 + ENGINE_ACK_MARGIN_MS;

    await handle.executeTriggerHook("RUN", { flowVersion: flowVersion("v-hook") });
    await handle.extractPieceMetadata({ pieceName: "p", pieceVersion: "1.0.0" });

    expect(engine.calls.map((c) => c.timeoutMs)).toEqual([expected, expected]);
    expect(expected).toBeLessThan(600_000);
  });

  test("a non-OK engine reply throws, carrying the engine's error detail", async () => {
    const engine = fakeEngine(async () => ({
      status: "INTERNAL_ERROR",
      response: undefined,
      error: "EngineGenericError: PieceNotFoundError",
    }));
    const handle = makeHandle(engine, fakeProc());

    await expect(
      handle.executeFlow({ flowVersion: flowVersion("v-reject") }),
    ).rejects.toThrow(/INTERNAL_ERROR.*PieceNotFoundError/);
  });

  test("a rejected engine reply does not mark the engine reusable-hostile twice over", async () => {
    // A non-OK *status* means the engine answered and is healthy: it may go
    // back to the pool. Only transport failures poison the process.
    const engine = fakeEngine(async () => ({ status: "INTERNAL_ERROR", response: undefined }));
    const proc = fakeProc();
    let pooled = false;
    const handle = makeHandle(engine, proc, async () => {
      pooled = true;
    });

    await expect(handle.executeFlow({ flowVersion: flowVersion("v-ok-engine") })).rejects.toThrow();
    expect(handle.isAbandoned).toBe(false);

    await handle.release();
    expect(pooled).toBe(true);
    expect(proc.killed).toEqual([]);
  });

  test("an abandoned operation destroys the engine instead of pooling it", async () => {
    const engine = fakeEngine(async () => {
      throw new Error("RPC [executeOperation] failed (timeout: 630000ms): operation has timed out");
    });
    const proc = fakeProc();
    let pooled = false;
    const handle = makeHandle(engine, proc, async () => {
      pooled = true;
    });

    await expect(handle.executeFlow({ flowVersion: flowVersion("v-timeout") })).rejects.toThrow(
      /timed out/,
    );
    expect(handle.isAbandoned).toBe(true);

    await handle.release();
    expect(pooled).toBe(false);
    expect(proc.killed[0]).toBe("SIGTERM");
    expect(registry.get(sandboxId)).toBeNull();
  });

  test("releasing while an operation is still in flight destroys the engine", async () => {
    let finishOperation: (() => void) | null = null;
    const engine = fakeEngine(
      () =>
        new Promise<EngineResponse<unknown>>((res) => {
          finishOperation = () => res({ status: "OK", response: undefined });
        }),
    );
    const proc = fakeProc();
    let pooled = false;
    const handle = makeHandle(engine, proc, async () => {
      pooled = true;
    });

    const pending = handle.executeFlow({ flowVersion: flowVersion("v-inflight") });
    await Promise.resolve();

    await handle.release();
    expect(pooled).toBe(false);
    expect(proc.killed[0]).toBe("SIGTERM");

    finishOperation!();
    await pending.catch(() => {});
  });
});

/**
 * The logs-upload URL across a warm rebind.
 *
 * `executeFlow` bakes the engineToken into `logsUploadUrl` as a query param,
 * because the engine PUTs its zstd run-log backup there without auth headers
 * (upstream shapes that endpoint after a presigned URL). Now that the sandbox
 * API refuses a token the sandbox is no longer running under, that baked URL
 * has to be regenerated whenever the pool rebinds the sandbox -- otherwise run
 * logs start 401ing, silently, on every pooled run after the first.
 *
 * It is regenerated, because the pooled `acquire()` builds a fresh
 * `EngineHandle` around the freshly minted token before sending EXECUTE_FLOW,
 * and `logsUploadUrl` is derived from the handle. This pins that, end to end,
 * against a real server: the URL the second handle bakes authenticates, and
 * the one the first handle baked does not.
 */
describe("logsUploadUrl authentication across a rebind", () => {
  let api: SandboxApi;
  let registry: SandboxRegistry;
  let signer: EngineTokenSigner;
  let baseCodeDir: string;
  let dataDir: string;
  let previousDataDir: string | undefined;
  let runOne: string;
  let runTwo: string;
  const sandboxId = "sandbox-pooled";

  /** Fake engine that keeps each operation payload, not just its type. */
  function capturingEngine(): EngineContract & { ops: Array<Record<string, unknown>> } {
    const ops: Array<Record<string, unknown>> = [];
    return {
      ops,
      async executeOperation(input) {
        ops.push(input.operation as Record<string, unknown>);
        return { status: "OK", response: undefined };
      },
    };
  }

  const flowVersion = (id: string): UpstreamFlowVersion => ({
    id,
    created: new Date(0).toISOString(),
    updated: new Date(0).toISOString(),
    flowId: "flow-pooled",
    displayName: "pooled",
    trigger: {
      name: "trigger",
      valid: true,
      displayName: "Manual",
      lastUpdatedDate: new Date(0).toISOString(),
      type: "EMPTY",
      settings: {},
    },
    updatedBy: null,
    valid: true,
    schemaVersion: null,
    agentIds: [],
    state: "LOCKED",
    connectionIds: [],
    backupFiles: null,
    notes: [],
  });

  beforeEach(async () => {
    initWorkflowDb(":memory:");
    baseCodeDir = mkdtempSync(resolve(tmpdir(), "engine-logs-url-"));
    // The logs route persists under this root; keep the uploads out of the
    // developer's real ~/.jarvis tree.
    dataDir = mkdtempSync(resolve(tmpdir(), "engine-logs-data-"));
    previousDataDir = process.env.JARVIS_WORKFLOW_DATA_DIR;
    process.env.JARVIS_WORKFLOW_DATA_DIR = dataDir;
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const version = createDraftVersion({ flowId: flow.id, displayName: "pooled" });
    lockVersion(version.id);
    runOne = createFlowRun({ flowId: flow.id, flowVersionId: version.id }).id;
    runTwo = createFlowRun({ flowId: flow.id, flowVersionId: version.id }).id;
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
  });

  afterEach(async () => {
    await api?.stop();
    rmSync(baseCodeDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR;
    else process.env.JARVIS_WORKFLOW_DATA_DIR = previousDataDir;
    closeWorkflowDb();
  });

  function handleFor(
    runId: string,
    projectId: string,
    token: string,
    engine: EngineContract,
  ): EngineHandle {
    return new EngineHandle(
      sandboxId,
      runId,
      projectId,
      engine,
      token,
      fakeProc(),
      registry,
      5,
      // Real baseUrl so the baked logs URL points at the live server, but a
      // stubbed RPC lookup: this suite drives the handle against a fake
      // engine, so there is no socket.io connection to re-resolve.
      { baseUrl: api.baseUrl, workerRpc: { engineClient: () => engine } } as unknown as SandboxApi,
      baseCodeDir,
      async () => {},
    );
  }

  const bakedUrl = (ops: Array<Record<string, unknown>>): string => {
    const url = ops[0]?.logsUploadUrl;
    expect(typeof url).toBe("string");
    return url as string;
  };

  test("the URL the rebound run bakes uploads, and the retired run's URL is refused", async () => {
    // Cold acquire for run one.
    const first = await signer.mint(
      { sandboxId, runId: runOne, projectId: "project-one" },
      600,
    );
    registry.register({
      sandboxId,
      runId: runOne,
      projectId: "project-one",
      engineToken: first.token,
      expiresAt: first.expiresAt,
      terminatedAt: null,
    });
    const firstEngine = capturingEngine();
    await handleFor(runOne, "project-one", first.token, firstEngine).executeFlow({
      flowVersion: flowVersion("v-one"),
    });
    const firstUrl = bakedUrl(firstEngine.ops);
    // Before the handoff, run one's own baked URL works.
    expect((await fetch(firstUrl, { method: "PUT", body: "one" })).status).toBe(200);

    // Warm acquire for run two: same process, new token, registry rebound.
    const second = await signer.mint(
      { sandboxId, runId: runTwo, projectId: "project-two" },
      600,
    );
    registry.rebind(sandboxId, {
      runId: runTwo,
      projectId: "project-two",
      engineToken: second.token,
      expiresAt: second.expiresAt,
    });
    const secondEngine = capturingEngine();
    await handleFor(runTwo, "project-two", second.token, secondEngine).executeFlow({
      flowVersion: flowVersion("v-two"),
    });
    const secondUrl = bakedUrl(secondEngine.ops);

    // The regeneration itself: a different URL, carrying the token the
    // registry now holds.
    expect(secondUrl).not.toBe(firstUrl);
    expect(secondUrl).toContain(encodeURIComponent(second.token));
    expect(registry.get(sandboxId)?.engineToken).toBe(second.token);

    // Run two's run-log upload keeps working -- this is the regression the
    // auth tightening could have caused.
    const live = await fetch(secondUrl, { method: "PUT", body: "two" });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });

    // Run one's URL is dead the moment the engine is handed on.
    const stale = await fetch(firstUrl, { method: "PUT", body: "one-again" });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: "engine token superseded" });
  });
});
