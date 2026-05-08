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
}

export class EngineFlowExecutor implements FlowExecutor {
  private readonly terminalTimeoutMs: number;
  private readonly terminalPollIntervalMs: number;

  constructor(
    private readonly runtime: EngineRuntime,
    opts: EngineFlowExecutorOptions = {},
  ) {
    this.terminalTimeoutMs = opts.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
    this.terminalPollIntervalMs =
      opts.terminalPollIntervalMs ?? DEFAULT_TERMINAL_POLL_INTERVAL_MS;
  }

  async execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    const handle = await this.runtime.acquire({
      runId: ctx.run.id,
      projectId: ctx.run.projectId ?? DEFAULT_IDS.project,
    });
    try {
      // streamStepProgress: WEBSOCKET makes the engine emit per-step
      // `updateRunProgress({ step })` calls to the daemon. The daemon's
      // worker-handler accumulates each step's output onto `flow_run.steps`
      // so the dashboard run-history panel + downstream consumers can see
      // per-step results. `NONE` (the default in operation-builder) means
      // status-only updates -- adequate for production-only metrics but the
      // run row's `steps` would stay empty.
      await handle.executeFlow({
        flowVersion: ctx.version,
        triggerPayload: ctx.payload,
        executeTrigger: ctx.job.payload.executeTrigger ?? false,
        streamStepProgress: "WEBSOCKET",
      });
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
