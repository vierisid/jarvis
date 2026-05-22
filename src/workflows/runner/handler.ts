/**
 * RUN_FLOW worker handler. Bridges the queue to flow execution:
 *   1. Claim a RUN_FLOW job (the worker has already done that for us).
 *   2. Mark the corresponding flow_run as RUNNING.
 *   3. Hand off to a pluggable FlowExecutor that knows how to actually run
 *      the flow definition.
 *   4. Persist the result to the flow_run row (steps, status, finish_time).
 *
 * The FlowExecutor is injected so this file is independent of the engine
 * spawn mechanism. The default `NoopFlowExecutor` does nothing -- it's
 * sufficient to validate the queue/run lifecycle end-to-end and lets the
 * runtime ship before the real engine wiring is done. Phase 3 swaps in a
 * `SubprocessFlowExecutor` that spawns the activepieces engine in
 * SANDBOX_PROCESS mode (per the Phase 2 sandboxing spike).
 */

import type { Job } from "../db/repos/job-queue";
import type { JobHandler } from "../queue/worker";
import { getFlowRun, updateRun, type FlowRun } from "../db/repos/flow-run";
import {
  getFlowVersion,
  mergeRunOutputsIntoSampleData,
  type FlowVersion,
} from "../db/repos/flow-version";

export const RUN_FLOW = "RUN_FLOW";

export interface RunFlowJobPayload {
  runId: string;
  /** Trigger payload / external input. Empty object for manual runs without a payload. */
  payload?: Record<string, unknown>;
  /**
   * When true, the engine first invokes the trigger's `run()` hook and
   * dispatches one flow run per item it returns. Used by engine-managed
   * triggers (e.g. polling triggers fired from cron). The legacy executor
   * ignores this flag; it's honored by the engine-backed executor.
   */
  executeTrigger?: boolean;
  /**
   * "Run from here" / per-step preview: when set, the engine executes only
   * the named step (with step inputs resolved from prior step outputs in
   * `executionState`, which the engine assembles from a sample run if
   * available, else uses the step's `sampleData`). The action's output is
   * captured on `flow_run.steps[stepName]` and the run terminates without
   * walking the rest of the chain. Used by the dashboard's "test step" UI.
   */
  stepNameToTest?: string;
  /**
   * Per-step sample outputs for "test from here" runs. Map
   * `stepName -> sampleOutput`. Forwarded to the engine so it can populate
   * preceding steps' outputs without re-running them. Ignored when
   * `stepNameToTest` is unset (production runs walk the chain for real).
   */
  sampleData?: Record<string, unknown>;
  /**
   * Per-step INPUT override applied only when `stepNameToTest` equals one
   * of the keys. Map `stepName -> input` (a plain object that replaces
   * that step's `settings.input` for the duration of the run). Lets a
   * user exercise a step manually with curated parameters without
   * editing the production-bound input.
   *
   * The route narrows this to one entry per test run (only the step
   * under test), so the engine never accidentally swaps inputs on
   * neighbouring steps.
   */
  sampleInputOverride?: Record<string, Record<string, unknown>>;
  /**
   * `RESUME` wakes a paused run -- the worker handler skips run-row
   * recreation and the executor sends EXECUTE_FLOW with executionType=RESUME
   * + resumePayload + the prior executionState restored from the run's
   * logs file. `BEGIN` (default) starts fresh from the trigger.
   */
  executionType?: "BEGIN" | "RESUME";
  /**
   * Payload delivered to the paused step. Typically the body of the webhook
   * that hit the resume URL, or a timer-fire metadata blob.
   */
  resumePayload?: Record<string, unknown>;
}

export interface FlowExecutorContext {
  run: FlowRun;
  version: FlowVersion;
  job: Job<RunFlowJobPayload>;
  /** External payload (e.g., webhook body, manual run input). */
  payload: Record<string, unknown>;
}

export interface FlowExecutorResult {
  /** Per-step output keyed by step name. Empty for trivial flows. */
  steps: Record<string, unknown>;
  stepsCount: number;
}

/** Throw `FlowExecutionError` from an executor when a specific step fails. */
export class FlowExecutionError extends Error {
  override readonly name = "FlowExecutionError";
  constructor(
    message: string,
    public readonly failedStep: { name: string; displayName: string },
    public readonly steps: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface FlowExecutor {
  execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult>;
}

/**
 * No-op executor: marks every flow as SUCCEEDED with an empty step record.
 * Used as the default until the real engine spawn lands. Works as a smoke
 * test for the queue + run lifecycle.
 */
export class NoopFlowExecutor implements FlowExecutor {
  async execute(_ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    return { steps: {}, stepsCount: 0 };
  }
}

export interface CreateRunFlowHandlerOptions {
  executor: FlowExecutor;
  /** Override for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the JobHandler for the worker dispatcher. Register at:
 *   `new Worker({ handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) } })`.
 *
 * Lifecycle on each invocation:
 *   - Read the flow_run referenced by the job; abort if missing.
 *   - Read the flow_version referenced by the run; abort if missing.
 *   - Mark RUNNING and clear stale failed_step from prior attempts.
 *   - Run the executor.
 *   - On success: mark SUCCEEDED with steps + finish_time.
 *   - On FlowExecutionError: mark FAILED with the named failedStep, then
 *     rethrow so the queue can decide on retry. Steps captured before the
 *     failure are persisted.
 *   - On any other Error: mark FAILED with a generic failed_step and rethrow.
 *
 * The queue's max_attempts policy controls retry. Retries re-enter this
 * handler on a fresh attempt; the run row is reused (status flipped back to
 * RUNNING). When the job ultimately succeeds or exhausts retries, the run
 * row's terminal state reflects the last attempt only.
 */
export function createRunFlowHandler(opts: CreateRunFlowHandlerOptions): JobHandler {
  const now = opts.now ?? Date.now;
  return async (job: Job): Promise<void> => {
    const typed = job as unknown as Job<RunFlowJobPayload>;
    const { runId } = typed.payload;
    if (!runId) {
      throw new Error(`RUN_FLOW job ${job.id} missing runId in payload`);
    }
    const run = getFlowRun(runId);
    if (!run) {
      // Stale job referencing a deleted run: do not retry; let the queue mark
      // succeeded and move on. This is rare (only happens if a flow was
      // deleted between enqueue and claim) and self-correcting.
      return;
    }
    const version = getFlowVersion(run.flowVersionId);
    if (!version) {
      const ts = now();
      updateRun(runId, {
        status: "INTERNAL_ERROR",
        failedStep: { name: "<engine>", displayName: "engine" },
        finishTime: ts,
      });
      throw new Error(`RUN_FLOW: flow_version ${run.flowVersionId} not found for run ${runId}`);
    }

    const startTime = run.startTime ?? now();
    updateRun(runId, {
      status: "RUNNING",
      startTime,
      // Clear any failed_step from a previous attempt of this same run.
      failedStep: null,
    });

    try {
      const result = await opts.executor.execute({
        run,
        version,
        job: typed,
        payload: typed.payload.payload ?? {},
      });
      updateRun(runId, {
        status: "SUCCEEDED",
        steps: result.steps,
        stepsCount: result.stepsCount,
        finishTime: now(),
      });
      // Auto-capture: write each step's output into the version's
      // sampleData map for cells that are currently empty. Lets the
      // variable picker in the editor surface real field names after a
      // single successful run, without forcing the user to copy/paste
      // step outputs into the sample-data textarea by hand. User-pinned
      // fixtures and LOCKED versions are left untouched -- see
      // `mergeRunOutputsIntoSampleData` for the full skip list.
      try {
        mergeRunOutputsIntoSampleData(run.flowVersionId, result.steps);
      } catch (mergeErr) {
        // Non-fatal: the run already SUCCEEDED. Log and move on.
        console.warn(
          `[run-flow ${runId}] sampleData auto-capture failed: ${(mergeErr as Error).message}`,
        );
      }
    } catch (e) {
      const ts = now();
      if (e instanceof FlowExecutionError) {
        updateRun(runId, {
          status: "FAILED",
          steps: e.steps,
          stepsCount: Object.keys(e.steps).length,
          failedStep: e.failedStep,
          finishTime: ts,
        });
      } else {
        updateRun(runId, {
          status: "FAILED",
          failedStep: { name: "<engine>", displayName: "engine" },
          finishTime: ts,
        });
      }
      throw e;
    }
  };
}
