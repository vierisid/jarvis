/**
 * Unit tests for `EngineFlowExecutor` -- the post-K3 production executor.
 * These don't spawn the real engine; they stub `EngineRuntime` + the run
 * row to exercise the executor's:
 *   - race tolerance with delayed `uploadRunLog` (executeFlow resolves
 *     before the run row reaches a terminal status)
 *   - per-status error handling for every non-success terminal state
 *   - error-message propagation from `failedStep.errorMessage`
 *   - timeout when no terminal status ever lands
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../db/index";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, lockVersion, type FlowVersion } from "../../db/repos/flow-version";
import { createFlowRun, updateRun, getFlowRun, type FlowRunStatus } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { FlowExecutionError } from "../handler";
import type { Job } from "../../db/repos/job-queue";
import { EngineFlowExecutor } from "./engine-flow-executor";
import type { EngineHandle, EngineRuntime } from "./engine-runtime";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

interface ScriptedHandleOpts {
  /** Called inside `executeFlow` before resolving (the fake "engine" callback). */
  onExecute?: (runId: string) => void | Promise<void>;
}

function scriptedRuntime(opts: ScriptedHandleOpts = {}): EngineRuntime {
  const handle = {
    async executeFlow(_args: { flowVersion: FlowVersion }) {
      // The runtime contract: executeFlow resolves when the engine's
      // `executeOperation` reply lands, which may be BEFORE `uploadRunLog`.
      // Tests use `onExecute` to update the run row in whichever order they
      // want to simulate (synchronously here, deferred via setTimeout below).
      return undefined;
    },
    async release() {
      // noop
    },
  } as unknown as EngineHandle;
  return {
    async acquire(args: { runId: string; projectId: string }): Promise<EngineHandle> {
      void args.projectId;
      // Trigger the optional callback in next-tick to widen the race window
      // and exercise the executor's polling loop.
      if (opts.onExecute) {
        const cb = opts.onExecute;
        queueMicrotask(() => {
          void cb(args.runId);
        });
      }
      return handle;
    },
  } as unknown as EngineRuntime;
}

function setupRun(): { runId: string; ctx: Parameters<EngineFlowExecutor["execute"]>[0] } {
  const flow = createFlow({ projectId: DEFAULT_IDS.project });
  const v = createDraftVersion({
    flowId: flow.id,
    displayName: "test",
    trigger: { name: "trigger", type: "EMPTY" },
  });
  lockVersion(v.id);
  const run = createFlowRun({
    flowId: flow.id,
    flowVersionId: v.id,
    environment: "TESTING",
  });
  const fakeJob = {
    id: "job_x",
    payload: { runId: run.id },
  } as unknown as Job<{ runId: string; executeTrigger?: boolean }>;
  return {
    runId: run.id,
    ctx: {
      run: getFlowRun(run.id)!,
      version: { ...v, trigger: { name: "trigger", type: "EMPTY" } } as FlowVersion,
      job: fakeJob,
      payload: {},
    },
  };
}

describe("EngineFlowExecutor", () => {
  test("waits for terminal status when uploadRunLog lands AFTER executeFlow resolves", async () => {
    const { runId, ctx } = setupRun();
    const runtime = scriptedRuntime({
      onExecute: async (id) => {
        // Land the terminal status ~50ms after executeFlow resolves -- well
        // within the executor's poll window.
        await new Promise((r) => setTimeout(r, 50));
        updateRun(id, {
          status: "SUCCEEDED",
          steps: { step_1: { ok: true } },
          stepsCount: 1,
        });
      },
    });
    const exec = new EngineFlowExecutor(runtime, {
      terminalTimeoutMs: 1_000,
      terminalPollIntervalMs: 10,
    });
    const result = await exec.execute(ctx);
    expect(result.stepsCount).toBe(1);
    void runId;
  });

  test("times out and throws when uploadRunLog never lands", async () => {
    const { ctx } = setupRun();
    const runtime = scriptedRuntime(); // no terminal status ever set
    const exec = new EngineFlowExecutor(runtime, {
      terminalTimeoutMs: 100,
      terminalPollIntervalMs: 10,
    });
    await expect(exec.execute(ctx)).rejects.toThrow(/did not reach terminal status/);
  });

  for (const status of [
    "FAILED",
    "INTERNAL_ERROR",
    "TIMEOUT",
    "QUOTA_EXCEEDED",
    "STOPPED",
    "MEMORY_LIMIT_EXCEEDED",
    "SCHEDULE_FAILURE",
  ] as FlowRunStatus[]) {
    test(`throws FlowExecutionError on ${status} terminal status`, async () => {
      const { ctx } = setupRun();
      const runtime = scriptedRuntime({
        onExecute: async (id) => {
          updateRun(id, {
            status,
            steps: {},
            stepsCount: 0,
            failedStep: {
              name: "step_a",
              displayName: "Step A",
              errorMessage: `boom on ${status}`,
            },
          });
        },
      });
      const exec = new EngineFlowExecutor(runtime, {
        terminalTimeoutMs: 1_000,
        terminalPollIntervalMs: 10,
      });
      const error = await exec.execute(ctx).then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(FlowExecutionError);
      const fe = error as FlowExecutionError;
      expect(fe.failedStep.name).toBe("step_a");
      // Error message includes the status, the failing step, and the
      // engine-side errorMessage detail.
      expect(fe.message).toContain(status);
      expect(fe.message).toContain("step_a");
      expect(fe.message).toContain(`boom on ${status}`);
    });
  }

  test("PAUSED is treated as terminal (not a failure) -- the resume comes via a separate RUN_FLOW", async () => {
    const { ctx } = setupRun();
    const runtime = scriptedRuntime({
      onExecute: (id) => {
        updateRun(id, { status: "PAUSED", steps: {}, stepsCount: 0 });
      },
    });
    const exec = new EngineFlowExecutor(runtime, {
      terminalTimeoutMs: 1_000,
      terminalPollIntervalMs: 10,
    });
    const result = await exec.execute(ctx);
    expect(result.stepsCount).toBe(0);
  });

  test("RESUME: passes resumePayload + unwrapped executionState.steps to engine", async () => {
    const { runId, ctx } = setupRun();
    // Seed prior step output in the wrapped envelope shape that
    // worker-handler accumulates into `flow_run.steps`.
    updateRun(runId, {
      status: "PAUSED",
      steps: {
        step_a: { output: { type: "PIECE", status: "SUCCEEDED", input: {}, output: { x: 1 } } },
        step_b: { output: { type: "PIECE", status: "PAUSED", input: {}, output: {} } },
      },
    });
    ctx.run = getFlowRun(runId)!;
    (ctx.job as unknown as { payload: { runId: string; executionType?: string; resumePayload?: Record<string, unknown> } }).payload = {
      runId,
      executionType: "RESUME",
      resumePayload: { wokeWith: "external-signal" },
    };

    let capturedFlowOpts: Record<string, unknown> | null = null;
    const handle = {
      async executeFlow(opts: Record<string, unknown>) {
        capturedFlowOpts = opts;
        // Land terminal status so the executor returns cleanly.
        updateRun(runId, { status: "SUCCEEDED" });
      },
      async release() {},
    };
    const fakeRuntime = {
      acquire: async () => handle,
    } as unknown as import("./engine-runtime").EngineRuntime;
    const exec = new EngineFlowExecutor(fakeRuntime, {
      terminalTimeoutMs: 1_000,
      terminalPollIntervalMs: 10,
    });
    await exec.execute(ctx);

    expect(capturedFlowOpts).not.toBeNull();
    const opts = capturedFlowOpts as unknown as Record<string, unknown>;
    expect(opts["executionType"]).toBe("RESUME");
    expect(opts["resumePayload"]).toEqual({ wokeWith: "external-signal" });
    // The executionState.steps should be UNWRAPPED -- engine expects raw
    // StepOutput, not our `{ output: <...> }` envelope.
    const state = opts["executionState"] as { steps: Record<string, unknown> };
    expect(state.steps["step_a"]).toEqual({ type: "PIECE", status: "SUCCEEDED", input: {}, output: { x: 1 } });
    expect(state.steps["step_b"]).toEqual({ type: "PIECE", status: "PAUSED", input: {}, output: {} });
  });

  test("includes failed step but no errorMessage suffix when engine didn't supply one", async () => {
    const { ctx } = setupRun();
    const runtime = scriptedRuntime({
      onExecute: (id) => {
        updateRun(id, {
          status: "FAILED",
          steps: {},
          stepsCount: 0,
          failedStep: { name: "step_b", displayName: "Step B" },
        });
      },
    });
    const exec = new EngineFlowExecutor(runtime, {
      terminalTimeoutMs: 1_000,
      terminalPollIntervalMs: 10,
    });
    const error = await exec.execute(ctx).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(FlowExecutionError);
    const fe = error as FlowExecutionError;
    expect(fe.message).toContain("step_b");
    expect(fe.message).not.toMatch(/: $/);
  });

  test("RESUME prefers the engine's zstd log backup over flow_run.steps", async () => {
    // Backup file present in the per-test loaderBaseDir -> executor must use
    // the recursive steps + tags from the backup, not the partial accumulator
    // state in `flow_run.steps`.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve: pathResolve } = await import("node:path");
    const { promisify } = await import("node:util");
    const { zstdCompress: zstdCompressCb } = await import("node:zlib");
    const zstdCompress = promisify(zstdCompressCb);
    const loaderBaseDir = mkdtempSync(join(tmpdir(), "jarvis-resume-restore-"));
    try {
      const { runId, ctx } = setupRun();
      // The DB-side `flow_run.steps` only carries the outer (incomplete) shape.
      // The backup carries the canonical recursive iteration state -- if the
      // executor falls through to flow_run.steps, the LOOP iteration tracker
      // is lost.
      updateRun(runId, {
        status: "PAUSED",
        steps: {
          loop_a: { output: { type: "LOOP_ON_ITEMS", status: "PAUSED", input: {}, output: { iterations: [] } } },
        },
      });
      ctx.run = getFlowRun(runId)!;

      // Engine-format backup: zstd(JSON.stringify({ executionState: { steps, tags }})).
      const backupPayload = {
        executionState: {
          steps: {
            loop_a: {
              type: "LOOP_ON_ITEMS",
              status: "PAUSED",
              input: {},
              output: {
                iterations: [
                  { inner: { type: "PIECE", status: "SUCCEEDED", input: {}, output: 7 } },
                  { inner: { type: "PIECE", status: "PAUSED", input: {}, output: {} } },
                ],
              },
            },
          },
          tags: ["important-tag"],
        },
      };
      const compressed = (await zstdCompress(Buffer.from(JSON.stringify(backupPayload)))) as Buffer;
      writeFileSync(pathResolve(loaderBaseDir, `${runId}.bin`), compressed);

      (ctx.job as unknown as { payload: { runId: string; executionType?: string; resumePayload?: Record<string, unknown> } }).payload = {
        runId,
        executionType: "RESUME",
        resumePayload: { event: "external" },
      };

      let captured: Record<string, unknown> | null = null;
      const handle = {
        async executeFlow(opts: Record<string, unknown>) {
          captured = opts;
          updateRun(runId, { status: "SUCCEEDED" });
        },
        async release() {},
      };
      const fakeRuntime = {
        acquire: async () => handle,
      } as unknown as import("./engine-runtime").EngineRuntime;
      const exec = new EngineFlowExecutor(fakeRuntime, {
        terminalTimeoutMs: 1_000,
        terminalPollIntervalMs: 10,
        loaderBaseDir,
      });
      await exec.execute(ctx);

      expect(captured).not.toBeNull();
      const opts = captured as unknown as Record<string, unknown>;
      const state = opts["executionState"] as { steps: Record<string, unknown>; tags: string[] };
      expect(state.tags).toEqual(["important-tag"]);
      const loop = state.steps["loop_a"] as {
        output: { iterations: Array<Record<string, { status: string; output: unknown }>> };
      };
      // Iteration state from the backup, not the empty array in flow_run.steps.
      expect(loop.output.iterations).toHaveLength(2);
      expect(loop.output.iterations[0]!.inner!.output).toBe(7);
      expect(loop.output.iterations[1]!.inner!.status).toBe("PAUSED");
    } finally {
      rmSync(loaderBaseDir, { recursive: true, force: true });
    }
  });

  test("RESUME falls back to flow_run.steps when no backup file exists", async () => {
    // Point the loader at an empty temp dir so `loadExecutionStateFromLog`
    // returns null. The executor must then unwrap `flow_run.steps`.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const loaderBaseDir = mkdtempSync(join(tmpdir(), "jarvis-resume-fallback-"));
    try {
      const { runId, ctx } = setupRun();
      updateRun(runId, {
        status: "PAUSED",
        steps: {
          step_a: { output: { type: "PIECE", status: "SUCCEEDED", input: {}, output: { x: 1 } } },
        },
      });
      ctx.run = getFlowRun(runId)!;
      (ctx.job as unknown as { payload: { runId: string; executionType?: string; resumePayload?: Record<string, unknown> } }).payload = {
        runId,
        executionType: "RESUME",
        resumePayload: {},
      };

      let captured: Record<string, unknown> | null = null;
      const handle = {
        async executeFlow(opts: Record<string, unknown>) {
          captured = opts;
          updateRun(runId, { status: "SUCCEEDED" });
        },
        async release() {},
      };
      const fakeRuntime = {
        acquire: async () => handle,
      } as unknown as import("./engine-runtime").EngineRuntime;
      const exec = new EngineFlowExecutor(fakeRuntime, {
        terminalTimeoutMs: 1_000,
        terminalPollIntervalMs: 10,
        loaderBaseDir,
      });
      await exec.execute(ctx);

      const opts = captured as unknown as Record<string, unknown>;
      const state = opts["executionState"] as { steps: Record<string, unknown>; tags: string[] };
      expect(state.tags).toEqual([]);
      // Unwrapped (the worker-handler envelope's `output` field is stripped).
      expect(state.steps["step_a"]).toEqual({ type: "PIECE", status: "SUCCEEDED", input: {}, output: { x: 1 } });
    } finally {
      rmSync(loaderBaseDir, { recursive: true, force: true });
    }
  });
});
