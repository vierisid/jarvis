#!/usr/bin/env bun
/**
 * Rotate the at-rest encryption key used for `app_connection.value`.
 *
 * Envelopes are preserved, not normalized: a row-bound `enc1a:` row is
 * re-sealed row-bound under the new key, an `enc1:` or legacy plaintext row
 * is re-sealed as `enc1:`. Rotation must never be the thing that drops a
 * row binding.
 *
 *   bun run scripts/rotate-encryption-key.ts [--data-dir <path>]
 *
 * Steps:
 *   1. Read the current key from `<data-dir>/workflow-encryption.key` (or
 *      `--key-file`). An install this brain has not booted yet still has it
 *      under `cache/`; the shared resolver in `src/workflows/db/encryption.ts`
 *      finds it there too, and rotation writes the new key back to whichever
 *      path it read -- the daemon relocates it to the root at next boot.
 *   2. Decrypt every `app_connection.value` row with the current key.
 *   3. Generate a fresh 32-byte key, persist to `<keyfile>.new` with 0600.
 *   4. Re-encrypt every row with the new key inside one DB transaction.
 *   5. Atomically rename `<keyfile>.new` over `<keyfile>`.
 *
 * Crash safety:
 *   - Crash before step 4 commit: nothing on disk has changed. Rerun.
 *   - Crash between step 4 commit and step 5 rename: rows already encrypted
 *     with the new key, keychain still has the old one. The next daemon
 *     start would fail decryption on those rows. The script detects a
 *     leftover `<keyfile>.new` at the start of the next run and refuses to
 *     proceed, prompting the operator to either:
 *       - `mv <keyfile>.new <keyfile>` (rotation reached commit, complete it), or
 *       - `rm <keyfile>.new` (rotation didn't reach commit, discard).
 *     The choice depends on whether the post-commit logging finished or not.
 *
 * Pre-conditions:
 *   - `JARVIS_WORKFLOW_ENCRYPTION_KEY` env var must be unset. With the env
 *     var set, that value IS the key -- you'd rotate by changing the env
 *     and restarting, not by running this script.
 *   - The daemon must be stopped. The script doesn't grab a lock; running
 *     it against a live daemon could race UPDATEs with in-flight connection
 *     writes.
 */

import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  decryptBoundJson,
  encryptBoundJson,
  encryptJson,
  isRowBound,
  resolveKeyFile,
  setEncryptionKey,
  type CredentialRowBinding,
} from "../src/workflows/db/encryption";
import { isLocked, lockPathFor } from "../src/daemon/pid";

interface CliArgs {
  dataDir: string;
  keyFile: string;
  dbPath: string;
}

function parseArgs(): CliArgs {
  const defaultDataDir = resolve(process.env["JARVIS_HOME"] || resolve(homedir(), ".jarvis"));
  let dataDir = defaultDataDir;
  let scopedToDataDir = false;
  let keyFile: string | null = null;
  let dbPath: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") {
      dataDir = resolve(argv[++i]!);
      scopedToDataDir = true;
    } else if (a === "--key-file") keyFile = resolve(argv[++i]!);
    else if (a === "--db") dbPath = resolve(argv[++i]!);
    else if (a === "--allow-running-daemon") {
      // Already consumed before parseArgs; recognized here so it doesn't error.
    } else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: bun run scripts/rotate-encryption-key.ts [options]",
          "",
          "Options:",
          "  --data-dir <path>   Override the Jarvis data dir (default JARVIS_HOME or ~/.jarvis)",
          "  --key-file <path>   Override the keychain file path",
          "  --db <path>         Override the SQLite DB path",
          "",
          "Pre-conditions:",
          "  - Daemon must be stopped.",
          "  - JARVIS_WORKFLOW_ENCRYPTION_KEY must be unset.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return {
    dataDir,
    // Resolved through the same helper the daemon uses, so this script and a
    // JARVIS_HOME install cannot disagree about where the key is. An explicit
    // `--data-dir` scopes the search to that dir (plus the shared legacy
    // path); without one, the module's own resolution applies, which also
    // honours JARVIS_SECRETS_DIR.
    keyFile: keyFile ?? (scopedToDataDir ? resolveKeyFile(dataDir) : resolveKeyFile()),
    dbPath: dbPath ?? resolve(dataDir, "jarvis.db"),
  };
}

function loadKeyOrExit(path: string): Buffer {
  if (!existsSync(path)) {
    console.error(`No keychain at ${path}; nothing to rotate.`);
    process.exit(0);
  }
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error(`Keychain at ${path} is malformed (need 64 hex chars; got ${hex.length}).`);
    process.exit(1);
  }
  return Buffer.from(hex, "hex");
}

interface ConnectionRow {
  id: string;
  project_id: string;
  piece_name: string;
  external_id: string;
  value: string;
}

function bindingFor(row: ConnectionRow): CredentialRowBinding {
  return { id: row.id, projectId: row.project_id, pieceName: row.piece_name, externalId: row.external_id };
}

async function main(): Promise<void> {
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"]) {
    console.error(
      [
        "JARVIS_WORKFLOW_ENCRYPTION_KEY is set in the environment. That env var",
        "IS the key -- rotate by changing it (and restarting the daemon) rather",
        "than running this script. Unset it first if you want to switch to a",
        "file-based keychain.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const args = parseArgs();
  const newKeyFile = `${args.keyFile}.new`;

  // Refuse to run while the daemon is alive. The daemon caches the
  // encryption key in memory and would happily keep writing new
  // app_connection rows with the OLD key while we re-encrypt the existing
  // set with the NEW key -- those new rows would then be unreadable after
  // the atomic rename. The flock check probes the pid lock for the
  // *resolved* data dir so a `--data-dir` override checks the right file
  // (not just the default `~/.jarvis/jarvis.pid`). Override the safety with
  // `--allow-running-daemon` only if you've manually quiesced writes.
  const allowRunningDaemon = process.argv.includes("--allow-running-daemon");
  if (!allowRunningDaemon) {
    const runningPid = isLocked(lockPathFor(args.dataDir));
    if (runningPid !== null) {
      console.error(
        [
          `Daemon is running (PID ${runningPid}) against ${args.dataDir}.`,
          "Stop it before rotating:",
          "  jarvis stop",
          "",
          "Rotating while the daemon writes to app_connection would corrupt",
          "any new rows. To override (you've manually quiesced writes), pass",
          "  --allow-running-daemon",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  if (existsSync(newKeyFile)) {
    console.error(
      [
        `Leftover sidecar file detected: ${newKeyFile}`,
        "A previous rotation crashed between commit and final rename. Resolve manually:",
        `  - Rotation reached DB commit:  mv ${newKeyFile} ${args.keyFile}`,
        `  - Rotation did NOT reach commit: rm ${newKeyFile}`,
        "Then re-run this script if needed.",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (!existsSync(args.dbPath)) {
    console.error(`No DB at ${args.dbPath}; nothing to rotate.`);
    process.exit(0);
  }

  const oldKey = loadKeyOrExit(args.keyFile);

  // 1. Decrypt all rows with the old key.
  setEncryptionKey(oldKey);
  const db = new Database(args.dbPath);
  const rows = db
    .prepare("SELECT id, project_id, piece_name, external_id, value FROM app_connection")
    .all() as ConnectionRow[];
  console.log(`[rotate] DB ${args.dbPath}: ${rows.length} connection(s) to rotate`);

  // Carry each row's envelope forward. Re-wrapping a row-bound `enc1a:` value
  // as unbound `enc1:` would silently undo the row binding, so rotation
  // preserves whichever envelope the row already had. A legacy plaintext row
  // becomes `enc1:`, matching what this script has always done; run
  // `migrate-native-credentials.ts bind` to reach the bound envelope.
  const decrypted: Array<{ id: string; plaintext: unknown; binding: CredentialRowBinding; bound: boolean }> = [];
  for (const row of rows) {
    try {
      const binding = bindingFor(row);
      const plaintext = decryptBoundJson(row.value, binding, `app_connection ${row.id}`);
      decrypted.push({ id: row.id, plaintext, binding, bound: isRowBound(row.value) });
    } catch (e) {
      console.error(`[rotate] FAIL on ${row.id}: ${(e as Error).message}`);
      console.error("[rotate] aborting -- no changes written.");
      db.close();
      process.exit(1);
    }
  }
  console.log(`[rotate] decrypted ${decrypted.length}/${rows.length} rows with current key`);

  // 2. Generate the new key + persist as sidecar.
  const newKey = randomBytes(32);
  mkdirSync(dirname(newKeyFile), { recursive: true });
  writeFileSync(newKeyFile, newKey.toString("hex") + "\n");
  try {
    chmodSync(newKeyFile, 0o600);
  } catch {
    // Best-effort; same fallback as the encryption module's first-run path.
  }
  console.log(`[rotate] new key persisted to ${newKeyFile} (sidecar)`);

  // 3. Swap to the new key + re-encrypt + UPDATE in a transaction.
  setEncryptionKey(newKey);
  const update = db.prepare("UPDATE app_connection SET value = ?, updated = ? WHERE id = ?");
  const now = Date.now();
  const tx = db.transaction((items: typeof decrypted) => {
    for (const { id, plaintext, binding, bound } of items) {
      const ciphertext = bound ? encryptBoundJson(plaintext, binding) : encryptJson(plaintext);
      update.run(ciphertext, now, id);
    }
  });
  try {
    tx(decrypted);
    console.log(`[rotate] re-encrypted + committed ${decrypted.length} row(s) with new key`);
  } catch (e) {
    console.error(`[rotate] FAIL during DB transaction: ${(e as Error).message}`);
    console.error(`[rotate] DB is unchanged. Sidecar ${newKeyFile} can be safely deleted.`);
    db.close();
    process.exit(1);
  }
  db.close();

  // 4. Final atomic rename. From here on the keychain matches the rows.
  renameSync(newKeyFile, args.keyFile);
  console.log(`[rotate] keychain swapped (${args.keyFile})`);
  console.log("[rotate] DONE -- restart the daemon for in-memory key state to refresh.");
}

await main();
