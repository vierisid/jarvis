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
 * Read + decompress + parse `~/.jarvis/workflow-logs/<runId>.bin`. Returns
 * `null` when the file is missing (engine never produced a backup); throws
 * when the file exists but is unreadable / corrupt -- we'd rather surface
 * decompression / parse errors than silently lose iteration state on RESUME.
 */
export async function loadExecutionStateFromLog(
  runId: string,
  opts: LoadExecutionStateOptions = {},
): Promise<RestoredExecutionState | null> {
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
  // Tolerate missing inner keys -- a partial file shouldn't crash RESUME.
  const exec =
    (parsed as { executionState?: { steps?: unknown; tags?: unknown } } | null)
      ?.executionState ?? {};
  const steps =
    exec.steps && typeof exec.steps === "object" && !Array.isArray(exec.steps)
      ? (exec.steps as Record<string, unknown>)
      : {};
  const tags = Array.isArray(exec.tags)
    ? (exec.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return { steps, tags };
}
