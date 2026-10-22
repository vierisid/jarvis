/**
 * #1073 against the real engine: a parent parked on a required child is
 * continued through `claimContinuation`, and the RESUME job names the child's
 * MANUAL waitpoint. The RUN_FLOW handler then checks that waitpoint against
 * the paused step (`continuationRefusal` -> `stale`), so this proves the
 * engine's own record of the parked `run_workflow` step reads as PAUSED: if it
 * did not, every child continuation would be refused as stale.
 *
 * Gated on `JARVIS_TEST_ENGINE_BUILD=1` like the other engine-runtime tests.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, getFlowVersion, lockVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../../db/repos/flow-run";
import { listChildRuns } from "../../db/repos/child-run";
import { listFlowFires } from "../../db/repos/trigger-fire";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { AuthorityEngine } from "../../../authority/engine";
import { ApprovalManager } from "../../../authority/approval";
import { AuditTrail } from "../../../authority/audit";
import { EmergencyController } from "../../../authority/emergency";
import { WorkflowEventBuffer } from "../../runtime/event-buffer";
import { buildSandboxServiceBackends } from "../../runtime/service-backends";
import { resumeCompletedChildRuns } from "../../runtime/child-run-scheduler";
import { continuationRefusal, stepIsPaused } from "../../runtime/continuation";
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import { loadExecutionStateFromLog } from "./execution-state-loader";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/trigger/dist/src/index.js"))
  && existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/test/dist/src/index.js"));
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";
const PIECE_TRIGGER_NAME = "@jarvispieces/piece-jarvis-trigger";
const PIECE_VERSION = "0.0.1";

describe("Engine: a required child continues its parent through claimContinuation (#1073)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: "normal" });
    const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
      authorityEngine: authority, approvalManager: new ApprovalManager(), emergencyController: new EmergencyController(),
      auditTrail: new AuditTrail(), llmManager: {} as never, channelService: {} as never, wsService: {} as never });
    api = new SandboxApi({ services });
    await api.start({ port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath, expectedDigest: cached.digest });
  }, 120_000);

  afterAll(async () => {
    await runtime?.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)("the parked run_workflow step reads as paused, and the named waitpoint resumes it", async () => {
    const target = createFlow({ projectId: DEFAULT_IDS.project });
    createDraftVersion({ flowId: target.id, displayName: "Child", trigger: { name: "trigger", type: "EMPTY" } });
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const trigger: FlowTriggerNode = {
      name: "trigger", type: "PIECE_TRIGGER", displayName: "Manual",
      settings: { pieceName: PIECE_TEST_NAME, pieceVersion: PIECE_VERSION, triggerName: "manual", input: { payload: {} } },
      nextAction: {
        name: "child", type: "PIECE", displayName: "Run child",
        settings: { pieceName: PIECE_TRIGGER_NAME, pieceVersion: PIECE_VERSION, actionName: "run_workflow",
          input: { flow: target.id, waitForCompletion: true } },
      },
    };
    const version = createDraftVersion({ flowId: flow.id, displayName: "Parent", trigger });
    updateDraftVersion(version.id, { trigger, valid: true });
    lockVersion(version.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: "TESTING", status: "RUNNING" });

    let stderr = "";
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    handle.stderr?.on("data", (d) => { stderr += d.toString(); });
    try {
      const parked = await handle.executeFlow({ flowVersion: getFlowVersion(version.id)!, streamStepProgress: "WEBSOCKET", runEnvironment: "TESTING" });
      if (parked.status !== "PAUSED") console.error(`[engine stderr]\n${stderr.slice(0, 4000)}`);
      expect(parked.status).toBe("PAUSED");
    } finally {
      await handle.release();
    }
    const [child] = listChildRuns(run.id);
    expect(child?.waitpointId).toBeTruthy();
    // The record the handler's stale check reads, as the engine wrote it.
    expect(stepIsPaused(getFlowRun(run.id)!.steps, "child")).toBe(true);
    updateRun(run.id, { status: "PAUSED" });
    updateRun(child!.childRunId, { status: "SUCCEEDED", finishTime: Date.now() });

    expect(resumeCompletedChildRuns()).toBe(1);
    const job = getWorkflowDb().query(`SELECT payload FROM workflow_job WHERE flow_run_id = ?
      AND json_extract(payload, '$.executionType') = 'RESUME'`).get(run.id) as { payload: string };
    const payload = JSON.parse(job.payload) as { waitpointId?: string; resumePayload?: unknown };
    expect(payload.waitpointId).toBe(child!.waitpointId!);
    expect(continuationRefusal(getFlowRun(run.id)!, payload.waitpointId)).toBeNull();
    expect(listFlowFires(flow.id).map((fire) => [fire.source, fire.outcome, fire.detail?.kind])).toEqual([["resume", "started", "child"]]);

    // The continuation itself, as the executor runs a RESUME.
    const restored = await loadExecutionStateFromLog(run.id);
    expect(restored).not.toBeNull();
    const again = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    stderr = "";
    again.stderr?.on("data", (d) => { stderr += d.toString(); });
    try {
      const done = await again.executeFlow({ flowVersion: getFlowVersion(version.id)!, executionType: "RESUME",
        resumePayload: payload.resumePayload as Record<string, unknown>, executionState: restored!,
        streamStepProgress: "WEBSOCKET", runEnvironment: "TESTING" });
      if (done.status !== "SUCCEEDED") console.error(`[engine stderr]\n${stderr.slice(0, 4000)}`);
      expect(done.status).toBe("SUCCEEDED");
    } finally {
      await again.release();
    }
    // Once the step has finished, the same waitpoint would be refused: the
    // check is not vacuous on the engine's records.
    expect(continuationRefusal({ ...getFlowRun(run.id)!, status: "PAUSED" }, payload.waitpointId))
      .toBe("the step its waitpoint was for has already finished");
  }, 120_000);
});
