/**
 * End-to-end test for the WS RPC bridge: spawn a real socket.io-client that
 * mirrors what the activepieces engine subprocess does on boot, exercise each
 * WorkerContract + WorkerNotifyContract method, and verify the daemon-side
 * effects.
 *
 * We deliberately do NOT spawn the engine bundle here -- this test isolates
 * the WS layer. Step D adds an end-to-end test against the real bundle.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { io as socketIoClient } from "socket.io-client";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, lockVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { DEFAULT_IDS } from "../db/schema";
import { CredentialResolver } from "../credentials/adapter";
import { EngineTokenSigner } from "./engine-token";
import { SandboxRegistry } from "./sandbox-registry";
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

  async function makeSandbox(): Promise<TestSandbox> {
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
      transports: ["websocket"],
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
