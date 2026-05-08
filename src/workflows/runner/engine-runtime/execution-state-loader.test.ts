/**
 * Coverage for the zstd execution-state loader. The format we have to read
 * matches what the engine writes in `run-progress.ts::backup`:
 *
 *     zstd(JSON.stringify({ executionState: { steps, tags } }))
 *
 * We construct that payload by hand so the test doesn't need a running
 * engine. The "missing file" case is the load-bearing branch for RESUME
 * fallback to `flow_run.steps`, so we assert it explicitly.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { zstdCompress as zstdCompressCallback } from "node:zlib";
import { loadExecutionStateFromLog } from "./execution-state-loader";

const zstdCompress = promisify(zstdCompressCallback);

describe("loadExecutionStateFromLog", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "jarvis-exec-state-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("returns null when the log file is missing", async () => {
    const got = await loadExecutionStateFromLog("nonexistent-run", { baseDir: tempRoot });
    expect(got).toBeNull();
  });

  test("decompresses + parses a well-formed zstd backup", async () => {
    const runId = "run-good";
    const payload = {
      executionState: {
        steps: {
          step_a: { type: "PIECE", status: "SUCCEEDED", input: {}, output: { x: 1 } },
          loop_step: {
            type: "LOOP_ON_ITEMS",
            status: "PAUSED",
            input: {},
            output: {
              iterations: [
                { inner_a: { type: "PIECE", status: "SUCCEEDED", input: {}, output: 1 } },
                { inner_a: { type: "PIECE", status: "PAUSED", input: {}, output: {} } },
              ],
            },
          },
        },
        tags: ["my-tag", "another"],
      },
    };
    const compressed = (await zstdCompress(Buffer.from(JSON.stringify(payload)))) as Buffer;
    writeFileSync(resolve(tempRoot, `${runId}.bin`), compressed);

    const got = await loadExecutionStateFromLog(runId, { baseDir: tempRoot });
    expect(got).not.toBeNull();
    expect(got!.tags).toEqual(["my-tag", "another"]);
    // Recursive iteration state must round-trip -- this is the whole point.
    const loop = got!.steps["loop_step"] as {
      output: { iterations: Array<Record<string, { status: string }>> };
    };
    expect(loop.output.iterations).toHaveLength(2);
    expect(loop.output.iterations[1]!.inner_a!.status).toBe("PAUSED");
  });

  test("tolerates a partial payload that's missing tags (defaults to [])", async () => {
    const runId = "run-partial";
    const compressed = (await zstdCompress(
      Buffer.from(JSON.stringify({ executionState: { steps: { a: { v: 1 } } } })),
    )) as Buffer;
    writeFileSync(resolve(tempRoot, `${runId}.bin`), compressed);
    const got = await loadExecutionStateFromLog(runId, { baseDir: tempRoot });
    expect(got).toEqual({ steps: { a: { v: 1 } }, tags: [] });
  });

  test("throws when the parsed payload is missing the executionState key", async () => {
    // A backup that decompresses + parses but doesn't carry the expected
    // outer key is malformed; silently substituting `{ steps: {} }` would
    // have the executor re-run completed LOOP iterations on RESUME.
    const runId = "run-no-exec";
    const compressed = (await zstdCompress(Buffer.from(JSON.stringify({ wrong: "shape" })))) as Buffer;
    writeFileSync(resolve(tempRoot, `${runId}.bin`), compressed);
    await expect(
      loadExecutionStateFromLog(runId, { baseDir: tempRoot }),
    ).rejects.toThrow(/missing or invalid 'executionState'/);
  });

  test("rejects path-traversal-shaped runIds before touching the filesystem", async () => {
    await expect(
      loadExecutionStateFromLog("../../etc/passwd", { baseDir: tempRoot }),
    ).rejects.toThrow(/invalid runId/);
  });

  test("throws when the file exists but is not valid zstd", async () => {
    const runId = "run-corrupt";
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(resolve(tempRoot, `${runId}.bin`), Buffer.from("not zstd at all"));
    await expect(
      loadExecutionStateFromLog(runId, { baseDir: tempRoot }),
    ).rejects.toThrow(/zstd decompress failed/);
  });

  test("throws when the decompressed blob is not JSON", async () => {
    const runId = "run-non-json";
    const compressed = (await zstdCompress(Buffer.from("definitely not json {"))) as Buffer;
    writeFileSync(resolve(tempRoot, `${runId}.bin`), compressed);
    await expect(
      loadExecutionStateFromLog(runId, { baseDir: tempRoot }),
    ).rejects.toThrow(/JSON parse failed/);
  });
});
