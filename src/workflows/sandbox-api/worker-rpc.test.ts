/**
 * End-to-end test for the WS RPC bridge: spawn a real socket.io-client that
 * mirrors what the activepieces engine subprocess does on boot, exercise each
 * WorkerContract + WorkerNotifyContract method, and verify the daemon-side
 * effects.
 *
 * We deliberately do NOT spawn the engine bundle here -- this test isolates
 * the WS layer. Step D adds an end-to-end test against the real bundle.
 */

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { io as socketIoClient } from "socket.io-client";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, lockVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { DEFAULT_IDS } from "../db/schema";
import { CredentialResolver } from "../credentials/adapter";
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
import { WorkerRpcServer } from "./worker-rpc";
import { SandboxApi } from "./server";
import { createNotifyClient, createRpcClient } from "./rpc";
import type { WorkerContract, WorkerNotifyContract } from "./contracts";

interface TestSandbox {
  sandboxId: string;
  runId: string;
  projectId: string;
  token: string;
  client: ReturnType<typeof socketIoClient>;
  workerClient: WorkerContract;
  notifyClient: WorkerNotifyContract;
  flowId: string;
  flowVersionId: string;
}

describe("WorkerRpcServer (B4: socket.io engine <-> daemon)", () => {
  let api: SandboxApi;
  let signer: EngineTokenSigner;
  let registry: SandboxRegistry;

  async function makeSandbox(opts?: {
    transports?: Array<"polling" | "websocket">;
  }): Promise<TestSandbox> {
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({ flowId: flow.id, displayName: "wsf" });
    lockVersion(v.id);
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: v.id,
      environment: "TESTING",
    });
    const sandboxId = SandboxRegistry.newSandboxId();
    const { token } = await signer.mint({
      sandboxId,
      runId: run.id,
      projectId: DEFAULT_IDS.project,
    });
    registry.register({
      sandboxId,
      runId: run.id,
      projectId: DEFAULT_IDS.project,
      engineToken: token,
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });

    const client = socketIoClient(`http://127.0.0.1:${api.sandboxWsPort}`, {
      transports: opts?.transports ?? ["websocket"],
      path: "/worker/ws",
      auth: { sandboxId },
      reconnection: false,
    });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("connect timeout")), 5000);
      client.on("connect", () => {
        clearTimeout(t);
        res();
      });
      client.on("connect_error", (e) => {
        clearTimeout(t);
        rej(e);
      });
    });

    const workerClient = createRpcClient<WorkerContract>(
      client as unknown as Parameters<typeof createRpcClient>[0],
      5000,
    );
    const notifyClient = createNotifyClient<WorkerNotifyContract>(
      client as unknown as Parameters<typeof createNotifyClient>[0],
    );
    return {
      sandboxId,
      runId: run.id,
      projectId: DEFAULT_IDS.project,
      token,
      client,
      workerClient,
      notifyClient,
      flowId: flow.id,
      flowVersionId: v.id,
    };
  }

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    signer = new EngineTokenSigner();
    registry = new SandboxRegistry();
    api = new SandboxApi({
      signer,
      registry,
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  test("an engine reply larger than socket.io's 1MB default still arrives", async () => {
    // THE ROOT CAUSE of a halted shared-runtime build. socket.io closes a
    // connection carrying an oversized frame -- silently: no error, no reply,
    // just a dropped socket. Piece metadata outgrows the 1MB default:
    // @activepieces/piece-ampeco@0.2.8 replies with 2.68MB (377 actions is
    // 0.75MB; 8 bundled i18n files add 2.2MB). The extraction then waited out
    // its whole budget for a reply that could never come, and every later
    // operation on that handle went to a dead socket.
    // POLLING is not incidental, it is the whole test, and for a sharper
    // reason than "socket.io tries polling first": under Bun the engine NEVER
    // upgrades. Its bundle carries the real `ws` npm client, whose upgrade
    // against Bun's http client comes back as `unexpected-response 101`, so a
    // live engine reads `polling` on the server side from start to finish.
    // socket.io enforces maxHttpBufferSize there as an HTTP body limit.
    //
    // Over websocket this runtime does NOT enforce it at all -- Bun's `ws`
    // shim drops `maxPayload` when it completes the upgrade, leaving Bun's own
    // 16MB frame cap in charge -- so a websocket version of this test passes
    // with the 1MB default still in place. Measured, and it is exactly how the
    // first draft came out green against the bug it was written for. An
    // in-process test client uses Bun's shim and upgrades happily, which is
    // why the transport has to be pinned here.
    const sb = await makeSandbox({ transports: ["polling"] });
    try {
      // Answer executeOperation the way the engine does, with a payload the
      // default would have refused.
      const big = "x".repeat(3 * 1024 * 1024);
      sb.client.on(
        "rpc",
        (msg: { method: string }, ack: (result: unknown) => void) => {
          if (msg.method !== "executeOperation") return;
          ack({ status: "OK", response: { blob: big } });
        },
      );

      const engine = api.workerRpc.engineClient(sb.sandboxId);
      const reply = (await engine.executeOperation(
        { operationType: "EXTRACT_PIECE_METADATA", operation: {} } as never,
        { timeoutMs: 15_000 },
      )) as { response?: { blob?: string } };

      expect(reply.response?.blob?.length).toBe(big.length);
      // And the socket survived: a refused frame would have closed it.
      expect(sb.client.connected).toBe(true);
    } finally {
      sb.client.close();
    }
  }, 30_000);

  test("a late disconnect from a REPLACED socket does not drop the live entry", async () => {
    // A reconnecting engine registers its new socket under the same sandbox
    // id. If the OLD socket's disconnect lands after that -- a server ping
    // timeout racing a completed re-handshake -- an unconditional delete drops
    // the LIVE entry, and callers then see "no connection" for an engine that
    // is connected and healthy. That used to cost a timeout; now that the
    // handle re-resolves its client per send, it would DESTROY that engine.
    const sb = await makeSandbox();
    let second: ReturnType<typeof socketIoClient> | null = null;
    try {
      second = socketIoClient(`http://127.0.0.1:${api.sandboxWsPort}`, {
        transports: ["websocket"],
        path: "/worker/ws",
        auth: { sandboxId: sb.sandboxId },
        reconnection: false,
      });
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("second connect timeout")), 5000);
        second!.once("connect", () => {
          clearTimeout(t);
          res();
        });
        second!.once("connect_error", (e) => {
          clearTimeout(t);
          rej(e);
        });
      });

      // The server now holds `second` for this sandbox. Now the OLD one goes.
      sb.client.close();
      await new Promise((r) => setTimeout(r, 300));

      expect(() => api.workerRpc.engineClient(sb.sandboxId)).not.toThrow();
    } finally {
      second?.close();
      sb.client.close();
    }
  }, 20_000);

  test("connection is rejected without a sandboxId", async () => {
    const client = socketIoClient(`http://127.0.0.1:${api.sandboxWsPort}`, {
      transports: ["websocket"],
      path: "/worker/ws",
      reconnection: false,
    });
    const result = await new Promise<"connected" | "disconnected">((res) => {
      client.on("connect", () => {
        client.on("disconnect", () => res("disconnected"));
      });
      setTimeout(() => res("connected"), 1500);
    });
    client.close();
    expect(result).toBe("disconnected");
  });

  test("connection is rejected when sandboxId is unknown", async () => {
    const client = socketIoClient(`http://127.0.0.1:${api.sandboxWsPort}`, {
      transports: ["websocket"],
      path: "/worker/ws",
      auth: { sandboxId: "definitely-not-registered" },
      reconnection: false,
    });
    const result = await new Promise<"connected" | "disconnected">((res) => {
      client.on("connect", () => {
        client.on("disconnect", () => res("disconnected"));
      });
      setTimeout(() => res("connected"), 1500);
    });
    client.close();
    expect(result).toBe("disconnected");
  });

  test("uploadRunLog patches the flow_run row", async () => {
    const sb = await makeSandbox();
    try {
      await sb.workerClient.uploadRunLog({
        runId: sb.runId,
        projectId: sb.projectId,
        status: "SUCCEEDED",
        finishTime: new Date(123_000).toISOString(),
        stepsCount: 2,
      });
      const updated = getFlowRun(sb.runId);
      expect(updated?.status).toBe("SUCCEEDED");
      expect(updated?.stepsCount).toBe(2);
      expect(updated?.finishTime).toBe(123_000);
    } finally {
      sb.client.close();
    }
  });

  test("uploadRunLog ignores rows that don't match the sandbox's runId", async () => {
    const sb = await makeSandbox();
    try {
      await sb.workerClient.uploadRunLog({
        runId: "some-other-run",
        projectId: sb.projectId,
        status: "FAILED",
      });
      const updated = getFlowRun(sb.runId);
      // Original status preserved (initial state is QUEUED from createFlowRun)
      expect(updated?.status).not.toBe("FAILED");
    } finally {
      sb.client.close();
    }
  });

  test("uploadRunLog maps the engine's failedStep.message onto errorMessage", async () => {
    const sb = await makeSandbox();
    try {
      await sb.workerClient.uploadRunLog({
        runId: sb.runId,
        projectId: sb.projectId,
        status: "FAILED",
        failedStep: { name: "step2", displayName: "Send Email", message: "boom" },
      });
      const updated = getFlowRun(sb.runId);
      expect(updated?.failedStep).toEqual({
        name: "step2",
        displayName: "Send Email",
        errorMessage: "boom",
      });
    } finally {
      sb.client.close();
    }
  });

  // Regression: an engine the daemon has already given up on keeps its 15s
  // backup loop running and re-reports RUNNING. Letting that land flips a
  // settled run back to RUNNING forever -- the "zombie run" symptom.
  test("uploadRunLog does not resurrect a run that already settled", async () => {
    const sb = await makeSandbox();
    try {
      updateRun(sb.runId, { status: "FAILED", finishTime: 999 });
      await sb.workerClient.uploadRunLog({
        runId: sb.runId,
        projectId: sb.projectId,
        status: "RUNNING",
      });
      expect(getFlowRun(sb.runId)?.status).toBe("FAILED");
    } finally {
      sb.client.close();
    }
  });

  test("updateRunProgress does not resurrect a run that already settled", async () => {
    const sb = await makeSandbox();
    try {
      updateRun(sb.runId, { status: "FAILED", finishTime: 999 });
      await sb.workerClient.updateRunProgress({
        flowRun: {
          id: sb.runId,
          status: "RUNNING",
          flowId: sb.flowId,
          flowVersionId: sb.flowVersionId,
          projectId: sb.projectId,
        },
        step: { name: "late", path: [], output: { late: true } },
      });
      const after = getFlowRun(sb.runId);
      expect(after?.status).toBe("FAILED");
      expect(after?.steps ?? {}).not.toHaveProperty("late");
    } finally {
      sb.client.close();
    }
  });

  // The normal end of a failing run: the engine reports the terminal verdict
  // via updateRunProgress and only then sends the uploadRunLog carrying
  // failedStep / stepsCount / finishTime. A guard that rejected everything
  // once the row reads FAILED would drop exactly the detail the run history
  // needs.
  test("a settled run still accepts the engine's terminal uploadRunLog", async () => {
    const sb = await makeSandbox();
    try {
      await sb.workerClient.updateRunProgress({
        flowRun: {
          id: sb.runId,
          status: "FAILED",
          flowId: sb.flowId,
          flowVersionId: sb.flowVersionId,
          projectId: sb.projectId,
        },
      });
      expect(getFlowRun(sb.runId)?.status).toBe("FAILED");

      await sb.workerClient.uploadRunLog({
        runId: sb.runId,
        projectId: sb.projectId,
        status: "FAILED",
        failedStep: { name: "step2", displayName: "Send Email", message: "boom" },
        stepsCount: 2,
        finishTime: new Date(456_000).toISOString(),
      });
      const after = getFlowRun(sb.runId);
      expect(after?.failedStep?.name).toBe("step2");
      expect(after?.failedStep?.errorMessage).toBe("boom");
      expect(after?.stepsCount).toBe(2);
      expect(after?.finishTime).toBe(456_000);
    } finally {
      sb.client.close();
    }
  });

  // PAUSED is not terminal: a resumed run reports RUNNING again under the
  // same runId, and that must still be recorded.
  test("a PAUSED run still accepts progress from its resume attempt", async () => {
    const sb = await makeSandbox();
    try {
      updateRun(sb.runId, { status: "PAUSED" });
      await sb.workerClient.uploadRunLog({
        runId: sb.runId,
        projectId: sb.projectId,
        status: "RUNNING",
      });
      expect(getFlowRun(sb.runId)?.status).toBe("RUNNING");
    } finally {
      sb.client.close();
    }
  });

  test("updateRunProgress stashes the latest progress for the sandbox", async () => {
    const sb = await makeSandbox();
    try {
      await sb.workerClient.updateRunProgress({
        flowRun: {
          id: sb.runId,
          status: "RUNNING",
          flowId: sb.flowId,
          flowVersionId: sb.flowVersionId,
          projectId: sb.projectId,
        },
      });
      const last = api.workerHandlers.lastProgress.get(sb.sandboxId);
      expect(last?.flowRun.status).toBe("RUNNING");
    } finally {
      sb.client.close();
    }
  });

  test("notify channel: stdout + stderr land in the per-sandbox log buffer", async () => {
    const sb = await makeSandbox();
    try {
      sb.notifyClient.stdout({ message: "hello from a piece" });
      sb.notifyClient.stderr({ message: "warning bro" });
      // Notify is fire-and-forget; give it one tick.
      await new Promise<void>((res) => setTimeout(res, 50));
      const buf = api.workerHandlers.logBuffer.get(sb.sandboxId) ?? [];
      expect(buf.length).toBe(2);
      expect(buf[0]?.stream).toBe("stdout");
      expect(buf[0]?.message).toBe("hello from a piece");
      expect(buf[1]?.stream).toBe("stderr");
      expect(buf[1]?.message).toBe("warning bro");
    } finally {
      sb.client.close();
    }
  });

  test("sendFlowResponse fires the registered onFlowResponse callback", async () => {
    let captured: { sandboxId: string; status: number } | null = null;
    api.workerHandlers.setOnFlowResponse((sandboxId, req) => {
      captured = { sandboxId, status: req.runResponse.status };
    });
    const sb = await makeSandbox();
    try {
      await sb.workerClient.sendFlowResponse({
        workerHandlerId: "h1",
        httpRequestId: "r1",
        runResponse: { status: 201, body: {}, headers: {} },
      });
      expect(captured).not.toBeNull();
      expect(captured!.status).toBe(201);
      expect(captured!.sandboxId).toBe(sb.sandboxId);
    } finally {
      sb.client.close();
    }
  });
});

/**
 * Connection-path diagnostics. These cover the log output rather than the RPC
 * contracts: when an engine fails to reach the daemon, that log is the only
 * evidence available, and each of these cases used to be silent.
 */
describe("WorkerRpcServer: connection diagnostics", () => {
  let server: WorkerRpcServer | null = null;
  let client: ReturnType<typeof socketIoClient> | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await server?.stop();
    server = null;
  });

  const noopWorkerHandlers = {
    async updateRunProgress() {},
    async updateStepProgress() {},
    async uploadRunLog() {},
    async sendFlowResponse() {},
  } as unknown as ConstructorParameters<typeof WorkerRpcServer>[0]["workerHandlers"];

  const noopNotifyHandlers = {
    stdout() {},
    stderr() {},
  } as unknown as ConstructorParameters<typeof WorkerRpcServer>[0]["notifyHandlers"];

  async function startServer(registry: SandboxRegistry): Promise<WorkerRpcServer> {
    const s = new WorkerRpcServer({
      registry,
      workerHandlers: noopWorkerHandlers,
      notifyHandlers: noopNotifyHandlers,
    });
    server = s;
    await s.start();
    return s;
  }

  function connect(port: number, auth?: { sandboxId: string }): ReturnType<typeof socketIoClient> {
    const socket = socketIoClient(`ws://127.0.0.1:${port}`, {
      path: "/worker/ws",
      ...(auth ? { auth } : {}),
      reconnection: false,
      transports: ["websocket"],
    });
    client = socket;
    return socket;
  }

  function registerSandbox(registry: SandboxRegistry, sandboxId: string): void {
    registry.register({
      sandboxId,
      runId: "run_diag",
      projectId: DEFAULT_IDS.project,
      engineToken: "token",
      expiresAt: Date.now() + 60_000,
      terminatedAt: null,
    });
  }

  /** Run `fn` with console.warn captured. */
  async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      await fn();
    } finally {
      console.warn = original;
    }
    return lines;
  }

  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test("binds the RPC socket to loopback only, not every interface", async () => {
    const s = await startServer(new SandboxRegistry());
    const port = s.getPort();
    expect(port).toBeGreaterThan(0);
    const { execSync } = await import("node:child_process");
    const listening = execSync(`ss -ltn 2>/dev/null | grep ":${port} " || true`).toString();
    if (listening.trim() === "") return; // no `ss` on this host; nothing to assert
    // Match the LOCAL address column specifically -- `ss` prints "0.0.0.0:*"
    // as the peer of every listening socket, loopback-bound ones included.
    expect(listening).toContain(`127.0.0.1:${port}`);
    expect(listening).not.toContain(`0.0.0.0:${port}`);
    expect(listening).not.toContain(`*:${port}`);
  });

  test("an engine that connects after the wait timed out is reported as late, not lost", async () => {
    const registry = new SandboxRegistry();
    const s = await startServer(registry);
    const sandboxId = "sandbox-late";
    registerSandbox(registry, sandboxId);

    const warnings = await captureWarnings(async () => {
      await expect(s.waitForConnection(sandboxId, 30)).rejects.toThrow(
        "did not connect within 30ms",
      );
      const socket = connect(s.getPort(), { sandboxId });
      await new Promise<void>((res, rej) => {
        socket.on("connect", () => res());
        socket.on("connect_error", rej);
      });
      await settle(50);
    });

    expect(
      warnings.some(
        (w) => w.includes("AFTER the daemon") && w.includes("JARVIS_ENGINE_HANDSHAKE_TIMEOUT_MS"),
      ),
    ).toBe(true);
  });

  test("a connection for an unknown sandbox is logged, not silently dropped", async () => {
    const s = await startServer(new SandboxRegistry());

    const warnings = await captureWarnings(async () => {
      const socket = connect(s.getPort(), { sandboxId: "sandbox-nobody-knows" });
      await new Promise<void>((res) => {
        socket.on("disconnect", () => res());
        socket.on("connect_error", () => res());
        setTimeout(res, 500);
      });
      await settle(20);
    });

    expect(warnings.some((w) => w.includes("unknown or terminated sandbox"))).toBe(true);
  });

  test("a connection with no sandboxId in auth is logged", async () => {
    const s = await startServer(new SandboxRegistry());

    const warnings = await captureWarnings(async () => {
      const socket = connect(s.getPort());
      await new Promise<void>((res) => {
        socket.on("disconnect", () => res());
        socket.on("connect_error", () => res());
        setTimeout(res, 500);
      });
      await settle(20);
    });

    expect(warnings.some((w) => w.includes("missing sandboxId in auth"))).toBe(true);
  });

  test("a normal connection resolves a pending waiter with no warning", async () => {
    const registry = new SandboxRegistry();
    const s = await startServer(registry);
    const sandboxId = "sandbox-ok";
    registerSandbox(registry, sandboxId);

    const warnings = await captureWarnings(async () => {
      const pending = s.waitForConnection(sandboxId, 2_000);
      connect(s.getPort(), { sandboxId });
      await pending;
    });

    expect(warnings).toEqual([]);
  });
});
