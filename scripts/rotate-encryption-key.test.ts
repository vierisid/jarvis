/**
 * End-to-end coverage for the rotation script. Spawns the script as a
 * subprocess against a temp data dir + DB, verifies:
 *   - Rows decrypt fine with the post-rotation keychain.
 *   - Rows DON'T decrypt with the pre-rotation key (regression for
 *     "rotation didn't actually re-encrypt anything").
 *   - The keychain file is replaced atomically (no leftover `.new`).
 *   - Refuses to run when JARVIS_WORKFLOW_ENCRYPTION_KEY is set.
 *   - Refuses to run when a `.new` sidecar exists (crash-recovery branch).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson, setEncryptionKey } from "../src/workflows/db/encryption";
import { initWorkflowDb, closeWorkflowDb } from "../src/workflows/db/index";
import { createSchema } from "../src/workflows/db/schema";

const SCRIPT = resolve(import.meta.dir, "rotate-encryption-key.ts");

let dataDir: string;
let keyFile: string;
let dbPath: string;
let originalKey: Buffer;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "jarvis-rotate-"));
  keyFile = join(dataDir, "cache", "workflow-encryption.key");
  dbPath = join(dataDir, "jarvis.db");
  mkdirSync(join(dataDir, "cache"), { recursive: true });

  originalKey = randomBytes(32);
  writeFileSync(keyFile, originalKey.toString("hex") + "\n");

  // Build a real schema'd DB at the temp path and seed two connections.
  initWorkflowDb(dbPath);
  setEncryptionKey(originalKey);
  // Reuse the singleton -- two connections to the same file under WAL
  // sometimes trips bun:sqlite's parameter validation.
  const { getWorkflowDb } = require("../src/workflows/db/index") as typeof import("../src/workflows/db/index");
  const db = getWorkflowDb();
  const now = Date.now();
  // Minimal columns -- everything required by NOT NULL + the value column we'll rotate.
  for (const { id, value } of [
    { id: "conn_a", value: { access_token: "secret-a", refresh_token: "rt-a" } },
    { id: "conn_b", value: { api_key: "secret-b" } },
  ]) {
    db.run(
      `INSERT INTO app_connection (
        id, external_id, display_name, type, scope, status, piece_name, piece_version,
        project_id, owner_id, value, metadata, pre_select_for_new_projects, created, updated
      ) VALUES (?, ?, ?, ?, 'PROJECT', 'ACTIVE', 'piece', '0.0.0',
        'jrv_proj_default', NULL, ?, NULL, 0, ?, ?)`,
      [id, id, `name-${id}`, "OAUTH2", encryptJson(value), now, now],
    );
  }
  closeWorkflowDb();
  // Reset in-memory key state so the spawned script doesn't inherit it.
  setEncryptionKey(null);
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
  rmSync(dataDir, { recursive: true, force: true });
});

function runScript(opts: {
  env?: Record<string, string | undefined>;
  /**
   * Pass `--allow-running-daemon` to bypass the flock check. Default false.
   * The rotation script now probes the lock at `<dataDir>/jarvis.pid` (not
   * the global `~/.jarvis/jarvis.pid`), so tests are naturally isolated
   * from whatever daemon happens to be running on the dev machine.
   */
  allowDaemon?: boolean;
} = {}): {
  status: number;
  stderr: string;
  stdout: string;
} {
  const env = { ...process.env, ...opts.env };
  // The script reads JARVIS_WORKFLOW_ENCRYPTION_KEY from env -- clear it
  // unless the test explicitly wants it set.
  if (!opts.env || !("JARVIS_WORKFLOW_ENCRYPTION_KEY" in opts.env)) {
    delete env["JARVIS_WORKFLOW_ENCRYPTION_KEY"];
  }
  const allowDaemon = opts.allowDaemon ?? false;
  const args = ["run", SCRIPT, "--data-dir", dataDir, "--key-file", keyFile, "--db", dbPath];
  if (allowDaemon) args.push("--allow-running-daemon");
  const res = spawnSync("bun", args, { env, stdio: "pipe", encoding: "utf8" });
  return { status: res.status ?? -1, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

describe("rotate-encryption-key", () => {
  test("rotation re-encrypts rows + swaps the keychain", () => {
    const res = runScript();
    expect(res.status).toBe(0);

    // New keychain present, sidecar gone.
    expect(existsSync(keyFile)).toBe(true);
    expect(existsSync(`${keyFile}.new`)).toBe(false);
    const newHex = readFileSync(keyFile, "utf8").trim();
    expect(newHex.length).toBe(64);
    expect(newHex).not.toBe(originalKey.toString("hex"));

    // Rows decrypt with the new key.
    const newKey = Buffer.from(newHex, "hex");
    setEncryptionKey(newKey);
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT id, value FROM app_connection ORDER BY id").all() as Array<{
      id: string;
      value: string;
    }>;
    const aValue = decryptJson(rows[0]!.value, "conn_a") as { access_token: string };
    const bValue = decryptJson(rows[1]!.value, "conn_b") as { api_key: string };
    expect(aValue.access_token).toBe("secret-a");
    expect(bValue.api_key).toBe("secret-b");
    db.close();

    // Rows DON'T decrypt with the original key (regression: rotation must
    // actually rotate, not just generate a new file and leave rows alone).
    setEncryptionKey(originalKey);
    const db2 = new Database(dbPath);
    const row = db2
      .prepare("SELECT value FROM app_connection WHERE id = 'conn_a'")
      .get() as { value: string };
    expect(() => decryptJson(row.value, "conn_a")).toThrow();
    db2.close();
  });

  test("refuses to run when a daemon currently holds the pid lock for the same data dir", async () => {
    // Acquire a flock at the *test data dir's* pid path -- that's what the
    // rotation script probes when invoked with `--data-dir <tempDir>`. This
    // simulates "a daemon is running against this data dir" without
    // colliding with a real daemon on the dev machine running against the
    // default `~/.jarvis`.
    const { acquireLockAt, lockPathFor } = await import("../src/daemon/pid");
    const handle = acquireLockAt(lockPathFor(dataDir), process.pid);
    if (!handle) throw new Error("could not acquire lock at test data dir");
    try {
      const res = runScript({ allowDaemon: false });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Daemon is running/);
      // Keychain unchanged.
      expect(readFileSync(keyFile, "utf8").trim()).toBe(originalKey.toString("hex"));
    } finally {
      handle.release();
    }
  });

  test("--allow-running-daemon bypasses the lock check", async () => {
    const { acquireLockAt, lockPathFor } = await import("../src/daemon/pid");
    const handle = acquireLockAt(lockPathFor(dataDir), process.pid);
    if (!handle) throw new Error("could not acquire lock at test data dir");
    try {
      const res = runScript({ allowDaemon: true });
      expect(res.status).toBe(0);
      expect(readFileSync(keyFile, "utf8").trim()).not.toBe(originalKey.toString("hex"));
    } finally {
      handle.release();
    }
  });

  test("ignores a daemon holding the default lock when --data-dir points elsewhere", async () => {
    // Regression: previously the script called isLocked() without honoring
    // --data-dir, so a daemon running against `~/.jarvis` blocked rotations
    // for arbitrary other data dirs. Now isLocked is probed at
    // <dataDir>/jarvis.pid, so a default-path daemon doesn't interfere.
    // We don't try to grab the default lock here (the dev machine's daemon
    // may already hold it); we just assert the test's tempDir-scoped run
    // completes without daemon-error output.
    const res = runScript({ allowDaemon: false });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/Daemon is running/);
  });

  test("refuses to run when JARVIS_WORKFLOW_ENCRYPTION_KEY is set", () => {
    const res = runScript({
      env: { JARVIS_WORKFLOW_ENCRYPTION_KEY: originalKey.toString("hex") },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/JARVIS_WORKFLOW_ENCRYPTION_KEY/);
    // Keychain unchanged.
    expect(readFileSync(keyFile, "utf8").trim()).toBe(originalKey.toString("hex"));
  });

  test("refuses to run when a `.new` sidecar already exists", () => {
    writeFileSync(`${keyFile}.new`, randomBytes(32).toString("hex") + "\n");
    const res = runScript();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/sidecar/i);
    // Keychain unchanged.
    expect(readFileSync(keyFile, "utf8").trim()).toBe(originalKey.toString("hex"));
  });

  test("noop when no keychain exists", () => {
    rmSync(keyFile);
    const res = runScript();
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/nothing to rotate/i);
  });
});
