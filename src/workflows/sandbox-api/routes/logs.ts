/**
 * `PUT /v1/logs/:runId` -- backs the engine's execution-state backup
 * (`run-progress.ts` calls this every ~15s and on flow termination). The body
 * is zstd-compressed binary; we accept whatever encoding the engine declared
 * via `Content-Encoding` and persist verbatim. Decompression happens lazily on
 * read.
 *
 * Path: `~/.jarvis/workflow-logs/<runId>.bin`. Future versions may stream
 * incrementally; today we overwrite each PUT.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { workflowLogsBase } from "../config";
import { json, err, type RouteContext, type RouteHandler } from "./shared";

export const logsUploadRoute: RouteHandler = async (ctx: RouteContext) => {
  const runId = ctx.params.runId;
  if (!runId) return err("missing runId", 400);
  if (runId !== ctx.claims.runId) return err("runId does not match this sandbox", 403);
  const buf = Buffer.from(await ctx.req.arrayBuffer());
  const dir = workflowLogsBase();
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${runId}.bin`), buf);
  return json({ ok: true, bytes: buf.byteLength });
};
