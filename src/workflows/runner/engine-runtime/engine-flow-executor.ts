/**
 * `EngineFlowExecutor` -- the production `FlowExecutor` implementation.
 *
 * Each RUN_FLOW job spawns a fresh engine subprocess, sends EXECUTE_FLOW,
 * and awaits the engine's terminal status. The engine writes the
 * flow_run row directly via `WorkerContract.uploadRunLog` -- a separate
 * socket.io message from the engine -> daemon. Because that upload is
 * not synchronized with `executeOperation`'s reply, this executor polls
 * the run row briefly after `executeFlow` resolves to let the upload
 * settle into a terminal state before reading.
 *
 * `executeTrigger` from the job payload is forwarded to the engine so
 * cron-fired engine-managed triggers run the trigger's `run()` to derive
 * the actual payload(s).
 */

import type {
  FlowExecutor,
  FlowExecutorContext,
  FlowExecutorResult,
} from "../handler";
import { FlowExecutionError } from "../handler";
import { getFlowRun, type FlowRunStatus } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import type { EngineRuntime } from "./engine-runtime";
import { loadExecutionStateFromLog } from "./execution-state-loader";

/**
 * Statuses where the engine is finished writing the run row and we can
 * read its terminal output. Includes every non-{QUEUED,RUNNING} state from
 * `FlowRunStatus`. PAUSED is terminal-from-this-attempt's-perspective: the
 * pause has been recorded; the resume comes through a separate RUN_FLOW.
 */
const TERMINAL_STATUSES = new Set<FlowRunStatus>([
  "SUCCEEDED",
  "FAILED",
  "INTERNAL_ERROR",
  "TIMEOUT",
  "QUOTA_EXCEEDED",
  "STOPPED",
  "MEMORY_LIMIT_EXCEEDED",
  "SCHEDULE_FAILURE",
  "PAUSED",
]);

const NON_SUCCESS_STATUSES = new Set<FlowRunStatus>([
  "FAILED",
  "INTERNAL_ERROR",
  "TIMEOUT",
  "QUOTA_EXCEEDED",
  "STOPPED",
  "MEMORY_LIMIT_EXCEEDED",
  "SCHEDULE_FAILURE",
]);

const DEFAULT_TERMINAL_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_POLL_INTERVAL_MS = 25;

export interface EngineFlowExecutorOptions {
  /**
   * How long to wait (ms) for the engine's `uploadRunLog` to land a terminal
   * status after `executeFlow` resolves. The engine's reply and the upload
   * are independent socket.io messages with no ordering guarantee. Default 5s.
   */
  terminalTimeoutMs?: number;
  /** Polling interval (ms) for the terminal-status wait. Default 25ms. */
  terminalPollIntervalMs?: number;
  /**
   * Override the directory the RESUME path reads zstd-compressed
   * execution-state backups from. Defaults to `workflowLogsBase()`
   * (`~/.jarvis/workflow-logs/`). Tests pass a per-test temp dir to avoid
   * mutating `process.env.JARVIS_WORKFLOW_DATA_DIR`.
   */
  loaderBaseDir?: string;
}

export class EngineFlowExecutor implements FlowExecutor {
  private readonly terminalTimeoutMs: number;
  private readonly terminalPollIntervalMs: number;
  private readonly loaderBaseDir: string | undefined;

  constructor(
    private readonly runtime: EngineRuntime,
    opts: EngineFlowExecutorOptions = {},
  ) {
    this.terminalTimeoutMs = opts.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
    this.terminalPollIntervalMs =
      opts.terminalPollIntervalMs ?? DEFAULT_TERMINAL_POLL_INTERVAL_MS;
    this.loaderBaseDir = opts.loaderBaseDir;
  }

  async execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    const handle = await this.runtime.acquire({
      runId: ctx.run.id,
      projectId: ctx.run.projectId ?? DEFAULT_IDS.project,
    });
    try {
      // streamStepProgress: WEBSOCKET makes the engine emit per-step
      // `updateRunProgress({ step })` calls to the daemon -- the
      // worker-handler accumulates each step's output onto `flow_run.steps`
      // so the dashboard run-history panel can see per-step results.
      // Cost: one socket.io message + one DB update per step. For
      // `TESTING` runs (manual `/run`, run-from-here previews) that's a
      // good trade. For `PRODUCTION` runs (cron/webhook/event-fired,
      // potentially every 10s for sub-minute polling triggers) we default
      // to `NONE` -- only the final `uploadRunLog` writes the run state,
      // which is enough for the dashboard summary view.
      const env: "PRODUCTION" | "TESTING" =
        ctx.run.environment === "TESTING" ? "TESTING" : "PRODUCTION";
      const flowOpts: Parameters<typeof handle.executeFlow>[0] = {
        flowVersion: ctx.version,
        runEnvironment: env,
        streamStepProgress: env === "TESTING" ? "WEBSOCKET" : "NONE",
      };
      const executionType = ctx.job.payload.executionType ?? "BEGIN";
      if (executionType === "RESUME") {
        // Resume a paused run: engine picks up at the waitpointed step,
        // delivers `resumePayload` to it, and resumes walking the chain.
        //
        // Prefer the engine's zstd-compressed execution-state backup when
        // available -- it carries the full recursive `steps` tree + `tags`,
        // including LOOP iterations and ROUTER branch indices, which are
        // not preserved by the per-step DB accumulator. Fall back to the
        // unwrapped `flow_run.steps` only when the backup is missing
        // (e.g., the run paused before the engine's first 15s flush).
        flowOpts.executionType = "RESUME";
        flowOpts.resumePayload = ctx.job.payload.resumePayload ?? {};
        flowOpts.executionState = await this.restoreExecutionState(ctx.run.id, ctx.run.steps);
      } else {
        flowOpts.triggerPayload = ctx.payload;
        flowOpts.executeTrigger = ctx.job.payload.executeTrigger ?? false;
        // Per-step preview: when stepNameToTest is set, engine runs only that
        // step + records its output. The run still terminates SUCCEEDED on
        // success; the dashboard reads `flow_run.steps[stepNameToTest]` for
        // the result.
        if (ctx.job.payload.stepNameToTest) {
          flowOpts.stepNameToTest = ctx.job.payload.stepNameToTest;
          // sampleData is meaningful only when stepNameToTest is set --
          // production runs walk the real chain and ignore it. Forward
          // when the route supplied one (the version's persisted map).
          if (ctx.job.payload.sampleData) {
            flowOpts.sampleData = ctx.job.payload.sampleData;
          }
        }
      }
      await handle.executeFlow(flowOpts);
    } finally {
      await handle.release();
    }

    // Wait for the engine's `uploadRunLog` to settle. `executeOperation` and
    // `uploadRunLog` are independent socket.io messages; the run row may
    // still be RUNNING / QUEUED for a brief window after `executeFlow`
    // resolves. Poll briefly for a terminal status.
    const persisted = await this.waitForTerminalStatus(ctx.run.id);

    const stepsRecord = (persisted.steps ?? {}) as Record<string, unknown>;
    const stepsCount =
      typeof persisted.stepsCount === "number"
        ? persisted.stepsCount
        : Object.keys(stepsRecord).length;

    if (NON_SUCCESS_STATUSES.has(persisted.status)) {
      const failed = persisted.failedStep ?? { name: "unknown", displayName: "unknown" };
      const errorDetail = (failed as { errorMessage?: unknown }).errorMessage;
      const detailSuffix =
        typeof errorDetail === "string" && errorDetail.length > 0
          ? `: ${errorDetail}`
          : "";
      throw new FlowExecutionError(
        `engine executor: run ${ctx.run.id} ended ${persisted.status} at step "${failed.name}"${detailSuffix}`,
        { name: failed.name, displayName: failed.displayName },
        stepsRecord,
      );
    }

    return { steps: stepsRecord, stepsCount };
  }

  /**
   * Build the `executionState` to send on RESUME. Reads the engine's zstd
   * log backup first (recursive steps + tags); falls back to the unwrapped
   * `flow_run.steps` when no backup exists (early pauses) or when the run
   * has no recorded steps yet (defensive).
   *
   * Errors from the loader (corrupt zstd / unreadable JSON) propagate --
   * silently falling through to the partial DB-derived state would let a
   * RESUME walk the LOOP/ROUTER from scratch, re-running already-completed
   * iterations, which is worse than failing the resume loudly.
   */
  private async restoreExecutionState(
    runId: string,
    persistedSteps: Record<string, unknown> | null | undefined,
  ): Promise<{ steps: Record<string, unknown>; tags: string[] }> {
    const loaderOpts = this.loaderBaseDir ? { baseDir: this.loaderBaseDir } : {};
    const restored = await loadExecutionStateFromLog(runId, loaderOpts);
    if (restored) return restored;
    return { steps: unwrapStepEnvelopes(persistedSteps), tags: [] };
  }

  private async waitForTerminalStatus(
    runId: string,
  ): Promise<NonNullable<ReturnType<typeof getFlowRun>>> {
    const deadline = Date.now() + this.terminalTimeoutMs;
    let lastSeenStatus: FlowRunStatus | null = null;
    while (Date.now() < deadline) {
      const persisted = getFlowRun(runId);
      if (!persisted) {
        throw new Error(`flow_run ${runId} disappeared after engine executeFlow`);
      }
      if (TERMINAL_STATUSES.has(persisted.status)) return persisted;
      lastSeenStatus = persisted.status;
      await new Promise((r) => setTimeout(r, this.terminalPollIntervalMs));
    }
    // Timed out waiting for the upload. Treat the run as INTERNAL_ERROR so
    // the worker doesn't optimistically mark it SUCCEEDED. Surface what we
    // last saw to aid debugging.
    throw new FlowExecutionError(
      `engine executor: run ${runId} did not reach terminal status within ${this.terminalTimeoutMs}ms (last seen: ${lastSeenStatus ?? "n/a"})`,
      { name: "engine", displayName: "engine" },
      {},
    );
  }
}

/**
 * Strip the `{ output: <StepOutput> }` wrapper that the worker-handler adds
 * when accumulating step output (per K2 + Phase L), so the resulting shape
 * matches upstream's `executionState.steps` (`Record<stepName, StepOutput>`).
 * Tolerates already-unwrapped entries (defensive: schema changes / manual
 * DB edits) by returning them as-is.
 */
function unwrapStepEnvelopes(
  steps: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!steps) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(steps)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "output" in (value as Record<string, unknown>) &&
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      // Wrapped: pull the inner StepOutput.
      out[name] = (value as { output: unknown }).output;
    } else {
      // Already a StepOutput (has `type` field) or some other shape.
      out[name] = value;
    }
  }
  return out;
}
