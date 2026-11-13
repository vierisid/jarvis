/**
 * `POST /v1/step-files` -- backs `context.files.write()`.
 *
 * Upstream's engine `file-uploader.ts` POSTs `multipart/form-data` with fields:
 *   stepName, flowId, contentLength, fileName, file (Blob)
 *
 * Or, if `AP_S3_USE_SIGNED_URLS=true`, the metadata POST returns
 * `{ url, uploadUrl }` and the engine PUTs the binary to `uploadUrl`. We don't
 * support signed URLs -- we always accept the file inline and persist to disk.
 *
 * Response shape upstream expects: `StepFileUpsertResponse = { url: string, uploadUrl?: string }`.
 *
 * Storage:
 *   ~/.jarvis/workflow-files/<flowId>/<stepName>/<fileId>__<basename>
 *
 * The `url` in the response is `/v1/step-files/<fileId>`. Files retained
 * indefinitely today; pruning is a follow-up (tie to flow_run retention).
 *
 * `GET /v1/step-files/:id` is hosted here too so that other steps in the same
 * sandbox can fetch the file with the same engineToken. It serves only files
 * of the flow the token's run belongs to.
 *
 * `flowId` and `stepName` arrive as form fields from the sandbox, which runs
 * user and community code holding the engine token. Neither is trusted: the
 * flow must be the one the token's run belongs to (the flow_run row, or the
 * flow a trigger hook's run id names), the step name must be one safe path
 * segment, and the resolved directory must stay under the files base.
 * Checked lexically for the flow and the step directory, then on disk: the
 * real path of the step directory must be exactly <base>/<flowId>/<stepName>,
 * so a symlink planted at either level cannot redirect the write (#1154).
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, basename, join, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { workflowFileBase } from "../config";
import { json, err, type RouteContext, type RouteHandler } from "./shared";
import {
  createWorkflowFile,
  deleteWorkflowFile,
  getWorkflowFile,
} from "../../db/repos/workflow-file";
import { flowOfClaims } from "./run-flow";

/**
 * One safe path segment. Not the readiness rule for flow step names
 * (workflow-readiness.ts, ^[a-zA-Z_][a-zA-Z0-9_]*$): a trigger hook uploads
 * under the PIECE's trigger name, which readiness never checks, and 114 of
 * 1325 upstream community trigger names are hyphenated (new-spreadsheet,
 * google-sheets-new-or-updated-row). No dot, slash or backslash, so neither
 * "." nor ".." nor a separator can get through.
 */
const STEP_NAME = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/;


function isStrictlyWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Longest on-disk file name part. The file id and "__" are added in front, and
 * most file systems stop at 255 bytes per name. */
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;

function safeBasename(name: string): string {
  const b = basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  if (b.length <= MAX_NAME_LENGTH) return b;
  // Cut the middle, not the end, so the file type survives.
  const dot = b.lastIndexOf(".");
  const ext = dot > 0 && b.length - dot <= MAX_EXTENSION_LENGTH ? b.slice(dot) : "";
  return `${b.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
}

export const stepFilesUploadRoute: RouteHandler = async (ctx: RouteContext) => {
  const contentType = ctx.req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return err("expected multipart/form-data body", 400);
  }
  const form = await ctx.req.formData();
  const stepName = String(form.get("stepName") ?? "");
  const flowId = String(form.get("flowId") ?? "");
  const fileName = String(form.get("fileName") ?? form.get("file")?.toString() ?? "file");
  const file = form.get("file");
  if (!stepName) return err("missing stepName", 400);
  if (!flowId) return err("missing flowId", 400);
  if (!STEP_NAME.test(stepName)) return err("invalid stepName", 400);
  const runFlowId = flowOfClaims(ctx.claims);
  if (runFlowId === null) return err("this sandbox's run belongs to no flow", 403);
  if (flowId !== runFlowId) return err("flowId does not match this sandbox's run", 403);
  const base = workflowFileBase();
  const flowDir = resolve(base, runFlowId);
  const dir = resolve(flowDir, stepName);
  if (!isStrictlyWithin(flowDir, base) || !isStrictlyWithin(dir, flowDir)) return err("invalid file location", 400);
  if (!(file instanceof Blob)) return err("missing file blob", 400);
  // One level at a time, so a symlinked flow directory is refused before
  // anything is created through it. A link swapped in between this check
  // and the write is not covered (Node has no per-component O_NOFOLLOW);
  // this refuses one already planted. A dangling link or a file in the way
  // makes mkdir throw, which is the same refusal.
  try {
    mkdirSync(flowDir, { recursive: true });
    const realFlowDir = join(realpathSync(base), runFlowId);
    if (realpathSync(flowDir) !== realFlowDir) return err("invalid file location", 400);
    mkdirSync(dir, { recursive: true });
    if (realpathSync(dir) !== join(realFlowDir, stepName)) return err("invalid file location", 400);
  } catch (error) {
    // A path in the way is the refusal; a disk fault is not the caller's.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST" || code === "ELOOP") return err("invalid file location", 400);
    throw error;
  }
  const buf = Buffer.from(await file.arrayBuffer());

  const fileRow = createWorkflowFile({
    projectId: ctx.claims.projectId,
    flowId: runFlowId,
    type: "FLOW_STEP_FILE",
    fileName,
    size: buf.byteLength,
    metadata: { stepName },
    data: buf,
  });

  // Write to disk too so that fetch flows can stream from a path rather than
  // buffer-via-DB. The DB blob is the source of truth; the disk copy is a
  // convenience for local-process file URLs. If the disk copy cannot be
  // written the row is removed again, so no file is left that the step was
  // told did not save, and the error never carries a path.
  const safeName = `${fileRow.id}__${safeBasename(fileName)}`;
  try {
    // A new name: never follow or replace something already there.
    writeFileSync(resolve(dir, safeName), buf, { flag: "wx" });
  } catch (error) {
    try { deleteWorkflowFile(fileRow.id); } catch { /* nothing more to undo */ }
    console.error("[step-files] could not write file:", (error as NodeJS.ErrnoException).code ?? "unknown");
    return err("The file could not be saved. Nothing was stored.", 500);
  }

  return json({
    url: `/v1/step-files/${fileRow.id}`,
  });
};

export const stepFilesDownloadRoute: RouteHandler = async (ctx: RouteContext) => {
  const id = ctx.params.id;
  if (!id) return err("missing file id", 400);
  const row = getWorkflowFile(id);
  if (!row) return err("file not found", 404);
  if (row.projectId !== ctx.claims.projectId) return err("forbidden", 403);
  // Bound like the upload: a file prop resolves any /v1/step-files/<id> a
  // flow names, so another flow's file id must not be readable (or uploaded,
  // emailed) from this sandbox. No path passes step files between flows.
  const runFlowId = flowOfClaims(ctx.claims);
  if (runFlowId === null || row.flowId !== runFlowId) return err("file belongs to another flow", 403);
  return new Response(new Blob([new Uint8Array(row.data)]), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.size),
      "Content-Disposition": `attachment; filename="${safeBasename(row.fileName ?? "file")}"`,
    },
  });
};

// Surface the local disk dir for tests/inspection.
export function workflowFileDir(flowId: string, stepName: string): string {
  return resolve(workflowFileBase(), flowId, stepName);
}

// Re-export for tests so they can clear the dir.
export const _filesUtil = {
  resolve,
  join,
  homedir,
  existsSync,
  readFileSync,
  statSync,
};
