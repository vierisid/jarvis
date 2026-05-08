/**
 * Helpers that shape the inbound operations the engine's
 * `EngineContract.executeOperation` expects (per upstream
 * `engine/src/lib/operations/index.ts`).
 *
 * Each helper returns `{ operationType, operation }` -- the exact tuple the
 * engineClient consumes. Callers can then `await engineClient.executeOperation(...)`.
 *
 * We keep these helpers separate from the EngineRuntime/EngineHandle classes
 * so call sites can compose operations without dragging in the lifecycle
 * machinery (handy in tests).
 */

import type { UpstreamFlowVersion } from "./flow-version-adapter";

export type EngineOperationType =
  | "EXECUTE_FLOW"
  | "EXECUTE_TRIGGER_HOOK"
  | "EXECUTE_PROPERTY"
  | "EXECUTE_VALIDATE_AUTH"
  | "EXTRACT_PIECE_METADATA";

export interface EngineOperationEnvelope {
  operationType: EngineOperationType;
  operation: Record<string, unknown>;
}

export interface ExecuteFlowOptions {
  flowVersion: UpstreamFlowVersion;
  flowRunId: string;
  projectId: string;
  platformId: string;
  engineToken: string;
  /** URL prefix the engine uses for HTTP calls (`internalApiUrl`). Trailing slash matters. */
  internalApiUrl: string;
  publicApiUrl?: string;
  triggerPayload?: unknown;
  /** When true, the engine first invokes the trigger's `run` hook to derive payload. */
  executeTrigger?: boolean;
  runEnvironment?: "PRODUCTION" | "TESTING";
  streamStepProgress?: "WEBSOCKET" | "NONE";
  timeoutInSeconds?: number;
  pausedFlowTimeoutDays?: number;
  logsUploadUrl?: string;
  logsFileId?: string;
  sampleData?: Record<string, unknown>;
  /** When set, the engine runs only this step and reports its output. */
  stepNameToTest?: string | null;
  workerHandlerId?: string | null;
  httpRequestId?: string | null;
  /**
   * `BEGIN` (default) starts a new run from the trigger. `RESUME` wakes a
   * paused run from a stored execution state -- supply `resumePayload`
   * (and the prior `executionState`) so the engine knows where to pick up.
   */
  executionType?: "BEGIN" | "RESUME";
  /**
   * Payload delivered to the paused step when `executionType === "RESUME"`.
   * Typically the body of the webhook that hit the resume URL.
   */
  resumePayload?: Record<string, unknown>;
  /**
   * Prior execution state restored on RESUME. The daemon reads this from
   * the run's logs file (the engine's zstd-encoded backup) before
   * re-issuing EXECUTE_FLOW. For a fresh BEGIN it stays empty.
   *
   * `tags` round-trip the engine's `flowExecutorContext.tags` set; missing
   * here means RESUME starts with an empty tag set (still correct for flows
   * that don't use tags, which is most flows today).
   */
  executionState?: { steps: Record<string, unknown>; tags?: string[] };
}

const DEFAULT_TIMEOUT_S = 600;

export function buildExecuteFlowOperation(opts: ExecuteFlowOptions): EngineOperationEnvelope {
  const executionType = opts.executionType ?? "BEGIN";
  const op: Record<string, unknown> = {
    flowVersion: opts.flowVersion,
    flowRunId: opts.flowRunId,
    projectId: opts.projectId,
    platformId: opts.platformId,
    engineToken: opts.engineToken,
    internalApiUrl: ensureTrailingSlash(opts.internalApiUrl),
    publicApiUrl: ensureApiSuffix(opts.publicApiUrl ?? opts.internalApiUrl),
    timeoutInSeconds: opts.timeoutInSeconds ?? DEFAULT_TIMEOUT_S,
    runEnvironment: opts.runEnvironment ?? "TESTING",
    streamStepProgress: opts.streamStepProgress ?? "NONE",
    executionType,
    executionState: normalizeExecutionState(opts.executionState),
    stepNameToTest: opts.stepNameToTest ?? null,
    workerHandlerId: opts.workerHandlerId ?? null,
    httpRequestId: opts.httpRequestId ?? null,
    logsUploadUrl: opts.logsUploadUrl,
    logsFileId: opts.logsFileId,
    sampleData: opts.sampleData ?? {},
  };
  if (executionType === "RESUME") {
    op.resumePayload = opts.resumePayload ?? {};
  } else {
    op.triggerPayload = opts.triggerPayload ?? {};
    op.executeTrigger = opts.executeTrigger ?? false;
  }
  return { operationType: "EXECUTE_FLOW", operation: op };
}

/**
 * Coerce an inbound `executionState` to the shape upstream expects. Engine
 * reads `executionState.steps` and `executionState.tags`; both must be
 * present on the wire (tags as an array, steps as an object). When the daemon
 * supplies neither (BEGIN), we send empty defaults.
 */
function normalizeExecutionState(
  input: ExecuteFlowOptions["executionState"],
): { steps: Record<string, unknown>; tags: string[] } {
  if (!input) return { steps: {}, tags: [] };
  return { steps: input.steps ?? {}, tags: input.tags ?? [] };
}

export interface ExtractPieceMetadataOptions {
  pieceName: string;
  pieceVersion: string;
  projectId?: string;
  platformId: string;
  engineToken: string;
  internalApiUrl: string;
  publicApiUrl?: string;
  timeoutInSeconds?: number;
}

export function buildExtractPieceMetadataOperation(
  opts: ExtractPieceMetadataOptions,
): EngineOperationEnvelope {
  return {
    operationType: "EXTRACT_PIECE_METADATA",
    operation: {
      pieceName: opts.pieceName,
      pieceVersion: opts.pieceVersion,
      projectId: opts.projectId,
      platformId: opts.platformId,
      engineToken: opts.engineToken,
      internalApiUrl: ensureTrailingSlash(opts.internalApiUrl),
      publicApiUrl: ensureApiSuffix(opts.publicApiUrl ?? opts.internalApiUrl),
      timeoutInSeconds: opts.timeoutInSeconds ?? DEFAULT_TIMEOUT_S,
    },
  };
}

export type TriggerHookType =
  | "ON_ENABLE"
  | "ON_DISABLE"
  | "RUN"
  | "TEST"
  | "HANDSHAKE"
  | "RENEW";

export interface ExecuteTriggerHookOptions {
  hookType: TriggerHookType;
  flowVersion: UpstreamFlowVersion;
  flowRunId: string;
  projectId: string;
  platformId: string;
  engineToken: string;
  internalApiUrl: string;
  publicApiUrl?: string;
  /**
   * Public-facing webhook URL surfaced to the trigger via context.webhookUrl.
   * Used by webhook-strategy triggers that register external watches against
   * a publicly reachable URL (e.g. Gmail watch). Default: a placeholder so
   * non-webhook triggers (most jarvis triggers) still validate.
   */
  webhookUrl?: string;
  /** Whether to invoke the trigger's `test` path instead of `run`. */
  test?: boolean;
  triggerPayload?: unknown;
  appWebhookUrl?: string;
  webhookSecret?: string | Record<string, string>;
  timeoutInSeconds?: number;
}

export function buildExecuteTriggerHookOperation(
  opts: ExecuteTriggerHookOptions,
): EngineOperationEnvelope {
  const op: Record<string, unknown> = {
    hookType: opts.hookType,
    test: opts.test ?? false,
    flowVersion: opts.flowVersion,
    flowRunId: opts.flowRunId,
    projectId: opts.projectId,
    platformId: opts.platformId,
    engineToken: opts.engineToken,
    internalApiUrl: ensureTrailingSlash(opts.internalApiUrl),
    publicApiUrl: ensureApiSuffix(opts.publicApiUrl ?? opts.internalApiUrl),
    timeoutInSeconds: opts.timeoutInSeconds ?? DEFAULT_TIMEOUT_S,
    webhookUrl: opts.webhookUrl ?? "",
  };
  if (opts.triggerPayload !== undefined) op.triggerPayload = opts.triggerPayload;
  if (opts.appWebhookUrl !== undefined) op.appWebhookUrl = opts.appWebhookUrl;
  if (opts.webhookSecret !== undefined) op.webhookSecret = opts.webhookSecret;
  return { operationType: "EXECUTE_TRIGGER_HOOK", operation: op };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/**
 * The engine validates publicApiUrl with `endsWith('/api/')` (despite the
 * error message claiming "must end with a slash"). Fold that into the URL we
 * send so the engine accepts it.
 */
function ensureApiSuffix(url: string): string {
  const slashed = ensureTrailingSlash(url);
  return slashed.endsWith("/api/") ? slashed : slashed + "api/";
}
