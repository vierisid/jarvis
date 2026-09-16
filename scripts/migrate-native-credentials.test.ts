import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../src/workflows/db/index";
import { decryptJson, encryptJson, isEncrypted, setEncryptionKey } from "../src/workflows/db/encryption";
import { getConnection, upsertConnection } from "../src/workflows/db/repos/app-connection";
import { acquireLockAt, lockPathFor } from "../src/daemon/pid";

const SCRIPT = resolve(import.meta.dir, "migrate-native-credentials.ts");
const TOKEN = "synthetic-legacy-migration-credential";
const KEY = Buffer.alloc(32, 11);
let dir: string;
let dbPath: string;
let keyFile: string;
let recovery: string;
let original: Array<{ id: string; value: string; updated: number }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-credential-migration-"));
  dbPath = join(dir, "jarvis.db");
  keyFile = join(dir, "workflow.key");
  recovery = join(dir, "recovery.enc");
  writeFileSync(keyFile, KEY.toString("hex"), { mode: 0o600 });
  initWorkflowDb(dbPath);
  setEncryptionKey(KEY);
  for (const externalId of ["a", "b", "c"]) {
    const row = upsertConnection({ externalId, displayName: externalId, type: "OAUTH2",
      pieceName: "fixture", pieceVersion: "1", value: { access_token: TOKEN + externalId } });
    if (externalId !== "c") getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?", [
      ' { "access_token" : "' + TOKEN + externalId + '" } ', row.id,
    ]);
  }
  closeWorkflowDb();
  setEncryptionKey(null);
  original = stored();
}, 30_000);

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
  rmSync(dir, { recursive: true, force: true });
});

function query<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath, { readwrite: true, create: false });
  try { return fn(db); } finally { db.close(); }
}

function stored() {
  return query(db => db.query<{ id: string; value: string; updated: number }, []>(
    "SELECT id, value, updated FROM app_connection ORDER BY id",
  ).all());
}

function run(mode: "inventory" | "apply" | "rollback", extra: string[] = [], envOverrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, JARVIS_HOME: dir };
  delete env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
  delete env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE;
  Object.assign(env, envOverrides);
  const args = [SCRIPT, mode, "--db", dbPath];
  if (mode !== "inventory") args.push("--data-dir", dir, "--recovery", recovery);
  if (mode === "apply") args.push("--deployment-version", "0.13.7-fixture");
  if (mode !== "inventory" && !Object.hasOwn(envOverrides, "JARVIS_WORKFLOW_ENCRYPTION_KEY")) {
    args.push("--key-file", keyFile);
  }
  const res = spawnSync(process.execPath, [...args, ...extra], {
    env, encoding: "utf8", timeout: 20_000,
  });
  const output = (res.stdout ?? "") + (res.stderr ?? "");
  expect(output).not.toContain(TOKEN);
  expect(output).not.toContain(KEY.toString("hex"));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("offline native credential migration", () => {
  test("inventory is read-only, count-only and needs no encryption key", () => {
    rmSync(keyFile);
    const res = run("inventory");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ mode: "inventory", deploymentVersion: "unknown",
      total: 3, encrypted: 1, legacy: 2, invalidLegacy: 0 });
    expect(stored()).toEqual(original);
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(recovery)).toBe(false);
  });

  test("migrates only legacy values and reverses exact bytes after process/database reopening", () => {
    expect(run("apply").status).toBe(0);
    const after = stored();
    expect(after.every(row => isEncrypted(row.value))).toBe(true);
    for (const row of after) {
      const before = original.find(old => old.id === row.id)!;
      expect(row.updated).toBe(before.updated);
      if (isEncrypted(before.value)) expect(row).toEqual(before);
    }
    const journal = readFileSync(recovery, "utf8");
    expect(isEncrypted(journal)).toBe(true);
    expect(journal).not.toContain(TOKEN);
    expect(statSync(recovery).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8")).toBe(KEY.toString("hex"));
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    for (const row of after) expect(getConnection(row.id)?.value).toEqual(decryptJson(row.value) as Record<string, unknown>);
    closeWorkflowDb();
    setEncryptionKey(null);

    expect(run("rollback").status).toBe(0);
    expect(stored()).toEqual(original);
    expect(JSON.parse(run("rollback").stdout)).toMatchObject({ restored: 0, alreadyOriginal: 2 });
    expect(readFileSync(recovery, "utf8")).toBe(journal);
  });

  test("repeated apply is a no-op and retains its recovery record", () => {
    expect(run("apply").status).toBe(0);
    const after = stored();
    const journal = readFileSync(recovery, "utf8");
    expect(JSON.parse(run("apply").stdout)).toMatchObject({ migrated: 0, alreadyEncrypted: 3 });
    expect(stored()).toEqual(after);
    expect(readFileSync(recovery, "utf8")).toBe(journal);
  });

  test("existing recovery file blocks migration without overwriting it", () => {
    writeFileSync(recovery, "retained recovery fixture");
    expect(run("apply").status).toBe(1);
    expect(stored()).toEqual(original);
    expect(readFileSync(recovery, "utf8")).toBe("retained recovery fixture");
  });

  test.each([TOKEN, "null", "[]", "enc1:bad"])("unreadable or invalid credential blocks all writes: %s", bad => {
    query(db => db.run("UPDATE app_connection SET value = ? WHERE id = ?", [bad, original[1]!.id]));
    const before = stored();
    const res = run("apply");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unreadable credential");
    expect(stored()).toEqual(before);
    expect(existsSync(recovery)).toBe(false);
  });

  test("missing and wrong keys never generate keys or change credentials", () => {
    writeFileSync(keyFile, Buffer.alloc(32, 22).toString("hex"));
    expect(run("apply").status).toBe(1);
    expect(stored()).toEqual(original);
    expect(existsSync(recovery)).toBe(false);
    rmSync(keyFile);
    expect(run("apply").status).toBe(1);
    expect(existsSync(keyFile)).toBe(false);
    expect(stored()).toEqual(original);
  });

  test("supports the configured environment key without changing any key file", () => {
    rmSync(keyFile);
    expect(run("apply", [], { JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY.toString("hex") }).status).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
    expect(run("rollback", [], { JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY.toString("hex") }).status).toBe(0);
    expect(stored()).toEqual(original);
  });

  test("transaction failure leaves every row original and recovery safely replayable", () => {
    const lastLegacy = original.filter(row => !isEncrypted(row.value)).at(-1)!;
    query(db => db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE OF value ON app_connection "
      + "WHEN OLD.id = '" + lastLegacy.id + "' BEGIN SELECT RAISE(ABORT, '" + TOKEN + "'); END"));
    expect(run("apply").status).toBe(1);
    expect(stored()).toEqual(original);
    expect(readFileSync(recovery, "utf8")).not.toContain(TOKEN);
    query(db => db.exec("DROP TRIGGER fail_migration"));
    expect(JSON.parse(run("rollback").stdout)).toMatchObject({ restored: 0, alreadyOriginal: 2 });
    expect(stored()).toEqual(original);
  });

  test("rollback failure is atomic", () => {
    expect(run("apply").status).toBe(0);
    const after = stored();
    const lastLegacy = original.filter(row => !isEncrypted(row.value)).at(-1)!;
    query(db => db.exec("CREATE TRIGGER fail_rollback BEFORE UPDATE OF value ON app_connection "
      + "WHEN OLD.id = '" + lastLegacy.id + "' BEGIN SELECT RAISE(ABORT, '" + TOKEN + "'); END"));
    expect(run("rollback").status).toBe(1);
    expect(stored()).toEqual(after);
  });

  test.each(["updated", "deleted"])("rollback refuses a credential %s since migration", change => {
    expect(run("apply").status).toBe(0);
    const id = original.find(row => !isEncrypted(row.value))!.id;
    query(db => change === "deleted"
      ? db.run("DELETE FROM app_connection WHERE id = ?", [id])
      : db.run("UPDATE app_connection SET value = ? WHERE id = ?", ["{\"secret\":\"new-fixture\"}", id]));
    const changed = stored();
    expect(run("rollback").status).toBe(1);
    expect(stored()).toEqual(changed);
  });

  test("rollback refuses a tampered recovery record or a different database path", () => {
    expect(run("apply").status).toBe(0);
    const after = stored();
    const oldPath = dbPath;
    const differentPath = join(dir, "different.db");
    query(db => db.run("VACUUM INTO ?", [differentPath]));
    dbPath = differentPath;
    expect(run("rollback").status).toBe(1);
    expect(stored()).toEqual(after);
    dbPath = oldPath;
    const bytes = readFileSync(recovery, "utf8");
    writeFileSync(recovery, bytes.slice(0, 10) + "!" + bytes.slice(11));
    expect(run("rollback").status).toBe(1);
    expect(stored()).toEqual(after);
  });

  test("held daemon lock blocks apply and rollback, but allows read-only inventory", () => {
    const lock = acquireLockAt(lockPathFor(dir), process.pid);
    expect(lock).not.toBeNull();
    try {
      expect(run("apply").status).toBe(1);
      expect(run("rollback").status).toBe(1);
      expect(run("inventory").status).toBe(0);
      expect(stored()).toEqual(original);
    } finally { lock?.release(); }
  });
});
