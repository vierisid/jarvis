/**
 * `flow` repository: top-level workflow definitions. A flow's executable shape
 * lives in its `flow_version` rows (see `flow-version.ts`); the `flow` row
 * tracks identity, status, and which version is published.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";

export type FlowStatus = "ENABLED" | "DISABLED";

export interface FlowRow {
  id: string;
  external_id: string;
  project_id: string;
  owner_id: string | null;
  folder_id: string | null;
  status: FlowStatus;
  operation_status: string;
  published_version_id: string | null;
  schema_version: string | null;
  template_id: string | null;
  time_saved_per_run: number | null;
  metadata: string | null;
  created: number;
  updated: number;
}

export interface CreateFlowInput {
  projectId?: string;
  ownerId?: string | null;
  externalId?: string;
  status?: FlowStatus;
  metadata?: Record<string, unknown> | null;
}

export interface ListFlowsOptions {
  status?: FlowStatus;
  limit?: number;
  offset?: number;
}

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

export function createFlow(input: CreateFlowInput = {}): FlowRow {
  const id = apId();
  const externalId = input.externalId ?? id;
  const projectId = input.projectId ?? DEFAULT_IDS.project;
  const status: FlowStatus = input.status ?? "DISABLED";
  const ts = now();
  db().run(
    `INSERT INTO flow (id, external_id, project_id, owner_id, status, operation_status, metadata, created, updated)
     VALUES (?, ?, ?, ?, ?, 'NONE', ?, ?, ?)`,
    [
      id,
      externalId,
      projectId,
      input.ownerId ?? null,
      status,
      input.metadata ? JSON.stringify(input.metadata) : null,
      ts,
      ts,
    ],
  );
  const row = getFlow(id);
  if (!row) throw new Error(`createFlow: row missing immediately after insert (id=${id})`);
  return row;
}

export function getFlow(id: string): FlowRow | null {
  return db()
    .query<FlowRow, [string]>(`SELECT * FROM flow WHERE id = ?`)
    .get(id);
}

export function listFlows(
  projectId: string = DEFAULT_IDS.project,
  opts: ListFlowsOptions = {},
): FlowRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  if (opts.status) {
    return db()
      .query<FlowRow, [string, FlowStatus, number, number]>(
        `SELECT * FROM flow WHERE project_id = ? AND status = ? ORDER BY updated DESC LIMIT ? OFFSET ?`,
      )
      .all(projectId, opts.status, limit, offset);
  }
  return db()
    .query<FlowRow, [string, number, number]>(
      `SELECT * FROM flow WHERE project_id = ? ORDER BY updated DESC LIMIT ? OFFSET ?`,
    )
    .all(projectId, limit, offset);
}

export function updateFlowStatus(id: string, status: FlowStatus): void {
  const res = db().run(
    `UPDATE flow SET status = ?, updated = ? WHERE id = ?`,
    [status, now(), id],
  );
  if (res.changes === 0) throw new Error(`updateFlowStatus: flow not found (id=${id})`);
}

/**
 * Bump a flow row's `updated` timestamp without touching its other columns.
 * Called from `flow-version` mutations so version edits propagate as flow
 * staleness signals -- the workflows list orders by `flow.updated DESC`
 * and the editor's name cache (`useWorkflowsData`) re-fetches displayName
 * only when `flow.updated` advances past the cache entry. Without this,
 * renaming a workflow in the editor leaves the list stale until reload.
 */
export function touchFlow(id: string): void {
  db().run(`UPDATE flow SET updated = ? WHERE id = ?`, [now(), id]);
}

export function setPublishedVersion(id: string, versionId: string | null): void {
  const res = db().run(
    `UPDATE flow SET published_version_id = ?, updated = ? WHERE id = ?`,
    [versionId, now(), id],
  );
  if (res.changes === 0) throw new Error(`setPublishedVersion: flow not found (id=${id})`);
}

export function updateFlowMetadata(id: string, metadata: Record<string, unknown> | null): void {
  const res = db().run(
    `UPDATE flow SET metadata = ?, updated = ? WHERE id = ?`,
    [metadata ? JSON.stringify(metadata) : null, now(), id],
  );
  if (res.changes === 0) throw new Error(`updateFlowMetadata: flow not found (id=${id})`);
}

export function deleteFlow(id: string): void {
  db().run(`DELETE FROM flow WHERE id = ?`, [id]);
}

export function parseFlowMetadata(row: FlowRow): Record<string, unknown> | null {
  if (!row.metadata) return null;
  return JSON.parse(row.metadata) as Record<string, unknown>;
}
