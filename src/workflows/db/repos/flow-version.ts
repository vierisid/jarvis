/**
 * `flow_version` repository. A version is a snapshot of a flow's executable
 * shape: the trigger node and its action subtree, stored as a JSON blob in
 * `trigger`. Versions in `DRAFT` state can be edited; once `LOCKED` they are
 * immutable and become eligible to be set as a flow's `published_version_id`.
 *
 * Lifecycle: createDraftVersion -> updateDraft (n times) -> lockVersion ->
 * (the caller wires it as the flow's published_version_id).
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb } from "../index";
import { apId } from "../ids";

export type FlowVersionState = "DRAFT" | "LOCKED";

export interface FlowVersionRow {
  id: string;
  flow_id: string;
  display_name: string;
  trigger: string;
  state: FlowVersionState;
  valid: number;
  schema_version: string | null;
  updated_by: string | null;
  agent_ids: string;
  connection_ids: string;
  notes: string;
  backup_files: string | null;
  created: number;
  updated: number;
}

export interface FlowVersion {
  id: string;
  flowId: string;
  displayName: string;
  trigger: FlowTriggerNode;
  state: FlowVersionState;
  valid: boolean;
  schemaVersion: string | null;
  updatedBy: string | null;
  agentIds: string[];
  connectionIds: string[];
  notes: unknown[];
  backupFiles: Record<string, string> | null;
  created: number;
  updated: number;
}

/**
 * Structural shape of a trigger node persisted on a flow_version. The
 * `trigger` column stores this as JSON; readers narrow further when they
 * dispatch on `type`. Kept loose intentionally so callers (composer, editor,
 * worker handler) share one nominal type without wrapping every value in
 * `Record<string, unknown>` casts.
 *
 * Includes the executor's control-flow shapes (LOOP_ON_ITEMS subgraph head,
 * ROUTER branch children) so the version repo, composer, editor, and
 * executor all agree on one node type.
 */
export interface FlowTriggerNode {
  name: string;
  type: string;
  displayName?: string;
  settings?: {
    pieceName?: string;
    pieceVersion?: string;
    triggerName?: string;
    actionName?: string;
    input?: Record<string, unknown>;
    /** LOOP_ON_ITEMS: template that resolves to an array. */
    items?: string;
    /** ROUTER: branch definitions; one per index in `children`. */
    branches?: Array<FlowRouterBranch>;
    /** ROUTER: which matched branches to run. */
    executionType?: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
    /** CODE: source bundle stored verbatim; engine materializes to disk. */
    sourceCode?: { packageJson: string; code: string };
    /** CODE / PIECE: per-step propertySettings (mostly empty for our pieces). */
    propertySettings?: Record<string, unknown>;
  };
  nextAction?: FlowTriggerNode;
  /** LOOP_ON_ITEMS: head of the inner subgraph executed once per iteration. */
  firstLoopAction?: FlowTriggerNode;
  /** ROUTER: per-branch subgraph head. May contain null for empty branches. */
  children?: Array<FlowTriggerNode | null>;
}

export type FlowRouterBranch =
  | {
      branchType: "CONDITION";
      branchName: string;
      conditions: ReadonlyArray<ReadonlyArray<{
        firstValue: string;
        operator: string;
        secondValue?: string;
        caseSensitive?: boolean;
      }>>;
    }
  | { branchType: "FALLBACK"; branchName: string };

export interface CreateDraftVersionInput {
  flowId: string;
  displayName: string;
  trigger?: FlowTriggerNode | Record<string, unknown>;
  schemaVersion?: string;
  updatedBy?: string | null;
}

export interface UpdateDraftVersionInput {
  displayName?: string;
  trigger?: FlowTriggerNode | Record<string, unknown>;
  valid?: boolean;
  agentIds?: string[];
  connectionIds?: string[];
  notes?: unknown[];
  backupFiles?: Record<string, string> | null;
  updatedBy?: string | null;
}

const LATEST_SCHEMA_VERSION = "20"; // matches packages/shared/src/lib/automation/flows/flow-version.ts

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

function rowToFlowVersion(row: FlowVersionRow): FlowVersion {
  return {
    id: row.id,
    flowId: row.flow_id,
    displayName: row.display_name,
    trigger: JSON.parse(row.trigger) as FlowTriggerNode,
    state: row.state,
    valid: row.valid !== 0,
    schemaVersion: row.schema_version,
    updatedBy: row.updated_by,
    agentIds: JSON.parse(row.agent_ids) as string[],
    connectionIds: JSON.parse(row.connection_ids) as string[],
    notes: JSON.parse(row.notes) as unknown[],
    backupFiles: row.backup_files
      ? (JSON.parse(row.backup_files) as Record<string, string>)
      : null,
    created: row.created,
    updated: row.updated,
  };
}

export function createDraftVersion(input: CreateDraftVersionInput): FlowVersion {
  const id = apId();
  const ts = now();
  const trigger = input.trigger ?? {};
  db().run(
    `INSERT INTO flow_version (
      id, flow_id, display_name, trigger, state, valid, schema_version, updated_by,
      agent_ids, connection_ids, notes, backup_files, created, updated
    ) VALUES (?, ?, ?, ?, 'DRAFT', 0, ?, ?, '[]', '[]', '[]', NULL, ?, ?)`,
    [
      id,
      input.flowId,
      input.displayName,
      JSON.stringify(trigger),
      input.schemaVersion ?? LATEST_SCHEMA_VERSION,
      input.updatedBy ?? null,
      ts,
      ts,
    ],
  );
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`createDraftVersion: row missing after insert (id=${id})`);
  return rowToFlowVersion(row);
}

function getFlowVersionRow(id: string): FlowVersionRow | null {
  return db()
    .query<FlowVersionRow, [string]>(`SELECT * FROM flow_version WHERE id = ?`)
    .get(id);
}

export function getFlowVersion(id: string): FlowVersion | null {
  const row = getFlowVersionRow(id);
  return row ? rowToFlowVersion(row) : null;
}

export function getLatestDraft(flowId: string): FlowVersion | null {
  const row = db()
    .query<FlowVersionRow, [string]>(
      `SELECT * FROM flow_version WHERE flow_id = ? AND state = 'DRAFT' ORDER BY updated DESC LIMIT 1`,
    )
    .get(flowId);
  return row ? rowToFlowVersion(row) : null;
}

export function listVersions(flowId: string, limit = 50): FlowVersion[] {
  return db()
    .query<FlowVersionRow, [string, number]>(
      `SELECT * FROM flow_version WHERE flow_id = ? ORDER BY updated DESC LIMIT ?`,
    )
    .all(flowId, limit)
    .map(rowToFlowVersion);
}

export function updateDraftVersion(id: string, patch: UpdateDraftVersionInput): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`updateDraftVersion: not found (id=${id})`);
  if (existing.state === "LOCKED") throw new Error(`updateDraftVersion: cannot modify LOCKED version (id=${id})`);

  const next: FlowVersionRow = {
    ...existing,
    display_name: patch.displayName ?? existing.display_name,
    trigger: patch.trigger ? JSON.stringify(patch.trigger) : existing.trigger,
    valid: patch.valid !== undefined ? (patch.valid ? 1 : 0) : existing.valid,
    agent_ids: patch.agentIds ? JSON.stringify(patch.agentIds) : existing.agent_ids,
    connection_ids: patch.connectionIds
      ? JSON.stringify(patch.connectionIds)
      : existing.connection_ids,
    notes: patch.notes ? JSON.stringify(patch.notes) : existing.notes,
    backup_files:
      patch.backupFiles !== undefined
        ? patch.backupFiles
          ? JSON.stringify(patch.backupFiles)
          : null
        : existing.backup_files,
    updated_by: patch.updatedBy !== undefined ? patch.updatedBy : existing.updated_by,
    updated: now(),
  };

  db().run(
    `UPDATE flow_version SET
      display_name = ?, trigger = ?, valid = ?, updated_by = ?,
      agent_ids = ?, connection_ids = ?, notes = ?, backup_files = ?, updated = ?
     WHERE id = ?`,
    [
      next.display_name,
      next.trigger,
      next.valid,
      next.updated_by,
      next.agent_ids,
      next.connection_ids,
      next.notes,
      next.backup_files,
      next.updated,
      id,
    ],
  );
  return rowToFlowVersion(next);
}

export function lockVersion(id: string): FlowVersion {
  const existing = getFlowVersionRow(id);
  if (!existing) throw new Error(`lockVersion: not found (id=${id})`);
  if (existing.state === "LOCKED") return rowToFlowVersion(existing);
  db().run(
    `UPDATE flow_version SET state = 'LOCKED', updated = ? WHERE id = ?`,
    [now(), id],
  );
  const row = getFlowVersionRow(id);
  if (!row) throw new Error(`lockVersion: row missing after update (id=${id})`);
  return rowToFlowVersion(row);
}
