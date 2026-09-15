/** The real delay piece must survive the queue/handler boundary and a restart. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { createDraftVersion, getFlowVersion, lockVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { enqueue, getJob, queueStats } from "../../db/repos/job-queue";
import { getWaitpoint, listWaitpointsByFlowRun } from "../../db/repos/waitpoint";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { workflowLogsBase } from "../../sandbox-api/config";
import { TimerWaitpointScheduler } from "../../timer-scheduler";
import { Worker } from "../../queue/worker";
import { createRunFlowHandler, RUN_FLOW } from "../handler";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { buildPiece } from "./build-pieces";
import { EngineFlowExecutor } from "./engine-flow-executor";
import { EngineRuntime } from "./engine-runtime";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const pieceDirs = ["pieces/jarvis/test", "pieces/core/delay"].map(
  (path) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, path),
);
const skip = !buildOptIn && (!initialCached || pieceDirs.some(
  (path) => !existsSync(resolve(path, "dist/src/index.js")),
));

describe("Outer worker: real delay pause and timer continuation", () => {
  let api: SandboxApi | undefined;
  let runtime: EngineRuntime | undefined;
  let tempDir: string | undefined;
  let runId: string | undefined;
  let bundlePath: string;
  let dbPath: string;

  const startRuntime = async () => {
    initWorkflowDb(dbPath);
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });
    runtime = new EngineRuntime({ api, bundlePath, devPieces: ["jarvis-test", "delay"] });
  };
  const stopRuntime = async () => {
    await runtime?.shutdown();
    runtime = undefined;
    await api?.stop();
    api = undefined;
    closeWorkflowDb();
  };

  beforeAll(async () => {
    if (skip) return;
    bundlePath = (initialCached ?? await buildEngineBundle()).bundlePath;
    if (buildOptIn) for (const pieceDir of pieceDirs) await buildPiece(pieceDir);
    tempDir = mkdtempSync(resolve(tmpdir(), "jarvis-worker-delay-"));
    dbPath = resolve(tempDir, "workflows.sqlite");
    await startRuntime();
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await stopRuntime();
    if (runId) rmSync(resolve(workflowLogsBase(), `${runId}.bin`), { force: true });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test.skipIf(skip)("a completed slice stays PAUSED; a timer after restart resumes once with prior outputs", async () => {
    const flow = createFlow();
    const trigger: FlowTriggerNode = {
      name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
      settings: { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1", triggerName: "manual", input: {} },
      nextAction: {
        name: "seed", type: "PIECE", displayName: "Before delay",
        settings: { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1", actionName: "echo", input: { value: { n: 73 } } },
        nextAction: {
          name: "wait", type: "PIECE", displayName: "Delay",
          // >10 seconds uses the real TIMER waitpoint instead of inline sleep.
          settings: { pieceName: "@activepieces/piece-delay", pieceVersion: "0.3.27", actionName: "delayFor", input: { unit: "seconds", delayFor: 11 } },
          nextAction: {
            name: "result", type: "PIECE", displayName: "After delay",
            settings: { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1", actionName: "echo", input: { value: { n: "{{seed.echo.n}}", resumed: "{{wait.success}}" } } },
          },
        },
      },
    };
    const version = createDraftVersion({ flowId: flow.id, displayName: "outer-worker-delay", trigger });
    updateDraftVersion(version.id, { trigger, valid: true });
    lockVersion(version.id);
    // TESTING uses delayFor.test(), which intentionally never pauses.
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: "PRODUCTION" });
    runId = run.id;
    const firstJob = enqueue({ jobType: RUN_FLOW, flowRunId: run.id, maxAttempts: 1, payload: { runId: run.id } });
    const executions: string[] = [];
    const worker = () => {
      const handler = createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) });
      return new Worker({ handlers: { [RUN_FLOW]: async (job) => {
        executions.push((job.payload as { executionType?: string }).executionType ?? "BEGIN");
        await handler(job);
      } } });
    };

    await worker().drain();
    expect(getJob(firstJob.id)?.status).toBe("SUCCEEDED");
    const paused = getFlowRun(run.id)!;
    expect(paused.status).toBe("PAUSED");
    expect(paused.finishTime).toBeNull();
    expect(paused.steps?.result).toBeUndefined();
    expect(getFlowVersion(version.id)?.sampleData).toBeNull();
    expect(existsSync(resolve(workflowLogsBase(), `${run.id}.bin`))).toBe(true);
    const waits = listWaitpointsByFlowRun(run.id, false);
    expect(waits).toHaveLength(1);
    const wait = waits[0]!;
    expect(wait.type).toBe("TIMER");
    expect(wait.stepName).toBe("wait");
    expect(wait.resumedAt).toBeNull();
    const due = Date.parse(wait.resumeDateTime!);
    expect(new TimerWaitpointScheduler().tick(due - 1)).toBe(0);

    // Release subprocess/API/DB and reconstruct them from durable records.
    await stopRuntime();
    await startRuntime();
    expect(getFlowRun(run.id)?.status).toBe("PAUSED");
    const scheduler = new TimerWaitpointScheduler();
    // Advance only the scheduler's clock; the real delay piece has parked.
    expect(scheduler.tick(due)).toBe(1);
    expect(scheduler.tick(due)).toBe(0);
    await worker().drain();

    const final = getFlowRun(run.id)!;
    expect(final.status).toBe("SUCCEEDED");
    expect(final.finishTime).toBeGreaterThan(0);
    expect(final.startTime).toBe(paused.startTime);
    expect(final.steps?.seed).toEqual(paused.steps?.seed);
    expect(final.steps?.result).toMatchObject({ output: { output: { echo: { n: 73, resumed: true } } } });
    expect(getWaitpoint(wait.id)?.resumedAt).toBe(due);
    expect(queueStats()).toMatchObject({ succeeded: 2, failed: 0, queued: 0 });
    expect(executions).toEqual(["BEGIN", "RESUME"]);
    expect(scheduler.tick(due + 60_000)).toBe(0);
    await worker().drain();
    expect(executions).toEqual(["BEGIN", "RESUME"]);
  }, 90_000);
});
