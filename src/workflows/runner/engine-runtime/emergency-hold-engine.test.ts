/**
 * Pause against the real engine (Q-08). A step reached while Jarvis is paused
 * parks on a HOLD waitpoint; Resume releases it. The step must then run the
 * way it was about to: a Delay held before its first run still waits its full
 * time, a Wait for Approval still waits for its link, and a CODE step runs
 * once. Only the real engine shows that: the daemon side cannot see which way
 * the engine re-runs a parked step.
 *
 * Skipped without a built engine bundle and pieces; CI builds them for this
 * file with JARVIS_TEST_ENGINE_BUILD=1 (.github/workflows/test.yml).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow, setFlowCodeStepsEnabled } from "../../db/repos/flow";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { createDraftVersion, lockVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { enqueue } from "../../db/repos/job-queue";
import { listWaitpointsByFlowRun } from "../../db/repos/waitpoint";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { workflowLogsBase } from "../../sandbox-api/config";
import { TimerWaitpointScheduler } from "../../timer-scheduler";
import { Worker } from "../../queue/worker";
import { claimContinuation, releaseEmergencyHolds } from "../../runtime/continuation";
import { CODE_STEP_PIECE } from "../../runtime/piece-effect-guard";
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from "../../runtime/service-backends";
import { WorkflowEventBuffer } from "../../runtime/event-buffer";
import type { PieceAuthorizeFn } from "../../sandbox-api/routes/jarvis-pieces";
import { createRunFlowHandler, RUN_FLOW } from "../handler";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { buildPiece } from "./build-pieces";
import { EngineFlowExecutor } from "./engine-flow-executor";
import { EngineRuntime } from "./engine-runtime";
import { ApprovalManager } from "../../../authority/approval";
import { AuditTrail } from "../../../authority/audit";
import { AuthorityEngine } from "../../../authority/engine";
import { EmergencyController, setActiveEmergencyController } from "../../../authority/emergency";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const pieceDirs = ["pieces/jarvis/test", "pieces/core/delay", "pieces/core/approval"].map(
  (path) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, path),
);
const skip = !buildOptIn && (!initialCached || pieceDirs.some(
  (path) => !existsSync(resolve(path, "dist/src/index.js")),
));

const TEST_PIECE = { pieceName: "@jarvispieces/piece-jarvis-test", pieceVersion: "0.0.1" };
const DELAY_PIECE = { pieceName: "@activepieces/piece-delay", pieceVersion: "0.3.27" };
const APPROVAL_PIECE = { pieceName: "@activepieces/piece-approval", pieceVersion: "0.1.19" };

describe("Pause against the real engine: a held step runs as it was about to (Q-08)", () => {
  let api: SandboxApi | undefined;
  let runtime: EngineRuntime | undefined;
  let tempDir: string | undefined;
  let controller: EmergencyController;
  /** The piece whose admission presses Pause: Pause lands just as the run reaches that step. */
  let pauseAt: string | null = null;
  const runIds: string[] = [];

  beforeAll(async () => {
    if (skip) return;
    const bundlePath = (initialCached ?? await buildEngineBundle()).bundlePath;
    if (buildOptIn) for (const pieceDir of pieceDirs) await buildPiece(pieceDir);
    tempDir = mkdtempSync(resolve(tmpdir(), "jarvis-emergency-hold-"));
    // One database for both: approvals and the audit trail live beside the workflow tables.
    initWorkflowDb(resolve(tempDir, "workflows.sqlite"));
    controller = new EmergencyController();
    setActiveEmergencyController(controller);
    // The daemon's own admission: HOLD waitpoints, the paused reply, the audit row.
    const options: BuildServiceBackendsOptions = {
      credentialResolver: new CredentialResolver(),
      llmManager: { chat: async () => ({ content: "" }) } as never,
      authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
        learning: { enabled: false, suggest_threshold: 10 }, emergency_state: "normal" }),
      emergencyController: controller,
      auditTrail: new AuditTrail(),
      eventBuffer: new WorkflowEventBuffer(),
      approvalManager: new ApprovalManager(),
      channelService: { getChannelStatus: () => ({}), tryBroadcastToChannels: async () => ({ delivered: [], failed: [] }) } as never,
      wsService: { broadcastNotificationToDashboard: () => {} } as never,
    };
    const backends = buildSandboxServiceBackends(options);
    const pieceAuthorize: PieceAuthorizeFn = async (req, ctx) => {
      if (pauseAt !== null && req.piece === pauseAt) { pauseAt = null; controller.pause(); }
      return backends.pieceAuthorize!(req, ctx);
    };
    api = new SandboxApi({ services: { ...backends, pieceAuthorize } });
    await api.start({ port: 0 });
    runtime = new EngineRuntime({ api, bundlePath, devPieces: ["jarvis-test", "delay", "approval"] });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await runtime?.shutdown();
    await api?.stop();
    setActiveEmergencyController(null);
    closeWorkflowDb();
    for (const runId of runIds) rmSync(resolve(workflowLogsBase(), `${runId}.bin`), { force: true });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => { if (!skip) controller.reset(); });

  const executions: string[] = [];
  const drain = async () => {
    const handler = createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) });
    await new Worker({ handlers: { [RUN_FLOW]: async (job) => {
      executions.push((job.payload as { executionType?: string }).executionType ?? "BEGIN");
      await handler(job);
    } } }).drain();
  };
  const start = (flowId: string, versionId: string) => {
    const run = createFlowRun({ flowId, flowVersionId: versionId, environment: "PRODUCTION" });
    runIds.push(run.id);
    enqueue({ jobType: RUN_FLOW, flowRunId: run.id, maxAttempts: 1, payload: { runId: run.id } });
    return run.id;
  };
  const lockedFlow = (trigger: FlowTriggerNode) => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: "held step", trigger });
    updateDraftVersion(version.id, { trigger, valid: true });
    lockVersion(version.id);
    return { flowId: flow.id, versionId: version.id };
  };
  const open = (runId: string) => listWaitpointsByFlowRun(runId, false).map((wp) => [wp.type, wp.stepName]);
  /** Resume Jarvis, as the daemon does: release every HOLD, then let the worker run. */
  const resume = async () => {
    controller.resume();
    expect(releaseEmergencyHolds()).toBe(1);
    await drain();
  };

  test.skipIf(skip)("a Delay held before its first run still waits its full time after Resume", async () => {
    executions.length = 0;
    const { flowId, versionId } = lockedFlow({
      name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
      settings: { ...TEST_PIECE, triggerName: "manual", input: {} },
      nextAction: {
        name: "seed", type: "PIECE", displayName: "Before delay",
        settings: { ...TEST_PIECE, actionName: "echo", input: { value: { n: 7 } } },
        nextAction: {
          name: "wait", type: "PIECE", displayName: "Delay",
          // Over 10 seconds: the piece parks on a TIMER waitpoint instead of sleeping inline.
          settings: { ...DELAY_PIECE, actionName: "delayFor", input: { unit: "seconds", delayFor: 11 } },
          nextAction: {
            name: "result", type: "PIECE", displayName: "After delay",
            settings: { ...TEST_PIECE, actionName: "echo", input: { value: { n: "{{seed.echo.n}}", resumed: "{{wait.success}}" } } },
          },
        },
      },
    });
    const runId = start(flowId, versionId);
    pauseAt = DELAY_PIECE.pieceName;
    await drain();
    expect(getFlowRun(runId)?.status).toBe("PAUSED");
    expect(open(runId)).toEqual([["HOLD", "wait"]]);

    await resume();
    // The delay began when it was let go, and is waiting: it did not return at once.
    const waiting = getFlowRun(runId)!;
    expect(waiting.status).toBe("PAUSED");
    expect(waiting.steps?.result).toBeUndefined();
    const [timer] = listWaitpointsByFlowRun(runId, false);
    expect([timer?.type, timer?.stepName]).toEqual(["TIMER", "wait"]);

    expect(new TimerWaitpointScheduler().tick(Date.parse(timer!.resumeDateTime!))).toBe(1);
    await drain();
    const final = getFlowRun(runId)!;
    expect(final.status).toBe("SUCCEEDED");
    expect(final.steps?.result).toMatchObject({ output: { output: { echo: { n: 7, resumed: true } } } });
    expect(executions).toEqual(["BEGIN", "RESUME", "RESUME"]);
  }, 90_000);

  test.skipIf(skip)("a Wait for Approval held before its first run waits for its link after Resume, and reads it", async () => {
    const { flowId, versionId } = lockedFlow({
      name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
      settings: { ...TEST_PIECE, triggerName: "manual", input: {} },
      nextAction: {
        name: "approve", type: "PIECE", displayName: "Wait for approval",
        settings: { ...APPROVAL_PIECE, actionName: "wait_for_approval", input: {} },
        nextAction: {
          name: "result", type: "PIECE", displayName: "After approval",
          settings: { ...TEST_PIECE, actionName: "echo", input: { value: { approved: "{{approve.approved}}" } } },
        },
      },
    });
    const runId = start(flowId, versionId);
    pauseAt = APPROVAL_PIECE.pieceName;
    await drain();
    expect(open(runId)).toEqual([["HOLD", "approve"]]);

    await resume();
    // It made its link and is waiting on it, instead of reading a payload it never got.
    expect(getFlowRun(runId)?.status).toBe("PAUSED");
    const [link] = listWaitpointsByFlowRun(runId, false);
    expect([link?.type, link?.stepName]).toEqual(["WEBHOOK", "approve"]);

    expect(claimContinuation({ runId, waitpoint: link!, kind: "webhook",
      resumePayload: { queryParams: { action: "approve" }, body: {}, headers: {} } })).toBe("resumed");
    await drain();
    const final = getFlowRun(runId)!;
    expect(final.status).toBe("SUCCEEDED");
    expect(final.steps?.result).toMatchObject({ output: { output: { echo: { approved: true } } } });
  }, 90_000);

  test.skipIf(skip)("a CODE step held while paused runs once, after Resume", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "jarvis-held-code-"));
    const probe = join(probeDir, "runs.txt");
    try {
      const { flowId, versionId } = lockedFlow({
        name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
        settings: { ...TEST_PIECE, triggerName: "manual", input: {} },
        nextAction: {
          name: "tally", type: "CODE", displayName: "Tally",
          settings: { input: {}, sourceCode: { packageJson: "{}",
            code: `exports.code = async () => { require('node:fs').appendFileSync(${JSON.stringify(probe)}, 'ran\\n'); return { ran: true }; };` } },
        },
      });
      setFlowCodeStepsEnabled(flowId, true);
      const runId = start(flowId, versionId);
      pauseAt = CODE_STEP_PIECE;
      await drain();
      expect(open(runId)).toEqual([["HOLD", "tally"]]);
      expect(existsSync(probe)).toBe(false);

      await resume();
      expect(getFlowRun(runId)?.status).toBe("SUCCEEDED");
      expect(readFileSync(probe, "utf8")).toBe("ran\n");
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }, 90_000);
});
