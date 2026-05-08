/**
 * Default WorkerContract + WorkerNotifyContract handlers. These persist
 * progress to the workflow DB and accumulate per-run stdout/stderr buffers.
 *
 * The handlers receive a `sandboxId` so they can resolve the active flow_run
 * via the registry. If the sandbox has been terminated mid-call (e.g., we
 * killed the engine on timeout), the handlers no-op rather than throwing so
 * the engine doesn't see spurious RPC errors during shutdown.
 */

import type { SandboxRegistry } from "./sandbox-registry";
import type {
  NotifyContractHandlers,
  WorkerContractHandlers,
} from "./worker-rpc";
import type {
  SendFlowResponseRequest,
  UpdateRunProgressRequest,
  UpdateStepProgressRequest,
  UploadRunLogsRequest,
} from "./contracts";
import { getFlowRun, updateRun } from "../db/repos/flow-run";

const PER_RUN_LOG_BUFFER_MAX = 200;

export interface WorkerHandlersOptions {
  registry: SandboxRegistry;
  /** Optional callback invoked when a flow's webhook response is ready. */
  onFlowResponse?: (sandboxId: string, req: SendFlowResponseRequest) => void;
  /** Optional structured-log sink for stdout/stderr -- defaults to no-op. */
  onLogLine?: (entry: LogLine) => void;
}

export interface LogLine {
  sandboxId: string;
  runId: string;
  stream: "stdout" | "stderr";
  message: string;
  ts: number;
}

export class DefaultWorkerHandlers
  implements WorkerContractHandlers, NotifyContractHandlers
{
  /** Per-sandbox ring buffer of recent stdout/stderr lines. */
  readonly logBuffer: Map<string, LogLine[]> = new Map();
  /** Last-seen UpdateRunProgressRequest per sandbox -- handy for tests/debug. */
  readonly lastProgress: Map<string, UpdateRunProgressRequest> = new Map();

  constructor(private opts: WorkerHandlersOptions) {}

  /**
   * Replace the optional `onFlowResponse` callback. Used at startup wiring
   * when the daemon needs to attach a webhook responder after the SandboxApi
   * is already constructed.
   */
  setOnFlowResponse(cb: NonNullable<WorkerHandlersOptions["onFlowResponse"]>): void {
    this.opts = { ...this.opts, onFlowResponse: cb };
  }

  /** Replace the optional `onLogLine` sink. Same rationale as setOnFlowResponse. */
  setOnLogLine(cb: NonNullable<WorkerHandlersOptions["onLogLine"]>): void {
    this.opts = { ...this.opts, onLogLine: cb };
  }

  private requireRunId(sandboxId: string): string | null {
    const record = this.opts.registry.get(sandboxId);
    return record?.runId ?? null;
  }

  async updateRunProgress(sandboxId: string, input: UpdateRunProgressRequest): Promise<void> {
    if (!this.requireRunId(sandboxId)) return;
    this.lastProgress.set(sandboxId, input);
    // Persist in-flight status. In TESTING mode the engine also streams per-
    // step output via `input.step` -- accumulate it onto the run's `steps`
    // record so callers reading `flow_run.steps[stepName].output` see the
    // value the action returned. PRODUCTION runs don't include `step`, only
    // the final uploadRunLog.
    try {
      const patch: Parameters<typeof updateRun>[1] = { status: input.flowRun.status };
      if (input.step) {
        const existingRow = getFlowRun(input.flowRun.id);
        const existingSteps = (existingRow?.steps ?? {}) as Record<string, unknown>;
        patch.steps = {
          ...existingSteps,
          [input.step.name]: { output: input.step.output },
        };
      }
      updateRun(input.flowRun.id, patch);
    } catch {
      // run row might be gone (sandbox was terminated); swallow.
    }
  }

  async updateStepProgress(_sandboxId: string, _input: UpdateStepProgressRequest): Promise<void> {
    // Mid-action partial output streaming. Today we don't surface partial
    // step output; we rely on uploadRunLog's stepResponse for the final shape.
    // Hook is wired so the engine doesn't see "unknown method" errors.
  }

  async uploadRunLog(sandboxId: string, input: UploadRunLogsRequest): Promise<void> {
    const runId = this.requireRunId(sandboxId);
    if (!runId) return;
    if (input.runId !== runId) return; // mismatch: engine talking about a different run

    const patch: Parameters<typeof updateRun>[1] = { status: input.status };
    if (input.failedStep) patch.failedStep = input.failedStep;
    if (input.stepsCount !== undefined) patch.stepsCount = input.stepsCount;
    if (input.finishTime) patch.finishTime = Date.parse(input.finishTime);
    if (input.startTime) patch.startTime = Date.parse(input.startTime);
    if (input.logsFileId) patch.logsFileId = input.logsFileId;
    try {
      updateRun(input.runId, patch);
    } catch {
      // run row might be gone; swallow.
    }
  }

  async sendFlowResponse(sandboxId: string, input: SendFlowResponseRequest): Promise<void> {
    this.opts.onFlowResponse?.(sandboxId, input);
  }

  stdout(sandboxId: string, input: { message: string }): void {
    this.appendLog(sandboxId, "stdout", input.message);
  }

  stderr(sandboxId: string, input: { message: string }): void {
    this.appendLog(sandboxId, "stderr", input.message);
  }

  private appendLog(sandboxId: string, stream: "stdout" | "stderr", message: string): void {
    const runId = this.requireRunId(sandboxId);
    if (!runId) return;
    const entry: LogLine = { sandboxId, runId, stream, message, ts: Date.now() };
    const buf = this.logBuffer.get(sandboxId) ?? [];
    buf.push(entry);
    if (buf.length > PER_RUN_LOG_BUFFER_MAX) buf.shift();
    this.logBuffer.set(sandboxId, buf);
    this.opts.onLogLine?.(entry);
  }
}
