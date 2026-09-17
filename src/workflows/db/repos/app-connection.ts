/**
 * `app_connection` repository: per-piece credentials (OAuth tokens, API keys,
 * etc.). Inserts and updates share the encrypting serializer, which binds the
 * ciphertext to the row's identity tuple so a stored value cannot be moved to
 * another row. Reads accept row-bound values, unbound `enc1:` values and
 * legacy JSON; reading a legacy row does not rewrite it. The credential
 * adapter also resolves Jarvis-managed OAuth stores.
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";
import { decryptBoundJson, encryptBoundJson, type CredentialRowBinding } from "../encryption";

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

/**
 * The identity a row's ciphertext is sealed against. Read straight off the
 * row, so a writer who moves a blob between rows presents the wrong tuple and
 * GCM refuses it.
 */
function bindingFor(row: Pick<AppConnectionRow, "id" | "project_id" | "piece_name" | "external_id">): CredentialRowBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    pieceName: row.piece_name,
    externalId: row.external_id,
  };
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
    value: decryptBoundJson(row.value, bindingFor(row), `app_connection ${row.id}`) as Record<string, unknown>,
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
  // The row id is part of the sealed identity, so it has to exist before the
  // ciphertext does. An update reuses the existing id; an insert mints one
  // here rather than below.
  const id = existing?.id ?? apId();
  // Resolve encryption before either write. A key failure must never save JSON.
  const storedValue = encryptBoundJson(input.value, {
    id,
    projectId,
    pieceName: input.pieceName,
    externalId: input.externalId,
  });
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
        storedValue,
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
        id,
      ],
    );
    const updated = getConnection(id);
    if (!updated) throw new Error(`upsertConnection: row missing after update`);
    return updated;
  }
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
      storedValue,
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

/** A piece-less engine request must never choose between different connections. */
export class AmbiguousConnectionError extends Error {
  constructor() {
    super("Connection external ID is ambiguous in this project; use a distinct external ID or specify the piece name.");
    this.name = "AmbiguousConnectionError";
  }
}

/** Resolve a project-scoped external ID only when exactly one piece owns it. */
export function getUniqueConnectionByExternalId(projectId: string, externalId: string): AppConnection | null {
  const rows = db().query<AppConnectionRow, [string, string]>(
    "SELECT * FROM app_connection WHERE project_id = ? AND external_id = ? LIMIT 2",
  ).all(projectId, externalId);
  // Check identity before decrypting any candidate, including malformed rows.
  if (rows.length > 1) throw new AmbiguousConnectionError();
  return rows[0] ? rowToConnection(rows[0]) : null;
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
