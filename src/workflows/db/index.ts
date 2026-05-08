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
import { createSchema, DEFAULT_IDS } from "./schema";

/**
 * Add workflow tables to the already-initialized shared DB. Idempotent
 * (`CREATE TABLE IF NOT EXISTS` throughout). The daemon calls this once at
 * startup, after `initDatabase()`.
 */
export function ensureWorkflowSchema(): void {
  createSchema(getDb());
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
