/**
 * Wire types for the engine <-> daemon RPC contracts. Mirrors upstream's
 * `@activepieces/shared/lib/automation/engine/{engine-contract,requests}.ts`
 * but as plain TypeScript (no zod imports), since we want these usable from
 * project-side code that excludes the vendored tree from tsc.
 *
 * The shapes here must stay byte-compatible with upstream so the engine
 * subprocess can serialize against its own zod schemas and we deserialize
 * here without round-tripping through them.
 *
 * Where upstream uses union types we use loose `Record<string, unknown>`
 * placeholders for now -- the daemon stores the payloads opaquely and only
 * the engine + pieces care about the inner shape. Step E (FlowVersion adapter)
 * tightens these as we wire in real flow-run state.
 */

export type FlowRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "QUOTA_EXCEEDED"
  | "STOPPED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "SCHEDULE_FAILURE";

export interface FailedStep {
  name: string;
  displayName: string;
  message?: string;
}

/** Per upstream `StepRunResponse` -- the streaming step result envelope. */
export interface StepRunResponse {
  runId: string;
  success: boolean;
  input: unknown;
  output: unknown;
  standardError: string;
  standardOutput: string;
}

/** `UploadRunLogsRequest` -- 15s heartbeat + final state at run end. */
export interface UploadRunLogsRequest {
  runId: string;
  projectId: string;
  status: FlowRunStatus;
  tags?: string[];
  streamStepProgress?: "WEBSOCKET" | "NONE";
  logsFileId?: string;
  stepNameToTest?: string;
  failedStep?: FailedStep;
  startTime?: string;
  finishTime?: string;
  stepResponse?: StepRunResponse;
  stepsCount?: number;
}

/** `UpdateStepProgressRequest` -- mid-action partial output streaming. */
export interface UpdateStepProgressRequest {
  projectId: string;
  stepResponse: StepRunResponse;
}

/** `SendFlowResponseRequest` -- webhook reply pathway. */
export interface SendFlowResponseRequest {
  workerHandlerId: string;
  httpRequestId: string;
  runResponse: {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

/**
 * `UpdateRunProgressRequest` -- per-step progress in test mode. We accept the
 * full FlowRun shape opaquely; the only field we read is `flowRun.id` /
 * `flowRun.status`. The `step` shape is also opaque -- only the dashboard's
 * run-history panel cares about its inner fields.
 */
export interface UpdateRunProgressRequest {
  flowRun: {
    id: string;
    status: FlowRunStatus;
    flowId: string;
    flowVersionId: string;
    projectId: string;
    [key: string]: unknown;
  };
  step?: {
    name: string;
    path: ReadonlyArray<readonly [string, number]>;
    output: Record<string, unknown>;
  };
}

/** Engine -> daemon contract. */
export interface WorkerContract {
  updateRunProgress(input: UpdateRunProgressRequest): Promise<void>;
  uploadRunLog(input: UploadRunLogsRequest): Promise<void>;
  sendFlowResponse(input: SendFlowResponseRequest): Promise<void>;
  updateStepProgress(input: UpdateStepProgressRequest): Promise<void>;
}

/** Engine -> daemon notify channel (fire-and-forget). */
export interface WorkerNotifyContract {
  stdout(input: { message: string }): void;
  stderr(input: { message: string }): void;
}

/** Daemon -> engine. The daemon calls this once per RUN_FLOW and on trigger hooks. */
export type EngineOperationType =
  | "EXECUTE_FLOW"
  | "EXECUTE_TRIGGER_HOOK"
  | "EXECUTE_PROPERTY"
  | "EXECUTE_VALIDATE_AUTH"
  | "EXTRACT_PIECE_METADATA";

export interface EngineResponse<T> {
  status: "OK" | "USER_FAILURE" | "INTERNAL_ERROR" | "TIMEOUT" | "MEMORY_ISSUE" | "LOG_SIZE_EXCEEDED";
  response: T;
}

export interface EngineContract {
  executeOperation(input: {
    operationType: EngineOperationType;
    operation: Record<string, unknown>;
  }): Promise<EngineResponse<unknown>>;
}
