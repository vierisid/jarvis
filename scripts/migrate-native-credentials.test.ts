import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../src/workflows/db/index";
import {
  decryptBoundJson, encryptJson, isEncrypted, isRowBound, requireEncryptedCredentials,
  setEncryptionKey, setRequireEncryptedCredentials, type CredentialRowBinding,
} from "../src/workflows/db/encryption";
import {
  applyStrictCredentialEncryptionSetting, enableStrictCredentialEncryption, inventoryNativeCredentials,
} from "../src/workflows/db/credential-migration";
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
type IdentityRow = CredentialRowBinding & { value: string };

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
    // a, b: legacy plaintext. c: the unbound `enc1:` envelope #473 wrote, which
    // `upsertConnection` no longer produces but every converted install holds.
    getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?", [
      externalId === "c"
        ? encryptJson({ access_token: TOKEN + externalId })
        : ' { "access_token" : "' + TOKEN + externalId + '" } ',
      row.id,
    ]);
  }
  closeWorkflowDb();
  setEncryptionKey(null);
  original = stored();
}, 30_000);

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
  setRequireEncryptedCredentials(false);
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

/** Every row with the identity columns an `enc1a:` blob is sealed against. */
function identities(): IdentityRow[] {
  return query(db => db.query<
    { id: string; project_id: string; piece_name: string; external_id: string; value: string }, []
  >("SELECT id, project_id, piece_name, external_id, value FROM app_connection ORDER BY id").all())
    .map(row => ({
      id: row.id, projectId: row.project_id, pieceName: row.piece_name,
      externalId: row.external_id, value: row.value,
    }));
}

type Mode = "inventory" | "apply" | "rollback" | "bind" | "rollback-binding";

function run(mode: Mode, extra: string[] = [], envOverrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, JARVIS_HOME: dir };
  delete env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
  delete env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE;
  Object.assign(env, envOverrides);
  const args = [SCRIPT, mode, "--db", dbPath];
  if (mode !== "inventory") args.push("--data-dir", dir, "--recovery", recovery);
  if (mode === "apply" || mode === "bind") args.push("--deployment-version", "0.13.7-fixture");
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
      total: 3, encrypted: 1, rowBound: 0, legacy: 2, invalidLegacy: 0 });
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
    for (const row of identities()) {
      expect(getConnection(row.id)?.value).toEqual(decryptBoundJson(row.value, row) as Record<string, unknown>);
    }
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

  test.each(["apply", "rollback"] as const)("%s succeeds when the daemon root aliases the data directory", mode => {
    if (mode === "rollback") expect(run("apply").status).toBe(0);
    const alias = join(dir, "home-alias");
    symlinkSync(dir, alias, "dir");
    // Canonicalize the directory even when no lock file exists yet.
    expect(existsSync(lockPathFor(dir))).toBe(false);
    const res = run(mode, [], { JARVIS_HOME: alias });
    expect(res.status).toBe(0);
    if (mode === "apply") {
      expect(JSON.parse(res.stdout)).toMatchObject({ migrated: 2, alreadyEncrypted: 1 });
      expect(stored().every(row => isEncrypted(row.value))).toBe(true);
    } else {
      expect(JSON.parse(res.stdout)).toMatchObject({ restored: 2 });
      expect(stored()).toEqual(original);
    }
    expect(existsSync(lockPathFor(dir))).toBe(false);
  });

  test("held daemon lock through an alias blocks writes, but allows read-only inventory", () => {
    const alias = join(dir, "home-alias");
    symlinkSync(dir, alias, "dir");
    const env = { JARVIS_HOME: alias };
    const lock = acquireLockAt(lockPathFor(dir), process.pid);
    expect(lock).not.toBeNull();
    try {
      for (const mode of ["apply", "rollback"] as const) {
        const res = run(mode, [], env);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("Daemon or maintenance task is running");
        expect(readFileSync(lockPathFor(dir), "utf8")).toBe(String(process.pid));
      }
      expect(run("inventory", [], env).status).toBe(0);
      expect(stored()).toEqual(original);
    } finally { lock?.release(); }
  });

  test.each(["daemon", "data"])("retains the distinct %s lock when the roots differ", held => {
    expect(run("apply").status).toBe(0);
    const before = stored();
    const home = join(dir, "separate-home");
    const lock = acquireLockAt(lockPathFor(held === "daemon" ? home : dir), process.pid);
    expect(lock).not.toBeNull();
    try {
      for (const mode of ["apply", "rollback"] as const) {
        const res = run(mode, [], { JARVIS_HOME: home });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("Daemon or maintenance task is running");
        expect(stored()).toEqual(before);
      }
    } finally { lock?.release(); }
    expect(run("rollback", [], { JARVIS_HOME: home }).status).toBe(0);
    expect(stored()).toEqual(original);
  });

  test("creates a missing distinct daemon root before locking", () => {
    const home = join(dir, "new", "daemon-home");
    expect(existsSync(home)).toBe(false);
    expect(run("apply", [], { JARVIS_HOME: home }).status).toBe(0);
    expect(existsSync(home)).toBe(true);
    expect(run("rollback", [], { JARVIS_HOME: home }).status).toBe(0);
    expect(stored()).toEqual(original);
  });
});

describe("offline credential binding conversion", () => {
  /** The fixture holds two legacy plaintext rows and one unbound `enc1:` row. */
  test("binds plaintext and enc1: rows in one pass and leaves reads working", () => {
    expect(JSON.parse(run("bind").stdout)).toMatchObject({ bound: 3, alreadyBound: 0 });
    const after = identities();
    expect(after.every(row => isRowBound(row.value))).toBe(true);
    for (const row of after) {
      // Timestamps and metadata untouched; only `value` changes.
      expect(stored().find(r => r.id === row.id)!.updated)
        .toBe(original.find(r => r.id === row.id)!.updated);
      expect(row.value).not.toContain(TOKEN);
    }
    const journal = readFileSync(recovery, "utf8");
    expect(isEncrypted(journal)).toBe(true);
    expect(journal).not.toContain(TOKEN);
    expect(statSync(recovery).mode & 0o777).toBe(0o600);
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    for (const row of after) {
      expect(getConnection(row.id)?.value).toEqual(decryptBoundJson(row.value, row) as Record<string, unknown>);
    }
    expect(inventoryNativeCredentials(getWorkflowDb()))
      .toEqual({ total: 3, encrypted: 3, rowBound: 3, legacy: 0, invalidLegacy: 0 });
  });

  test("a bound row's value column no longer reads under another row", () => {
    expect(run("bind").status).toBe(0);
    const rows = identities();
    const donor = rows[0]!;
    const victim = rows[1]!;
    query(db => db.run("UPDATE app_connection SET value = ? WHERE id = ?", [donor.value, victim.id]));
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(() => getConnection(victim.id)).toThrow(/auth verification failed/);
  });

  test("repeated bind is a no-op and retains its recovery record", () => {
    expect(run("bind").status).toBe(0);
    const after = stored();
    const journal = readFileSync(recovery, "utf8");
    expect(JSON.parse(run("bind").stdout)).toMatchObject({ bound: 0, alreadyBound: 3 });
    expect(stored()).toEqual(after);
    expect(readFileSync(recovery, "utf8")).toBe(journal);
  });

  test("rollback-binding restores the exact original bytes and is itself repeatable", () => {
    expect(run("bind").status).toBe(0);
    const journal = readFileSync(recovery, "utf8");
    expect(JSON.parse(run("rollback-binding").stdout)).toMatchObject({ restored: 3, alreadyOriginal: 0 });
    expect(stored()).toEqual(original);
    expect(JSON.parse(run("rollback-binding").stdout)).toMatchObject({ restored: 0, alreadyOriginal: 3 });
    expect(stored()).toEqual(original);
    expect(readFileSync(recovery, "utf8")).toBe(journal);
  });

  test("a mid-transaction abort leaves every row original and the journal replayable", () => {
    const last = original.at(-1)!;
    // Abort after some rows have already been updated inside the transaction.
    query(db => db.exec("CREATE TRIGGER fail_binding BEFORE UPDATE OF value ON app_connection "
      + "WHEN OLD.id = '" + last.id + "' BEGIN SELECT RAISE(ABORT, '" + TOKEN + "'); END"));
    expect(run("bind").status).toBe(1);
    // Crash before commit: no row changed, but the journal is already durable.
    expect(stored()).toEqual(original);
    expect(existsSync(recovery)).toBe(true);
    expect(readFileSync(recovery, "utf8")).not.toContain(TOKEN);
    query(db => db.exec("DROP TRIGGER fail_binding"));
    // The retained journal still rolls back cleanly, so nothing is stranded.
    expect(JSON.parse(run("rollback-binding").stdout)).toMatchObject({ restored: 0, alreadyOriginal: 3 });
    expect(stored()).toEqual(original);
  });

  test("a rollback-binding abort is atomic", () => {
    expect(run("bind").status).toBe(0);
    const bound = stored();
    query(db => db.exec("CREATE TRIGGER fail_binding_rollback BEFORE UPDATE OF value ON app_connection "
      + "WHEN OLD.id = '" + original.at(-1)!.id + "' BEGIN SELECT RAISE(ABORT, '" + TOKEN + "'); END"));
    expect(run("rollback-binding").status).toBe(1);
    expect(stored()).toEqual(bound);
  });

  test.each([TOKEN, "null", "[]", "enc1:bad", "enc1a:bad"])(
    "an unreadable credential blocks every binding write: %s", bad => {
      query(db => db.run("UPDATE app_connection SET value = ? WHERE id = ?", [bad, original[1]!.id]));
      const before = stored();
      const res = run("bind");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unreadable credential");
      expect(stored()).toEqual(before);
      expect(existsSync(recovery)).toBe(false);
    });

  test("bind refuses a relabelled bound row instead of re-sealing it", () => {
    expect(run("bind").status).toBe(0);
    const before = stored();
    // A writer who moved a bound row's labels must not be able to launder the
    // rearrangement by running the conversion again.
    query(db => db.run("UPDATE app_connection SET piece_name = ? WHERE id = ?",
      ["fixture-relabelled", identities()[0]!.id]));
    const res = run("bind");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unreadable credential");
    expect(stored()).toEqual(before);
  });

  test("an existing recovery file blocks binding without overwriting it", () => {
    writeFileSync(recovery, "retained binding recovery fixture");
    expect(run("bind").status).toBe(1);
    expect(stored()).toEqual(original);
    expect(readFileSync(recovery, "utf8")).toBe("retained binding recovery fixture");
  });

  test("a wrong key never binds or changes a credential", () => {
    writeFileSync(keyFile, Buffer.alloc(32, 22).toString("hex"));
    expect(run("bind").status).toBe(1);
    expect(stored()).toEqual(original);
    expect(existsSync(recovery)).toBe(false);
  });

  test.each(["updated", "deleted"])("rollback-binding refuses a credential %s since binding", change => {
    expect(run("bind").status).toBe(0);
    const id = original[0]!.id;
    query(db => change === "deleted"
      ? db.run("DELETE FROM app_connection WHERE id = ?", [id])
      : db.run("UPDATE app_connection SET value = ? WHERE id = ?", ["{\"secret\":\"new-fixture\"}", id]));
    const changed = stored();
    expect(run("rollback-binding").status).toBe(1);
    expect(stored()).toEqual(changed);
  });

  test("rollback-binding refuses a tampered journal or a different database", () => {
    expect(run("bind").status).toBe(0);
    const bound = stored();
    const oldPath = dbPath;
    const differentPath = join(dir, "different.db");
    query(db => db.run("VACUUM INTO ?", [differentPath]));
    dbPath = differentPath;
    expect(run("rollback-binding").status).toBe(1);
    dbPath = oldPath;
    expect(stored()).toEqual(bound);
    const bytes = readFileSync(recovery, "utf8");
    writeFileSync(recovery, bytes.slice(0, 10) + "!" + bytes.slice(11));
    expect(run("rollback-binding").status).toBe(1);
    expect(stored()).toEqual(bound);
  });

  test("the binding journal and the #473 journal do not accept each other", () => {
    expect(run("bind").status).toBe(0);
    const bound = stored();
    // `rollback` reads a `jarvis-native-credentials-v1` record; the binding
    // journal is a different format and must be refused, not half-applied.
    expect(run("rollback").status).toBe(1);
    expect(stored()).toEqual(bound);
    expect(run("rollback-binding").status).toBe(0);
    expect(stored()).toEqual(original);
    // And the reverse: a v1 journal is not a binding journal.
    rmSync(recovery);
    expect(run("apply").status).toBe(0);
    const applied = stored();
    expect(run("rollback-binding").status).toBe(1);
    expect(stored()).toEqual(applied);
  });

  test("a held daemon lock blocks binding writes", () => {
    const lock = acquireLockAt(lockPathFor(dir), process.pid);
    expect(lock).not.toBeNull();
    try {
      for (const mode of ["bind", "rollback-binding"] as const) {
        const res = run(mode);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("Daemon or maintenance task is running");
      }
      expect(stored()).toEqual(original);
    } finally { lock?.release(); }
  });
});

describe("strict credential encryption gate", () => {
  test("refuses to enable while a readable plaintext row remains", () => {
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(() => enableStrictCredentialEncryption(getWorkflowDb()))
      .toThrow(/2 plaintext credential row\(s\) remain/);
    // A refused enable leaves the gate exactly where it was.
    expect(requireEncryptedCredentials()).toBe(false);
    expect(getConnection(original[0]!.id)?.value).toBeTruthy();
  });

  test("enables once the conversion reports no legacy rows", () => {
    expect(run("bind").status).toBe(0);
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(enableStrictCredentialEncryption(getWorkflowDb())).toEqual({ legacy: 0 });
    expect(requireEncryptedCredentials()).toBe(true);
    const id = identities()[0]!.id;
    expect(getConnection(id)?.value).toBeTruthy();
    // With the gate closed, swapping a ciphertext for attacker plaintext is
    // refused instead of believed.
    getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?",
      [JSON.stringify({ access_token: "synthetic-attacker-plaintext" }), id]);
    expect(() => getConnection(id)).toThrow(/plaintext credential refused/);
  });

  test("a refusal never downgrades an already-strict daemon", () => {
    expect(run("bind").status).toBe(0);
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    enableStrictCredentialEncryption(getWorkflowDb());
    // An attacker who can write the table can make legacy > 0 again. That
    // must not be a way to turn the gate back off.
    getWorkflowDb().run("UPDATE app_connection SET value = ? WHERE id = ?",
      [JSON.stringify({ access_token: "synthetic-downgrade-attempt" }), identities()[0]!.id]);
    expect(() => enableStrictCredentialEncryption(getWorkflowDb())).toThrow(/plaintext credential row/);
    expect(requireEncryptedCredentials()).toBe(true);
  });

  test("the #473 conversion alone is enough to close the gate", () => {
    // `apply` leaves unbound `enc1:` rows. Strict mode is about the absence of
    // an envelope, so those still read and the gate can still close.
    expect(run("apply").status).toBe(0);
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(enableStrictCredentialEncryption(getWorkflowDb())).toEqual({ legacy: 0 });
    for (const row of identities()) expect(getConnection(row.id)?.value).toBeTruthy();
  });

  test.each([
    ["no variable", {}, false],
    ["an unrecognised value", { JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS: "true" }, false],
    ["the opt-in", { JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS: "1" }, true],
  ] as const)("the boot setting reads %s", (_label, env, expected) => {
    expect(run("bind").status).toBe(0);
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(applyStrictCredentialEncryptionSetting(getWorkflowDb(), env)).toBe(expected);
    expect(requireEncryptedCredentials()).toBe(expected);
  });

  test("the boot setting propagates the refusal, so startup fails on a false assertion", () => {
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(() => applyStrictCredentialEncryptionSetting(getWorkflowDb(),
      { JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS: "1" })).toThrow(/plaintext credential row/);
    expect(requireEncryptedCredentials()).toBe(false);
  });

  test("an invalid legacy row does not block the gate forever", () => {
    expect(run("bind").status).toBe(0);
    const id = identities()[0]!.id;
    query(db => db.run("UPDATE app_connection SET value = ? WHERE id = ?", ["not-json-at-all", id]));
    setEncryptionKey(KEY);
    initWorkflowDb(dbPath);
    expect(inventoryNativeCredentials(getWorkflowDb())).toMatchObject({ legacy: 0, invalidLegacy: 1 });
    expect(enableStrictCredentialEncryption(getWorkflowDb())).toEqual({ legacy: 0 });
  });
});
