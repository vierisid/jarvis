/**
 * Workflow tables share the single Jarvis SQLite database (`~/.jarvis/jarvis.db`)
 * with vault, awareness, goals, etc. Backups are one file. There is no
 * separate `workflows.db`.
 *
 * Production startup order:
 *   1. `initDatabase(path)`     -- vault module, creates the shared instance
 *   2. `ensureWorkflowSchema()` -- this module, adds workflow tables (idempotent)
 *
 * Tests use `initWorkflowDb(":memory:")` -- a thin helper that builds both
 * schemas in a fresh in-memory DB. The vault tables are unused by workflow
 * tests but creating them is cheap and avoids forcing every test to wire
 * vault setup separately.
 */

import type { Database } from "bun:sqlite";
import { closeDb, getDb, initDatabase } from "../../vault/schema";
import { ENCRYPTED_VALUE_SQL, hasResolvableEncryptionKey, keyFileCandidates } from "./encryption";
import { createSchema, DEFAULT_IDS } from "./schema";

/** A database full of ciphertext and no key to read it with. */
export class MissingEncryptionKeyError extends Error {}

/**
 * Refuse to continue when `app_connection` holds encrypted rows and no key
 * can be resolved without inventing one.
 *
 * Without this the first credential write generates a fresh random key,
 * starts up clean, and re-encrypts rows with a key that cannot read any of
 * the existing ones -- so the original ciphertext is overwritten and the only
 * signal is a piece failing to authenticate later, long after the operator
 * could still have found the backup holding the real key. A key that cannot
 * decrypt what is already stored is never the right answer, so fail loudly
 * while the backup is still around.
 *
 * Layering. The check lives HERE rather than inside `encryption.ts` on
 * purpose: the crypto module is imported BY the db layer, so having it query
 * `app_connection` would invert that dependency. It only needs to know
 * whether a key is resolvable, which is a question about the filesystem, and
 * it exposes that as `hasResolvableEncryptionKey()`. The database question
 * stays with the module that owns the schema, and `ensureWorkflowSchema()` --
 * the one call the daemon makes at boot before anything reads a credential --
 * asks it.
 */
export function assertEncryptionKeyForStoredCredentials(db: Database = getDb()): void {
  if (hasResolvableEncryptionKey()) return;
  // ENCRYPTED_VALUE_SQL, never a single prefix literal: an `enc1:` test would
  // go blind to every row the row-binding conversion has rewritten as
  // `enc1a:`, which is the whole table on a converted deployment.
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM app_connection WHERE ${ENCRYPTED_VALUE_SQL}`,
    )
    .get();
  const encrypted = row?.n ?? 0;
  if (encrypted === 0) return;
  throw new MissingEncryptionKeyError(
    [
      `No workflow encryption key could be found, but ${encrypted} workflow connection(s) in`,
      `${db.filename || "the workflow database"} are encrypted. Refusing to start with a freshly`,
      "generated key: it cannot decrypt those rows, and using it would overwrite them.",
      "",
      "Restore the key file to one of:",
      ...keyFileCandidates().map((path) => `  ${path}`),
      "or set JARVIS_WORKFLOW_ENCRYPTION_KEY (64 hex chars) / JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE.",
      "",
      "A `jarvis export --full` archive taken by this version carries the key as",
      "`workflow-encryption.key`. Older archives do not -- check any separate key escrow,",
      "and any backup of the data dir, before deleting anything.",
    ].join("\n"),
  );
}

/**
 * Add workflow tables to the already-initialized shared DB. Idempotent
 * (`CREATE TABLE IF NOT EXISTS` throughout). The daemon calls this once at
 * startup, after `initDatabase()`. Also the choke point for the
 * missing-encryption-key check below, so the refusal happens at boot rather
 * than whenever some later code path first touches a credential.
 */
export function ensureWorkflowSchema(): void {
  const db = getDb();
  createSchema(db);
  assertEncryptionKeyForStoredCredentials(db);
}

/**
 * Test helper: spin up a fresh DB at `dbPath` (default `:memory:`) and
 * install it as the shared singleton with both vault and workflow schemas.
 * Production code paths should not call this -- use `initDatabase` +
 * `ensureWorkflowSchema` instead.
 */
export function initWorkflowDb(dbPath = ":memory:"): Database {
  const db = initDatabase(dbPath);
  createSchema(db);
  return db;
}

/**
 * Returns the shared Jarvis DB (same instance as vault's `getDb`). Workflow
 * code calls this anywhere it needs a `Database` handle.
 */
export function getWorkflowDb(): Database {
  return getDb();
}

/**
 * Closes the shared Jarvis DB. Equivalent to vault's `closeDb`. Tests call
 * this via either entry point; the second call is a no-op.
 */
export function closeWorkflowDb(): void {
  closeDb();
}

export { DEFAULT_IDS };
