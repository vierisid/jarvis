/**
 * Workflow database singleton. Backed by `bun:sqlite` in a separate file from
 * the vault, so workflow data and knowledge-graph data can be backed up,
 * truncated, or moved independently.
 */

import { Database } from "bun:sqlite";
import { createSchema, DEFAULT_IDS } from "./schema";

let dbInstance: Database | null = null;

export function initWorkflowDb(dbPath = ":memory:"): Database {
  closeWorkflowDb();
  const db = new Database(dbPath, { create: true });
  createSchema(db);
  dbInstance = db;
  return db;
}

export function getWorkflowDb(): Database {
  if (!dbInstance) {
    throw new Error("Workflow database not initialized. Call initWorkflowDb() first.");
  }
  return dbInstance;
}

export function closeWorkflowDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export { DEFAULT_IDS };
