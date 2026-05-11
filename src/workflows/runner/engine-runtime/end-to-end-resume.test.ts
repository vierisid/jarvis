/**
 * Full RESUME flow end-to-end: a flow with three steps where step 2 pauses
 * via a WEBHOOK waitpoint. Validates the entire pause -> backup -> resume
 * cycle, including:
 *   - The pause produces a `flow_run.steps[step2]` entry with PAUSED status
 *     and the run transitions to status=PAUSED.
 *   - The engine writes a zstd-compressed execution-state backup (the file
 *     the resume path reads to restore preceding-step outputs).
 *   - The resume re-issues EXECUTE_FLOW with `executionType: RESUME` +
 *     `executionState` rebuilt from the zstd backup.
 *   - After resume, step 3 references {{ step_1.output... }} and the
 *     template resolves correctly (regression: if the backup restoration
 *     is broken, step_1.output is undefined here).
 *
 * Gated on `JARVIS_TEST_ENGINE_BUILD=1` like the other engine-runtime tests.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  lockVersion,
  updateDraftVersion,
} from "../../db/repos/flow-version";
import type { FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import { workflowLogsBase } from "../../sandbox-api/config";
import { listWaitpointsByFlowRun } from "../../db/repos/waitpoint";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(
    ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
    "pieces/jarvis/test/dist/src/index.js",
  ),
);
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";
const PIECE_VERSION = "0.0.1";

describe("Engine end-to-end: full RESUME via zstd backup", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "pause -> zstd backup -> resume picks up preceding step output",
    async () => {
      // ── flow shape ───────────────────────────────────────────────
      // trigger (manual, payload={tick: 1})
      //   -> step_1 (echo {hello: "world", n: 42})
      //   -> step_2 (wait_for_signal -- PAUSES here)
      //   -> step_3 (echo {echoed_n: {{ step_1.output.echo.n }}})
      //
      // On RESUME, step_3 must dereference step_1's output. If the zstd
      // backup wasn't restored, step_1.output is undefined and the template
      // resolves to null -- which the assertion below catches.
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: { tick: 1 } },
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Echo before pause",
          settings: {
            pieceName: PIECE_TEST_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "echo",
            input: { value: { hello: "world", n: 42 } },
          },
          nextAction: {
            name: "step_2",
            type: "PIECE",
            displayName: "Wait for signal",
            settings: {
              pieceName: PIECE_TEST_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "wait_for_signal",
              input: { label: "the-pause" },
            },
            nextAction: {
              name: "step_3",
              type: "PIECE",
              displayName: "Echo after resume",
              settings: {
                pieceName: PIECE_TEST_NAME,
                pieceVersion: PIECE_VERSION,
                actionName: "echo",
                // Template references step_1's output. Upstream's resolver
                // exposes `{{step_name.<key>}}` directly mapped to the
                // step's output (see flow-execution-context.ts:extractOutput),
                // so `step_1.echo.n` resolves to step_1.output.echo.n = 42.
                // If the zstd restoration is broken, step_1 is missing from
                // executionState and the resolver returns "" (the engine's
                // unresolved-variable substitution).
                input: { value: { echoed_n: "{{step_1.echo.n}}" } },
              },
            },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "resume-e2e",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });

      // ── BEGIN: walk until the pause ───────────────────────────────
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        // streamStepProgress=WEBSOCKET so the engine pushes per-step
        // outputs to flow_run.steps via updateRunProgress. Without it the
        // step map stays empty (production runs use NONE for efficiency;
        // tests need the per-step trail to assert behaviour).
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
          streamStepProgress: "WEBSOCKET",
          runEnvironment: "TESTING",
        });
        if (finalRun.status !== "PAUSED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("PAUSED");
      } finally {
        await handle.release();
      }

      // Sanity: the waitpoint is recorded in the waitpoint repo.
      const waitpoints = listWaitpointsByFlowRun(run.id, false);
      expect(waitpoints).toHaveLength(1);
      const waitpointId = waitpoints[0]!.id;

      // Sanity: the zstd backup was written by the engine's run-progress.
      const backupPath = resolve(workflowLogsBase(), `${run.id}.bin`);
      expect(existsSync(backupPath)).toBe(true);
      // Non-empty file (zstd compressed but >0 bytes -- empty means the
      // engine's backup write was skipped, which would mean the resume
      // restoration relies on the fallback path that doesn't cover
      // template references).
      expect(readFileSync(backupPath).byteLength).toBeGreaterThan(0);

      // ── RESUME: re-issue EXECUTE_FLOW with executionType=RESUME ──
      // The executor reads the zstd backup and rebuilds executionState
      // (steps + tags). Step 3 then dereferences step_1.output.
      //
      // We use the EngineHandle directly here rather than going through
      // the run endpoint + worker so the test stays self-contained and
      // doesn't need a running worker loop. The contract being tested is
      // the executor's RESUME path, which is the same regardless of how
      // the job was enqueued.
      const handle2 = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf2 = "";
      handle2.stderr?.on("data", (d) => { stderrBuf2 += d.toString(); });
      try {
        // Load the executionState from the zstd backup (same code path the
        // EngineFlowExecutor's RESUME branch uses).
        const { loadExecutionStateFromLog } = await import("./execution-state-loader");
        const restored = await loadExecutionStateFromLog(run.id);
        expect(restored).not.toBeNull();
        // step_1's recorded output must round-trip through the backup --
        // this is the regression we're guarding.
        const step1 = restored!.steps["step_1"] as { output?: { echo?: { n?: number } } } | undefined;
        expect(step1?.output?.echo?.n).toBe(42);

        const finalRun = await handle2.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
          executionType: "RESUME",
          resumePayload: { queryParams: { action: "approve" } },
          executionState: restored!,
          streamStepProgress: "WEBSOCKET",
          runEnvironment: "TESTING",
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf2.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle2.release();
      }

      // ── Final assertions: step_3 resolved {{step_1.output.echo.n}} ──
      const persisted = getFlowRun(run.id);
      expect(persisted?.status).toBe("SUCCEEDED");
      const steps = (persisted?.steps ?? {}) as Record<string, { output?: unknown }>;
      // Three-layer unwrap to reach the action's return value:
      //   - flow_run.steps[name]            = worker-handler envelope `{output: StepOutput}`
      //   - .output                          = StepOutput object `{type, status, input, output}`
      //   - .output.output                   = action's return value, which for `echo` is `{echo: <input>}`
      //   - .output.output.echo              = the input value the user supplied
      const step3Envelope = steps["step_3"] as
        | { output?: { output?: { echo?: { echoed_n?: unknown } } } }
        | undefined;
      // The template `{{step_1.output.echo.n}}` resolves to the *number* 42
      // (upstream coerces single-template strings to the underlying value).
      expect(step3Envelope?.output?.output?.echo?.echoed_n).toBe(42);
    },
    90_000,
  );

  test.skipIf(skipE2eTests)(
    "LOOP+RESUME: iteration state survives the pause/resume round-trip",
    async () => {
      // flow shape:
      //   trigger (manual)
      //     -> loop_a (LOOP over items=[42])
      //          body: [step_pause, step_echo (uses {{loop_a.item}})]
      //     -> step_final (after loop)
      //
      // Single-item loop on purpose: the wait_for_signal action pauses on
      // every BEGIN execution. With multi-item loops, each iteration would
      // pause again -- testing that requires multiple resume cycles, which
      // is out of scope here. One iteration is enough to verify the LOOP's
      // iteration-state shape round-trips through the zstd backup.
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "loop_a",
          type: "LOOP_ON_ITEMS",
          displayName: "Loop",
          settings: { items: "{{[42]}}" },
          firstLoopAction: {
            name: "step_pause",
            type: "PIECE",
            displayName: "Pause inside loop",
            settings: {
              pieceName: PIECE_TEST_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "wait_for_signal",
              input: {},
            },
            nextAction: {
              name: "step_echo",
              type: "PIECE",
              displayName: "Echo loop item",
              settings: {
                pieceName: PIECE_TEST_NAME,
                pieceVersion: PIECE_VERSION,
                actionName: "echo",
                // {{loop_a.item}} resolves to the current iteration's item.
                input: { value: { item: "{{loop_a.item}}" } },
              },
            },
          },
          nextAction: {
            name: "step_final",
            type: "PIECE",
            displayName: "After loop",
            settings: {
              pieceName: PIECE_TEST_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "echo",
              input: { value: { done: true } },
            },
          },
        },
      };
      const v = createDraftVersion({ flowId: flow.id, displayName: "loop-resume", trigger });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);
      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });

      // ── BEGIN: walk until pause inside iter 0 ──
      const h1 = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      h1.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const paused = await h1.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
          streamStepProgress: "WEBSOCKET",
          runEnvironment: "TESTING",
        });
        if (paused.status !== "PAUSED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(paused.status).toBe("PAUSED");
      } finally {
        await h1.release();
      }

      // Verify the loaded executionState has LOOP iteration shape preserved.
      const { loadExecutionStateFromLog } = await import("./execution-state-loader");
      const restored = await loadExecutionStateFromLog(run.id);
      expect(restored).not.toBeNull();
      // The LOOP step's output carries `iterations: Array<Record<stepName, StepOutput>>`
      // The pause happened on iteration 0; iteration 0's `step_pause` should be PAUSED.
      const loopStep = restored!.steps["loop_a"] as
        | { output?: { iterations?: Array<Record<string, { status?: string }>> } }
        | undefined;
      expect(loopStep?.output?.iterations).toBeDefined();
      expect(loopStep!.output!.iterations!.length).toBeGreaterThan(0);
      const iter0 = loopStep!.output!.iterations![0]!;
      expect(iter0.step_pause?.status).toBe("PAUSED");

      // ── RESUME via direct executeFlow with the restored state ──
      const h2 = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf2 = "";
      h2.stderr?.on("data", (d) => { stderrBuf2 += d.toString(); });
      try {
        const final = await h2.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
          executionType: "RESUME",
          resumePayload: { queryParams: {} },
          executionState: restored!,
          streamStepProgress: "WEBSOCKET",
          runEnvironment: "TESTING",
        });
        if (final.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf2.slice(0, 4000)}`);
        }
        expect(final.status).toBe("SUCCEEDED");
      } finally {
        await h2.release();
      }

      // ── Assertions: iteration completed, step_final ran past the loop ──
      const persisted = getFlowRun(run.id);
      expect(persisted?.status).toBe("SUCCEEDED");
      // step_final lives at the top level (outside the loop). The flat
      // flow_run.steps captures it.
      const steps = (persisted?.steps ?? {}) as Record<string, { output?: unknown }>;
      const finalEnvelope = steps["step_final"] as
        | { output?: { output?: { echo?: { done?: boolean } } } }
        | undefined;
      expect(finalEnvelope?.output?.output?.echo?.done).toBe(true);
    },
    90_000,
  );

  test.skipIf(skipE2eTests)(
    "RESUME via EngineFlowExecutor: restoreExecutionState reads the backup itself",
    async () => {
      // The first test calls handle.executeFlow directly with an explicit
      // executionState. The production path runs through
      // `EngineFlowExecutor.restoreExecutionState`, which decides between
      // the zstd backup and the flow_run.steps fallback. This test covers
      // that integration: only the executor sees the runId; it discovers
      // the backup file on its own.
      const { EngineFlowExecutor } = await import("./engine-flow-executor");
      const { RUN_FLOW } = await import("../handler");

      // ── Build a flow that pauses, just like the previous test ─────────
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "step_seed",
          type: "PIECE",
          displayName: "Seed output",
          settings: {
            pieceName: PIECE_TEST_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "echo",
            input: { value: { seeded: 99 } },
          },
          nextAction: {
            name: "step_pause",
            type: "PIECE",
            displayName: "Pause",
            settings: {
              pieceName: PIECE_TEST_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "wait_for_signal",
              input: {},
            },
            nextAction: {
              name: "step_final",
              type: "PIECE",
              displayName: "Final, references seed",
              settings: {
                pieceName: PIECE_TEST_NAME,
                pieceVersion: PIECE_VERSION,
                actionName: "echo",
                input: { value: { recovered: "{{step_seed.echo.seeded}}" } },
              },
            },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "executor-resume",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);
      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });

      // ── Pause: same direct executeFlow as the previous test ──────────
      const h1 = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      try {
        const paused = await h1.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
          streamStepProgress: "WEBSOCKET",
          runEnvironment: "TESTING",
        });
        expect(paused.status).toBe("PAUSED");
      } finally {
        await h1.release();
      }

      // ── RESUME via the executor (production path) ────────────────────
      // The executor's `restoreExecutionState` calls the loader for us;
      // we don't pass an executionState here, only stepNameToTest=undefined
      // and executionType=RESUME on the job payload.
      const executor = new EngineFlowExecutor(runtime!);
      const ctx = {
        run: getFlowRun(run.id)!,
        version: getFlowVersion(v.id)!,
        job: {
          id: "test_resume_via_executor",
          payload: {
            runId: run.id,
            executionType: "RESUME",
            resumePayload: { queryParams: {} },
          },
          jobType: RUN_FLOW,
        },
        payload: {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executor.execute(ctx as any);
      expect(result.stepsCount).toBeGreaterThanOrEqual(2);

      // step_final should have dereferenced step_seed.echo.seeded -> 99.
      const persisted = getFlowRun(run.id);
      expect(persisted?.status).toBe("SUCCEEDED");
      const finalSteps = (persisted?.steps ?? {}) as Record<string, { output?: unknown }>;
      const finalEnvelope = finalSteps["step_final"] as
        | { output?: { output?: { echo?: { recovered?: unknown } } } }
        | undefined;
      expect(finalEnvelope?.output?.output?.echo?.recovered).toBe(99);
    },
    90_000,
  );
});
