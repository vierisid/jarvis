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
 *
 * `flowId` and `stepName` arrive as form fields from the sandbox, which runs
 * user and community code holding the engine token. Neither is trusted: the
 * flow must be the one the token's run belongs to (the flow_run row, or the
 * flow a trigger hook's run id names), the step name must be one safe path
 * segment, and the resolved directory must stay under the files base.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve, basename, join, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { workflowFileBase } from "../config";
import { json, err, type RouteContext, type RouteHandler } from "./shared";
import {
  createWorkflowFile,
  getWorkflowFile,
} from "../../db/repos/workflow-file";
import { getFlowRunInProject } from "../../db/repos/flow-run";
import { getFlowInProject } from "../../db/repos/flow";
import { flowIdOfTriggerHookRunId } from "../../runner/triggers/hook-run-id";
import type { EngineTokenClaims } from "../types";

/**
 * One safe path segment. Not the readiness rule for flow step names
 * (workflow-readiness.ts, ^[a-zA-Z_][a-zA-Z0-9_]*$): a trigger hook uploads
 * under the PIECE's trigger name, which readiness never checks, and 114 of
 * 1325 upstream community trigger names are hyphenated (new-spreadsheet,
 * google-sheets-new-or-updated-row). No dot, slash or backslash, so neither
 * "." nor ".." nor a separator can get through.
 */
const STEP_NAME = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/;

/** The flow this token's run belongs to, or null when it serves none. */
function flowOfClaims(claims: EngineTokenClaims): string | null {
  const run = getFlowRunInProject(claims.projectId, claims.runId);
  if (run) return run.flowId;
  const hookFlowId = flowIdOfTriggerHookRunId(claims.runId);
  if (hookFlowId && getFlowInProject(claims.projectId, hookFlowId)) return hookFlowId;
  return null;
}

function isStrictlyWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

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
  if (!STEP_NAME.test(stepName)) return err("invalid stepName", 400);
  const runFlowId = flowOfClaims(ctx.claims);
  if (runFlowId === null) return err("this sandbox's run belongs to no flow", 403);
  if (flowId !== runFlowId) return err("flowId does not match this sandbox's run", 403);
  const base = workflowFileBase();
  const dir = resolve(base, runFlowId, stepName);
  if (!isStrictlyWithin(dir, base)) return err("invalid file location", 400);
  if (!(file instanceof Blob)) return err("missing file blob", 400);
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
  // convenience for local-process file URLs.
  const safeName = `${fileRow.id}__${safeBasename(fileName)}`;
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
