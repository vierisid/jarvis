/**
 * `app_connection` repository: per-piece credentials (OAuth tokens, API keys,
 * etc.). The raw `value` is stored as JSON for now; encryption-at-rest via
 * Jarvis' keychain will be layered in step 15 by wrapping serialize/deserialize
 * here. The credential adapter (also step 15) will compose this repo with
 * Jarvis' existing OAuth stores so that pieces like Gmail/Telegram see the
 * tokens Jarvis already manages, without users connecting twice.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";
import { decryptJson, encryptJson } from "../encryption";

export type AppConnectionType =
  | "OAUTH2"
  | "PLATFORM_OAUTH2"
  | "CLOUD_OAUTH2"
  | "SECRET_TEXT"
  | "BASIC_AUTH"
  | "CUSTOM_AUTH"
  | "NO_AUTH";

export type AppConnectionScope = "PROJECT" | "PLATFORM";
export type AppConnectionStatus = "ACTIVE" | "MISSING" | "ERROR";

export interface AppConnectionRow {
  id: string;
  external_id: string;
  display_name: string;
  type: AppConnectionType;
  scope: AppConnectionScope;
  status: AppConnectionStatus;
  piece_name: string;
  piece_version: string;
  project_id: string;
  owner_id: string | null;
  value: string;
  metadata: string | null;
  pre_select_for_new_projects: number;
  created: number;
  updated: number;
}

export interface AppConnection {
  id: string;
  externalId: string;
  displayName: string;
  type: AppConnectionType;
  scope: AppConnectionScope;
  status: AppConnectionStatus;
  pieceName: string;
  pieceVersion: string;
  projectId: string;
  ownerId: string | null;
  value: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  preSelectForNewProjects: boolean;
  created: number;
  updated: number;
}

export interface UpsertConnectionInput {
  externalId: string;
  displayName: string;
  type: AppConnectionType;
  pieceName: string;
  pieceVersion: string;
  value: Record<string, unknown>;
  scope?: AppConnectionScope;
  status?: AppConnectionStatus;
  projectId?: string;
  ownerId?: string | null;
  metadata?: Record<string, unknown> | null;
  preSelectForNewProjects?: boolean;
}

function db(): Database {
  return getWorkflowDb();
}

function now(): number {
  return Date.now();
}

function rowToConnection(row: AppConnectionRow): AppConnection {
  return {
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    type: row.type,
    scope: row.scope,
    status: row.status,
    pieceName: row.piece_name,
    pieceVersion: row.piece_version,
    projectId: row.project_id,
    ownerId: row.owner_id,
    value: decryptJson(row.value, `app_connection ${row.id}`) as Record<string, unknown>,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    preSelectForNewProjects: row.pre_select_for_new_projects !== 0,
    created: row.created,
    updated: row.updated,
  };
}

/**
 * Upsert by (project_id, piece_name, external_id). Creates if absent, updates
 * value/displayName/status if present. Returns the resulting connection.
 */
export function upsertConnection(input: UpsertConnectionInput): AppConnection {
  const projectId = input.projectId ?? DEFAULT_IDS.project;
  const existing = getConnectionByExternalId(projectId, input.pieceName, input.externalId);
  const ts = now();
  if (existing) {
    db().run(
      `UPDATE app_connection
       SET display_name = ?, type = ?, status = ?, value = ?, metadata = ?,
           piece_version = ?, owner_id = ?, scope = ?,
           pre_select_for_new_projects = ?, updated = ?
       WHERE id = ?`,
      [
        input.displayName,
        input.type,
        input.status ?? existing.status,
        encryptJson(input.value),
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.pieceVersion,
        input.ownerId !== undefined ? input.ownerId : existing.ownerId,
        input.scope ?? existing.scope,
        input.preSelectForNewProjects !== undefined
          ? input.preSelectForNewProjects
            ? 1
            : 0
          : existing.preSelectForNewProjects
            ? 1
            : 0,
        ts,
        existing.id,
      ],
    );
    const updated = getConnection(existing.id);
    if (!updated) throw new Error(`upsertConnection: row missing after update`);
    return updated;
  }
  const id = apId();
  db().run(
    `INSERT INTO app_connection (
      id, external_id, display_name, type, scope, status, piece_name, piece_version,
      project_id, owner_id, value, metadata, pre_select_for_new_projects, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.externalId,
      input.displayName,
      input.type,
      input.scope ?? "PROJECT",
      input.status ?? "ACTIVE",
      input.pieceName,
      input.pieceVersion,
      projectId,
      input.ownerId ?? null,
      JSON.stringify(input.value),
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.preSelectForNewProjects ? 1 : 0,
      ts,
      ts,
    ],
  );
  const row = getConnection(id);
  if (!row) throw new Error(`upsertConnection: row missing after insert (id=${id})`);
  return row;
}

export function getConnection(id: string): AppConnection | null {
  const row = db()
    .query<AppConnectionRow, [string]>(`SELECT * FROM app_connection WHERE id = ?`)
    .get(id);
  return row ? rowToConnection(row) : null;
}

export function getConnectionByExternalId(
  projectId: string,
  pieceName: string,
  externalId: string,
): AppConnection | null {
  const row = db()
    .query<AppConnectionRow, [string, string, string]>(
      `SELECT * FROM app_connection WHERE project_id = ? AND piece_name = ? AND external_id = ?`,
    )
    .get(projectId, pieceName, externalId);
  return row ? rowToConnection(row) : null;
}

export function listConnections(
  projectId: string = DEFAULT_IDS.project,
  pieceName?: string,
): AppConnection[] {
  if (pieceName !== undefined) {
    return db()
      .query<AppConnectionRow, [string, string]>(
        `SELECT * FROM app_connection WHERE project_id = ? AND piece_name = ? ORDER BY display_name ASC`,
      )
      .all(projectId, pieceName)
      .map(rowToConnection);
  }
  return db()
    .query<AppConnectionRow, [string]>(
      `SELECT * FROM app_connection WHERE project_id = ? ORDER BY piece_name ASC, display_name ASC`,
    )
    .all(projectId)
    .map(rowToConnection);
}

export function deleteConnection(id: string): void {
  db().run(`DELETE FROM app_connection WHERE id = ?`, [id]);
}
