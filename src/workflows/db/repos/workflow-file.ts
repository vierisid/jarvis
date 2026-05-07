/**
 * `workflow_file` repository: file blobs persisted between steps. Backs
 * `POST /v1/step-files` and `GET /v1/step-files/:id`.
 *
 * `data` is stored as a BLOB (canonical source of truth); the route layer also
 * keeps a disk-side mirror under `~/.jarvis/workflow-files/...` for inspection.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";

export interface WorkflowFile {
  id: string;
  projectId: string;
  flowId: string | null;
  type: string;
  fileName: string | null;
  size: number;
  metadata: Record<string, unknown> | null;
  data: Buffer;
  created: number;
}

export interface CreateWorkflowFileInput {
  projectId: string;
  flowId?: string | null;
  type: string;
  fileName?: string | null;
  size: number;
  metadata?: Record<string, unknown> | null;
  data: Buffer;
}

interface WorkflowFileRow {
  id: string;
  project_id: string;
  flow_id: string | null;
  type: string;
  file_name: string | null;
  data: Buffer;
  size: number;
  metadata: string | null;
  created: number;
}

function db(): Database {
  return getWorkflowDb();
}

export function createWorkflowFile(input: CreateWorkflowFileInput): WorkflowFile {
  const id = apId();
  const created = Date.now();
  db()
    .prepare(
      `INSERT INTO workflow_file (id, project_id, flow_id, type, file_name, data, size, metadata, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.flowId ?? null,
      input.type,
      input.fileName ?? null,
      input.data,
      input.size,
      input.metadata ? JSON.stringify(input.metadata) : null,
      created,
    );
  return {
    id,
    projectId: input.projectId,
    flowId: input.flowId ?? null,
    type: input.type,
    fileName: input.fileName ?? null,
    size: input.size,
    metadata: input.metadata ?? null,
    data: input.data,
    created,
  };
}

export function getWorkflowFile(id: string): WorkflowFile | null {
  const row = db()
    .prepare<WorkflowFileRow, [string]>(`SELECT * FROM workflow_file WHERE id = ?`)
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    flowId: row.flow_id,
    type: row.type,
    fileName: row.file_name,
    size: row.size,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    data: row.data,
    created: row.created,
  };
}

export function _clearWorkflowFilesForTests(): void {
  db().exec(`DELETE FROM workflow_file`);
}
