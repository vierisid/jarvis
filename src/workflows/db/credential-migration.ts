/** Offline, opt-in conversion of legacy app_connection values. Never called at startup. */
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decryptBoundJson, decryptJson, encryptBoundJson, encryptJson, isEncrypted, isRowBound,
  setRequireEncryptedCredentials, withLegacyPlaintextReads, type CredentialRowBinding,
} from "./encryption";

interface StoredRow { id: string; project_id: string; piece_name: string; external_id: string; value: string }
interface RecoveryRow { id: string; before: string; after: string }
interface RecoveryRecord {
  format: "jarvis-native-credentials-v1";
  database: string;
  deploymentVersion: string;
  rows: RecoveryRow[];
}
/**
 * Binding conversion journal. Carries the identity tuple per row because a
 * row-bound blob cannot be authenticated without it, so the journal has to be
 * checkable on its own before any write.
 */
interface BindingRecoveryRow extends RecoveryRow, CredentialRowBinding {}
interface BindingRecoveryRecord {
  format: "jarvis-credential-binding-v1";
  database: string;
  deploymentVersion: string;
  rows: BindingRecoveryRow[];
}

export class CredentialMigrationError extends Error {}

function rows(db: Database): StoredRow[] {
  return db.query<StoredRow, []>(
    "SELECT id, project_id, piece_name, external_id, value FROM app_connection ORDER BY id",
  ).all();
}

function bindingFor(row: StoredRow): CredentialRowBinding {
  return { id: row.id, projectId: row.project_id, pieceName: row.piece_name, externalId: row.external_id };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readValue(stored: string, binding?: CredentialRowBinding): Record<string, unknown> {
  try {
    const value = binding ? decryptBoundJson(stored, binding) : decryptJson(stored);
    if (!object(value)) throw new Error();
    return value;
  } catch {
    // Parser errors and database error text must not become credential logs.
    throw new CredentialMigrationError("An unreadable credential blocks migration; check the key and data offline.");
  }
}

/**
 * Counts only; does not resolve/generate a key or expose identifiers/values.
 * `encrypted` counts either envelope prefix; `rowBound` is the `enc1a:` subset
 * that is also bound to its row. Neither proves the row authenticates.
 */
export function inventoryNativeCredentials(db: Database) {
  const result = { total: 0, encrypted: 0, rowBound: 0, legacy: 0, invalidLegacy: 0 };
  for (const row of rows(db)) {
    result.total++;
    if (isEncrypted(row.value)) {
      result.encrypted++;
      if (isRowBound(row.value)) result.rowBound++;
      continue;
    }
    try {
      if (!object(JSON.parse(row.value))) throw new Error();
      result.legacy++;
    } catch { result.invalidLegacy++; }
  }
  return result;
}

/**
 * Turns strict plaintext refusal on, but only once no readable-plaintext row
 * is left. Never turns it off. Enabling early would make rows the deployment still needs
 * unreadable one piece at a time, which is both an outage and the hardest
 * failure to attribute, so this refuses instead of warning. The refusal is
 * undone by running the conversion; a lockout is not.
 *
 * `invalidLegacy` rows are deliberately not a blocker: a value that is
 * neither an envelope nor valid JSON already fails every read, so strict mode
 * changes nothing for it except the error text.
 */
export function enableStrictCredentialEncryption(db: Database): { legacy: number } {
  const inventory = inventoryNativeCredentials(db);
  if (inventory.legacy > 0) {
    // Leave the current setting alone. A refusal must never be a way to turn
    // strict mode back OFF: a writer who adds a plaintext row would otherwise
    // be able to downgrade an already-strict daemon by provoking this check.
    throw new CredentialMigrationError(
      `Strict credential encryption refused: ${inventory.legacy} plaintext credential row(s) remain. `
      + "Convert them first, then enable it.",
    );
  }
  setRequireEncryptedCredentials(true);
  return { legacy: inventory.legacy };
}

/**
 * Boot glue for `JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS`. Returns whether strict
 * mode was enabled; propagates the gate's refusal, which at startup means the
 * daemon does not come up. The variable is the operator asserting that
 * conversion finished, so a false assertion has to be loud: enabling anyway
 * would break credential reads lazily, one piece at a time, and ignoring the
 * variable would leave the operator believing plaintext is refused when it is
 * not. Unsetting it undoes the refusal and touches no data.
 */
export function applyStrictCredentialEncryptionSetting(
  db: Database,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env["JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS"] !== "1") return false;
  enableStrictCredentialEncryption(db);
  return true;
}

function persistRecovery(path: string, record: RecoveryRecord | BindingRecoveryRecord): void {
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

/**
 * Plaintext -> unbound `enc1:`, as shipped in #473. Superseded by
 * `bindNativeCredentials`, which reaches the row-bound envelope in one pass;
 * kept so a deployment mid-rollout can still finish and roll back through its
 * existing journal. Caller must load the EXISTING key and hold the daemon lock
 * throughout.
 */
export function migrateNativeCredentials(db: Database, recoveryPath: string, deploymentVersion: string) {
  if (!deploymentVersion.trim()) throw new CredentialMigrationError("Record the deployed version before applying migration.");
  try {
    return withLegacyPlaintextReads(() => db.transaction(() => {
      const current = rows(db);
      const changes: RecoveryRow[] = [];
      for (const row of current) {
        const value = readValue(row.value, bindingFor(row)); // Also authenticate already-encrypted rows.
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
    }).immediate());
  } catch (error) {
    if (error instanceof CredentialMigrationError) throw error;
    throw new CredentialMigrationError("Migration storage operation failed; retain any recovery file and inspect offline.");
  }
}

/**
 * Re-wraps every row that is not already row-bound into the `enc1a:`
 * envelope, covering both legacy plaintext and unbound `enc1:` ciphertext, so
 * one pass reaches the end state. Same shape as the conversion above: one
 * `BEGIN IMMEDIATE` transaction, every row authenticated before any write, a
 * durable encrypted journal fsynced before the first UPDATE, and optimistic
 * `WHERE id = ? AND value = ?` so a concurrent change aborts the whole thing.
 *
 * Crash before commit leaves every row byte-for-byte original; crash after
 * commit leaves the journal on disk. A credential is never lost, only
 * left un-converted. Caller must load the EXISTING key and hold the daemon
 * lock throughout.
 */
export function bindNativeCredentials(db: Database, recoveryPath: string, deploymentVersion: string) {
  if (!deploymentVersion.trim()) throw new CredentialMigrationError("Record the deployed version before applying migration.");
  try {
    return withLegacyPlaintextReads(() => db.transaction(() => {
      const current = rows(db);
      const changes: BindingRecoveryRow[] = [];
      for (const row of current) {
        const binding = bindingFor(row);
        const value = readValue(row.value, binding); // Also authenticate already-bound rows.
        if (isRowBound(row.value)) continue;
        changes.push({ ...binding, before: row.value, after: encryptBoundJson(value, binding) });
      }
      if (changes.length === 0) return { bound: 0, alreadyBound: current.length };
      persistRecovery(recoveryPath, {
        format: "jarvis-credential-binding-v1", database: realpathSync(db.filename),
        deploymentVersion, rows: changes,
      });
      const update = db.query("UPDATE app_connection SET value = ? WHERE id = ? AND value = ?");
      for (const row of changes) {
        if (update.run(row.after, row.id, row.before).changes !== 1) {
          throw new CredentialMigrationError("Credential changed during migration; transaction aborted.");
        }
      }
      return { bound: changes.length, alreadyBound: current.length - changes.length };
    }).immediate());
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
  const recovery = withLegacyPlaintextReads(() => readRecovery(db, recoveryPath));
  try {
    return db.transaction(() => {
      const get = db.query<Pick<StoredRow, "id" | "value">, [string]>("SELECT id, value FROM app_connection WHERE id = ?");
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

function readBindingRecovery(db: Database, path: string): BindingRecoveryRecord {
  try {
    const stored = readFileSync(path, "utf8");
    if (!isEncrypted(stored)) throw new Error();
    const record = decryptJson(stored);
    if (!object(record) || record.format !== "jarvis-credential-binding-v1"
      || record.database !== realpathSync(db.filename) || typeof record.deploymentVersion !== "string"
      || !Array.isArray(record.rows)) throw new Error();
    const ids = new Set<string>();
    for (const row of record.rows) {
      if (!object(row) || typeof row.id !== "string" || !row.id || ids.has(row.id)
        || typeof row.projectId !== "string" || typeof row.pieceName !== "string"
        || typeof row.externalId !== "string"
        || typeof row.before !== "string" || typeof row.after !== "string"
        || isRowBound(row.before) || !isRowBound(row.after)) throw new Error();
      const binding = row as unknown as CredentialRowBinding;
      // Prove the two blobs carry the same credential before offering to swap
      // one for the other. A journal that cannot do that is not a journal.
      if (JSON.stringify(readValue(row.before, binding)) !== JSON.stringify(readValue(row.after, binding))) {
        throw new Error();
      }
      ids.add(row.id);
    }
    return record as unknown as BindingRecoveryRecord;
  } catch {
    throw new CredentialMigrationError("Recovery record is unreadable or does not belong to this database.");
  }
}

/**
 * Explicit rollback of the binding conversion, restoring the exact original
 * bytes -- unbound `enc1:` or legacy plaintext, whichever the row held. Every
 * listed row is checked before any write and must hold either its original or
 * its exact converted value, so a credential written since the conversion is
 * never overwritten.
 */
export function rollbackCredentialBinding(db: Database, recoveryPath: string) {
  const recovery = withLegacyPlaintextReads(() => readBindingRecovery(db, recoveryPath));
  try {
    return db.transaction(() => {
      const get = db.query<Pick<StoredRow, "id" | "value">, [string]>(
        "SELECT id, value FROM app_connection WHERE id = ?",
      );
      const pending: BindingRecoveryRow[] = [];
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
