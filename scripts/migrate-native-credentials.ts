#!/usr/bin/env bun
/** See docs/superpowers/specs/2026-09-16-native-credential-encryption.md before live use. */
import { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { acquireLockAt, lockPathFor } from "../src/daemon/pid";
import { setEncryptionKey } from "../src/workflows/db/encryption";
import {
  CredentialMigrationError, inventoryNativeCredentials, migrateNativeCredentials, rollbackNativeCredentials,
} from "../src/workflows/db/credential-migration";

const USAGE = [
  "bun scripts/migrate-native-credentials.ts inventory --db <file> [--deployment-version <version>]",
  "bun scripts/migrate-native-credentials.ts apply --db <file> --data-dir <dir> --deployment-version <version> --recovery <new-file> [--key-file <existing-key>]",
  "bun scripts/migrate-native-credentials.ts rollback --db <file> --data-dir <dir> --recovery <file> [--key-file <existing-key>]",
  "Use the existing key file OR JARVIS_WORKFLOW_ENCRYPTION_KEY, never both. Keys are never generated.",
  "Stop the daemon and its supervisor before apply/rollback. Rollback restores legacy plaintext.",
].join("\n");

function parseArgs(argv: string[]) {
  const [mode, ...rest] = argv;
  if (mode !== "inventory" && mode !== "apply" && mode !== "rollback") throw new Error();
  const options = new Map<string, string>();
  const allowed = new Set(["--db", "--data-dir", "--key-file", "--recovery", "--deployment-version"]);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.has(flag) || options.has(flag) || !value || value.startsWith("--")) throw new Error();
    options.set(flag, value);
  }
  if (!options.has("--db")) throw new Error();
  if (mode !== "inventory" && (!options.has("--data-dir") || !options.has("--recovery"))) throw new Error();
  if (mode === "apply" && !options.get("--deployment-version")?.trim()) throw new Error();
  return { mode, options };
}

function loadExistingKey(keyFile: string | undefined): Buffer {
  const envKey = process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
  if (envKey !== undefined && keyFile !== undefined) {
    throw new CredentialMigrationError("Select one existing key source: environment or --key-file.");
  }
  if (envKey === undefined && keyFile === undefined) {
    throw new CredentialMigrationError("Supply the existing key using --key-file or JARVIS_WORKFLOW_ENCRYPTION_KEY.");
  }
  let hex: string;
  try { hex = envKey ?? readFileSync(keyFile!, "utf8").trim(); }
  catch { throw new CredentialMigrationError("The existing key file could not be read."); }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new CredentialMigrationError("The existing key must contain 64 hex characters.");
  return Buffer.from(hex, "hex");
}

async function main(): Promise<number> {
  if (process.argv.slice(2).includes("--help")) { console.log(USAGE); return 0; }
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(process.argv.slice(2)); }
  catch { console.error(USAGE); return 2; }
  const { mode, options } = args;
  const locks: Array<{ release(): void }> = [];
  let db: Database | undefined;
  try {
    const dbPath = realpathSync(options.get("--db")!);
    if (mode !== "inventory") {
      const dataDir = realpathSync(options.get("--data-dir")!);
      // Match restore's locking contract, including JARVIS_HOME. Hold locks
      // throughout so the daemon cannot start after a one-time lock probe.
      for (const path of new Set([lockPathFor(), lockPathFor(dataDir)])) {
        const lock = acquireLockAt(path, process.pid);
        if (!lock) throw new CredentialMigrationError("Daemon or maintenance task is running; stop it before migration.");
        locks.push(lock);
      }
      setEncryptionKey(loadExistingKey(options.get("--key-file")));
    }
    db = new Database(dbPath, { readonly: mode === "inventory", readwrite: mode !== "inventory", create: false });
    if (mode !== "inventory") db.exec("PRAGMA synchronous = FULL");
    const result = mode === "inventory"
      ? { deploymentVersion: options.get("--deployment-version") ?? "unknown", ...inventoryNativeCredentials(db) }
      : mode === "apply"
        ? migrateNativeCredentials(db, resolve(options.get("--recovery")!), options.get("--deployment-version")!)
        : rollbackNativeCredentials(db, resolve(options.get("--recovery")!));
    console.log(JSON.stringify({ mode, ...result }));
    return 0;
  } catch (error) {
    // Do not print SQLite/JSON/native exception messages or supplied values.
    console.error(error instanceof CredentialMigrationError
      ? error.message : "Credential maintenance failed; details withheld to protect stored values. Inspect offline.");
    return 1;
  } finally {
    db?.close();
    setEncryptionKey(null);
    for (const lock of locks.reverse()) lock.release();
  }
}

if (import.meta.main) process.exitCode = await main();
