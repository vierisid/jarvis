/**
 * Loader for the engine's zstd-compressed execution-state backup. The engine
 * writes this file via `PUT /v1/logs/:runId` (every ~15s and on flow
 * termination); on RESUME the daemon needs to re-supply the full prior state
 * to upstream's flow-executor so iteration counters (LOOP) + branch indices
 * (ROUTER) survive the pause.
 *
 * The on-wire format (per `run-progress.ts` + `log-serializer.ts`):
 *
 *     zstd(JSON.stringify({ executionState: { steps, tags } }))
 *
 * `steps` is upstream's `Record<stepName, StepOutput>`, recursive at LOOP /
 * ROUTER nodes (LoopStepOutput.iterations is `Record<stepName, StepOutput>[]`).
 *
 * Falling back to `flow_run.steps` (what we did before) loses that recursive
 * iteration state because the daemon's per-step accumulator only sees the
 * outer step name. The zstd backup is the canonical source of truth.
 *
 * The backup is best-effort: a flow that paused before the engine's first
 * 15s tick (or one whose backup write was interrupted) won't have a file.
 * The loader returns `null` in that case so the caller can fall back to
 * `flow_run.steps`.
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress as zstdDecompressCallback } from "node:zlib";
import { workflowLogsBase } from "../../sandbox-api/config";

const zstdDecompress = promisify(zstdDecompressCallback);

export interface RestoredExecutionState {
  steps: Record<string, unknown>;
  tags: string[];
}

export interface LoadExecutionStateOptions {
  /** Override the workflow-logs root. Defaults to `workflowLogsBase()`. */
  baseDir?: string;
}

/**
 * Run ids minted by `apId()` are alphanumeric, 21 chars. Defense-in-depth:
 * refuse to read a runId-derived path that doesn't match the expected shape,
 * so a future code path that lets external input reach a runId can't escape
 * the workflow-logs directory via `..` segments.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read + decompress + parse `~/.jarvis/workflow-logs/<runId>.bin`. Returns
 * `null` when the file is missing (engine never produced a backup); throws
 * when the file exists but is unreadable / corrupt -- we'd rather surface
 * decompression / parse errors than silently lose iteration state on RESUME.
 *
 * Tolerance vs. strictness: the inner `tags` array is allowed to be missing
 * (older engine builds; flows that don't use tags) and defaults to `[]`.
 * The outer `executionState` *object* must be present -- a payload that
 * parses to JSON but lacks it indicates a malformed backup, and silently
 * substituting `{ steps: {} }` would have the executor re-run completed
 * LOOP iterations from scratch. Throw instead so the caller's RESUME
 * request fails loudly rather than producing duplicate work.
 */
export async function loadExecutionStateFromLog(
  runId: string,
  opts: LoadExecutionStateOptions = {},
): Promise<RestoredExecutionState | null> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`refusing to load execution-state log for invalid runId ${JSON.stringify(runId)}`);
  }
  const dir = opts.baseDir ?? workflowLogsBase();
  const path = resolve(dir, `${runId}.bin`);
  let compressed: Buffer;
  try {
    compressed = await fs.readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let raw: Buffer;
  try {
    raw = (await zstdDecompress(compressed)) as Buffer;
  } catch (e) {
    throw new Error(
      `execution-state log for run ${runId} is unreadable (zstd decompress failed): ${(e as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Error(
      `execution-state log for run ${runId} is unreadable (JSON parse failed): ${(e as Error).message}`,
    );
  }
  // Upstream's ExecutioOutputFile shape: { executionState: { steps, tags } }.
  const exec = (parsed as { executionState?: unknown } | null)?.executionState;
  if (!exec || typeof exec !== "object" || Array.isArray(exec)) {
    throw new Error(
      `execution-state log for run ${runId} is malformed (missing or invalid 'executionState' object)`,
    );
  }
  const execShape = exec as { steps?: unknown; tags?: unknown };
  const steps =
    execShape.steps && typeof execShape.steps === "object" && !Array.isArray(execShape.steps)
      ? (execShape.steps as Record<string, unknown>)
      : {};
  const tags = Array.isArray(execShape.tags)
    ? (execShape.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return { steps, tags };
}
