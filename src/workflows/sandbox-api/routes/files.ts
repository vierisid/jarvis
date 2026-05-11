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
 * sandbox can fetch the file with the same engineToken.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { homedir } from "node:os";
import { workflowFileBase } from "../config";
import { json, err, type RouteContext, type RouteHandler } from "./shared";
import {
  createWorkflowFile,
  getWorkflowFile,
} from "../../db/repos/workflow-file";

function safeBasename(name: string): string {
  const b = basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return b || "file";
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
  if (!(file instanceof Blob)) return err("missing file blob", 400);
  const buf = Buffer.from(await file.arrayBuffer());

  const fileRow = createWorkflowFile({
    projectId: ctx.claims.projectId,
    flowId,
    type: "FLOW_STEP_FILE",
    fileName,
    size: buf.byteLength,
    metadata: { stepName },
    data: buf,
  });

  // Write to disk too so that fetch flows can stream from a path rather than
  // buffer-via-DB. The DB blob is the source of truth; the disk copy is a
  // convenience for local-process file URLs.
  const safeName = `${fileRow.id}__${safeBasename(fileName)}`;
  const dir = resolve(workflowFileBase(), flowId, stepName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, safeName), buf);

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
  return new Response(new Blob([new Uint8Array(row.data)]), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.size),
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
