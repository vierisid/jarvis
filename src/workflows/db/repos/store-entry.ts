/**
 * `store_entry` repository. Backs the activepieces engine's `/v1/store-entries`
 * endpoint, which pieces use as a key-value store via `context.store.put/get/delete`.
 *
 * Upstream supports two scopes:
 *   - PROJECT scope: keys live as-is.
 *   - FLOW scope: keys are prefixed with `flow_<flowId>/` by the engine before
 *     the HTTP call. We don't need to know the difference here -- the prefixed
 *     key is what the engine sends and it's what we store.
 *
 * Limits enforced (matching upstream):
 *   - key:   <= 128 chars
 *   - value: <= 500 KB after JSON-stringify
 *
 * Failures throw `StoreLimitError` / `StoreInvalidKeyError` so the route layer
 * can map to the right HTTP status (413 / 400).
 */

import type { Database } from "bun:sqlite";
import { getWorkflowDb, DEFAULT_IDS } from "../index";
import { apId } from "../ids";

export const STORE_KEY_MAX_LENGTH = 128;
export const STORE_VALUE_MAX_BYTES = 500 * 1024;

export class StoreInvalidKeyError extends Error {
  override readonly name = "StoreInvalidKeyError";
}
export class StoreLimitError extends Error {
  override readonly name = "StoreLimitError";
  constructor(message: string, readonly bytes: number) {
    super(message);
  }
}

export interface StoreEntry {
  id: string;
  projectId: string;
  key: string;
  /** Always the parsed JSON value -- the column stores a JSON string. */
  value: unknown;
  created: number;
  updated: number;
}

interface StoreEntryRow {
  id: string;
  project_id: string;
  key: string;
  value: string;
  created: number;
  updated: number;
}

function db(): Database {
  return getWorkflowDb();
}

function rowToEntry(row: StoreEntryRow): StoreEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: JSON.parse(row.value),
    created: row.created,
    updated: row.updated,
  };
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new StoreInvalidKeyError("store key must be a non-empty string");
  }
  if (key.length > STORE_KEY_MAX_LENGTH) {
    throw new StoreInvalidKeyError(
      `store key length ${key.length} exceeds ${STORE_KEY_MAX_LENGTH}`,
    );
  }
}

function validateValue(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > STORE_VALUE_MAX_BYTES) {
    throw new StoreLimitError(
      `store value of ${bytes} bytes exceeds limit of ${STORE_VALUE_MAX_BYTES}`,
      bytes,
    );
  }
}

export function getStoreEntry(projectId: string, key: string): StoreEntry | null {
  validateKey(key);
  const row = db()
    .prepare<StoreEntryRow, [string, string]>(
      `SELECT * FROM store_entry WHERE project_id = ? AND key = ?`,
    )
    .get(projectId, key);
  return row ? rowToEntry(row) : null;
}

export function putStoreEntry(
  projectId: string,
  key: string,
  value: unknown,
): StoreEntry {
  validateKey(key);
  const serialized = JSON.stringify(value);
  validateValue(serialized);
  const now = Date.now();
  const conn = db();
  const existing = conn
    .prepare<StoreEntryRow, [string, string]>(
      `SELECT * FROM store_entry WHERE project_id = ? AND key = ?`,
    )
    .get(projectId, key);
  if (existing) {
    conn
      .prepare(
        `UPDATE store_entry SET value = ?, updated = ? WHERE project_id = ? AND key = ?`,
      )
      .run(serialized, now, projectId, key);
    return {
      id: existing.id,
      projectId,
      key,
      value,
      created: existing.created,
      updated: now,
    };
  }
  const id = apId();
  conn
    .prepare(
      `INSERT INTO store_entry (id, project_id, key, value, created, updated)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, key, serialized, now, now);
  return { id, projectId, key, value, created: now, updated: now };
}

/** Returns true if a row was deleted, false if no row matched. */
export function deleteStoreEntry(projectId: string, key: string): boolean {
  validateKey(key);
  const result = db()
    .prepare(`DELETE FROM store_entry WHERE project_id = ? AND key = ?`)
    .run(projectId, key);
  return result.changes > 0;
}

/** Test helper: drops every entry. */
export function _clearStoreForTests(): void {
  db().exec(`DELETE FROM store_entry`);
}

export const _DEFAULT_PROJECT_ID = DEFAULT_IDS.project;
