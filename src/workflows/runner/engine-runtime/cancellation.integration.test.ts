import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, lockVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { cancelFlowRun } from "../../db/repos/run-cancellation";
import { enqueue, getJob } from "../../db/repos/job-queue";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { EngineRuntime } from "./engine-runtime";
import { EngineFlowExecutor } from "./engine-flow-executor";
import { createRunFlowHandler } from "../handler";
import { Worker } from "../../queue/worker";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";

// Same gate as the other real-engine suites: the flow below runs the
// jarvis-test/tool/ask pieces, so a warm bundle cache is not enough on its own.
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const piecesAlreadyBuilt = existsSync(
  resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/test/dist/src/index.js"),
);
const skipE2eTests = (initialCached === null || !piecesAlreadyBuilt) && !buildOptIn;

describe("Engine cancellation (real engine)", () => {
  let bundlePath: string | null = null;

  beforeAll(async () => {
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    bundlePath = cached.bundlePath;
  });

  test.skipIf(skipE2eTests)("real engine stops after cancellation while daemon work is in flight", async () => {
    initWorkflowDb(":memory:");
    let entered!: () => void, release!: () => void;
    const inFlight = new Promise<void>(r => { entered = r; });
    const pending = new Promise<void>(r => { release = r; });
    let effects = 0;
    const api = new SandboxApi({ services: {
      credentialResolver: new CredentialResolver(),
      toolsInvoke: async req => { effects++; return { result: { receipt: "committed-1" }, toolName: req.toolName }; },
      llmChat: async () => { entered(); await pending; return { text: "late answer" }; },
    } });
    await api.start({ port: 0 });
    const runtime = new EngineRuntime({ api, bundlePath: bundlePath!, pool: true });
    const action = (name: string, piece: string, actionName: string, input: Record<string, unknown>, nextAction?: FlowTriggerNode): FlowTriggerNode => ({
      name, type: "PIECE", displayName: name,
      settings: { pieceName: `@jarvispieces/piece-jarvis-${piece}`, pieceVersion: "0.0.1", actionName, input },
      ...(nextAction ? { nextAction } : {}),
    });
    const trigger: FlowTriggerNode = {
      name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
      settings: { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1", triggerName: "manual", input: { payload: {} } },
      nextAction: action("first", "tool", "invoke", { toolName: "fake_effect", params: {} },
        action("pending", "ask", "ask", { prompt: "wait" },
          action("forbidden_next", "tool", "invoke", { toolName: "fake_effect", params: {} }))),
    };
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "cancellation", trigger });
    lockVersion(version.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: "TESTING" });
    const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id, maxAttempts: 1 });
    const worker = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }) }, log: () => {} });
    let draining: Promise<number> | undefined;
    try {
      draining = worker.drain();
      await Promise.race([inFlight, draining.then(() => { throw new Error(`engine ended before pending action: ${JSON.stringify(getFlowRun(run.id))}`); })]);
      expect(effects).toBe(1);
      const ack = cancelFlowRun(run.id);
      expect(ack.cancellation?.inFlightMayHaveCompleted).toBe(true);
      // Do not release the daemon callback: engine termination must not wait
      // for its HTTP response, its RPC deadline, or a remote provider outcome.
      await draining;
      expect(api.registry.byRunId(run.id)).toBeNull();
      expect(getJob(job.id)?.status).toBe("CANCELED");
      expect(getFlowRun(run.id)?.status).toBe("STOPPED");
      expect(JSON.stringify(getFlowRun(run.id)?.steps)).toContain("committed-1");
      release();
      await new Promise(r => setTimeout(r, 30));
      expect(effects).toBe(1);
    } finally {
      release();
      cancelFlowRun(run.id);
      await draining;
      await runtime.shutdown();
      await api.stop();
      closeWorkflowDb();
    }
  }, 30_000);
});
