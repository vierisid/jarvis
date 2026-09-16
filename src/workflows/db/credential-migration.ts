/** Offline, opt-in conversion of legacy app_connection values. Never called at startup. */
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptJson, encryptJson, isEncrypted } from "./encryption";

interface StoredRow { id: string; value: string }
interface RecoveryRow { id: string; before: string; after: string }
interface RecoveryRecord {
  format: "jarvis-native-credentials-v1";
  database: string;
  deploymentVersion: string;
  rows: RecoveryRow[];
}

export class CredentialMigrationError extends Error {}

function rows(db: Database): StoredRow[] {
  return db.query<StoredRow, []>("SELECT id, value FROM app_connection ORDER BY id").all();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readValue(stored: string): Record<string, unknown> {
  try {
    const value = decryptJson(stored);
    if (!object(value)) throw new Error();
    return value;
  } catch {
    // Parser errors and database error text must not become credential logs.
    throw new CredentialMigrationError("An unreadable credential blocks migration; check the key and data offline.");
  }
}

/** Counts only; does not resolve/generate a key or expose identifiers/values. */
export function inventoryNativeCredentials(db: Database) {
  const result = { total: 0, encrypted: 0, legacy: 0, invalidLegacy: 0 };
  for (const row of rows(db)) {
    result.total++;
    if (isEncrypted(row.value)) { result.encrypted++; continue; }
    try {
      if (!object(JSON.parse(row.value))) throw new Error();
      result.legacy++;
    } catch { result.invalidLegacy++; }
  }
  return result;
}

function persistRecovery(path: string, record: RecoveryRecord): void {
  const encrypted = encryptJson(record);
  // Refuse replacement/symlinks, restrict permissions at creation and make the
  // journal durable BEFORE committing any DB change. No plaintext staging file.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, encrypted, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Caller must load the EXISTING key and hold the daemon lock throughout. */
export function migrateNativeCredentials(db: Database, recoveryPath: string, deploymentVersion: string) {
  if (!deploymentVersion.trim()) throw new CredentialMigrationError("Record the deployed version before applying migration.");
  try {
    return db.transaction(() => {
      const current = rows(db);
      const changes: RecoveryRow[] = [];
      for (const row of current) {
        const value = readValue(row.value); // Also authenticate already-encrypted rows.
        if (!isEncrypted(row.value)) changes.push({ id: row.id, before: row.value, after: encryptJson(value) });
      }
      if (changes.length === 0) return { migrated: 0, alreadyEncrypted: current.length };
      persistRecovery(recoveryPath, {
        format: "jarvis-native-credentials-v1", database: realpathSync(db.filename),
        deploymentVersion, rows: changes,
      });
      const update = db.query("UPDATE app_connection SET value = ? WHERE id = ? AND value = ?");
      for (const row of changes) {
        if (update.run(row.after, row.id, row.before).changes !== 1) {
          throw new CredentialMigrationError("Credential changed during migration; transaction aborted.");
        }
      }
      return { migrated: changes.length, alreadyEncrypted: current.length - changes.length };
    }).immediate();
  } catch (error) {
    if (error instanceof CredentialMigrationError) throw error;
    throw new CredentialMigrationError("Migration storage operation failed; retain any recovery file and inspect offline.");
  }
}

function readRecovery(db: Database, path: string): RecoveryRecord {
  try {
    const stored = readFileSync(path, "utf8");
    if (!isEncrypted(stored)) throw new Error();
    const record = decryptJson(stored);
    if (!object(record) || record.format !== "jarvis-native-credentials-v1"
      || record.database !== realpathSync(db.filename) || typeof record.deploymentVersion !== "string"
      || !Array.isArray(record.rows)) throw new Error();
    const ids = new Set<string>();
    for (const row of record.rows) {
      if (!object(row) || typeof row.id !== "string" || !row.id || ids.has(row.id)
        || typeof row.before !== "string" || typeof row.after !== "string"
        || isEncrypted(row.before) || !isEncrypted(row.after)) throw new Error();
      if (JSON.stringify(readValue(row.before)) !== JSON.stringify(readValue(row.after))) throw new Error();
      ids.add(row.id);
    }
    return record as unknown as RecoveryRecord;
  } catch {
    throw new CredentialMigrationError("Recovery record is unreadable or does not belong to this database.");
  }
}

/** Explicit rollback restores the original legacy values, including plaintext. */
export function rollbackNativeCredentials(db: Database, recoveryPath: string) {
  const recovery = readRecovery(db, recoveryPath);
  try {
    return db.transaction(() => {
      const get = db.query<StoredRow, [string]>("SELECT id, value FROM app_connection WHERE id = ?");
      const pending: RecoveryRow[] = [];
      for (const row of recovery.rows) {
        const current = get.get(row.id);
        if (!current || (current.value !== row.after && current.value !== row.before)) {
          throw new CredentialMigrationError("A credential changed or was deleted since migration; rollback refused.");
        }
        if (current.value === row.after) pending.push(row);
      }
      const update = db.query("UPDATE app_connection SET value = ? WHERE id = ? AND value = ?");
      for (const row of pending) {
        if (update.run(row.before, row.id, row.after).changes !== 1) throw new Error();
      }
      return { restored: pending.length, alreadyOriginal: recovery.rows.length - pending.length };
    }).immediate();
  } catch (error) {
    if (error instanceof CredentialMigrationError) throw error;
    throw new CredentialMigrationError("Rollback storage operation failed; retain the recovery file and inspect offline.");
  }
}
