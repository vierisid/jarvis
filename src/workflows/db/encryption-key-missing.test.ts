/**
 * A database full of `enc1:` rows and no key to read them with must stop the
 * boot, not quietly mint a new key.
 *
 * Before this, `getKey()` generated a fresh random key whenever the file was
 * absent. The daemon came up clean, the dashboard looked fine, and the first
 * credential write re-encrypted a row with a key that could not read any of
 * the existing ones -- destroying the last copy of the ciphertext. The only
 * signal was a piece failing to authenticate, days later, long after the
 * backup holding the real key had rotated away.
 *
 * Also covers the upgrade path: an install whose key is still in `cache/`
 * must survive the relocation with its rows intact and no manual step.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  MissingEncryptionKeyError,
  assertEncryptionKeyForStoredCredentials,
  closeWorkflowDb,
  ensureWorkflowSchema,
  getWorkflowDb,
  initWorkflowDb,
} from "./index";
import {
  KEY_FILE_NAME,
  encryptBoundJson,
  isEncrypted,
  migrateWorkflowEncryptionKeyToDataDir,
  setEncryptionKey,
} from "./encryption";
import { getConnection, upsertConnection } from "./repos/app-connection";

/** Obviously fake: 32 bytes of 0xA1, written out as the file format stores it. */
const KEY = Buffer.alloc(32, 0xa1);
const KEY_HEX = KEY.toString("hex");
const TOKEN = "SENTINEL_WORKFLOW_CREDENTIAL_VALUE";

const ENV_KEYS = [
  "JARVIS_HOME",
  "JARVIS_SECRETS_DIR",
  "JARVIS_WORKFLOW_ENCRYPTION_KEY",
  "JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE",
] as const;

let root: string;
let dataDir: string;
let dbPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-wf-keymissing-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, "jarvis.db");
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.JARVIS_HOME = dataDir;
  setEncryptionKey(null);
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeKey(path: string, hex = KEY_HEX): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${hex}\n`, { mode: 0o600 });
}

/** A database holding one encrypted connection, built with KEY explicitly. */
function seedEncryptedConnection(): string {
  initWorkflowDb(dbPath);
  setEncryptionKey(KEY);
  const created = upsertConnection({
    externalId: "sentinel-connection",
    displayName: "Sentinel",
    type: "SECRET_TEXT",
    pieceName: "sentinel-piece",
    pieceVersion: "1.0.0",
    value: { secret: TOKEN },
  });
  const stored = getWorkflowDb()
    .query<{ value: string }, [string]>("SELECT value FROM app_connection WHERE id = ?")
    .get(created.id)!.value;
  // Whichever envelope this brain writes -- `enc1a:` today -- counts.
  expect(isEncrypted(stored)).toBe(true);
  setEncryptionKey(null);
  return created.id;
}

/** Point resolution at a path that does not exist, so no key is resolvable. */
function noKeyAnywhere(): void {
  process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = join(root, "gone", KEY_FILE_NAME);
}

describe("missing workflow encryption key", () => {
  test("ensureWorkflowSchema REFUSES to continue when encrypted rows have no key", () => {
    seedEncryptedConnection();
    noKeyAnywhere();

    let error: unknown;
    try {
      ensureWorkflowSchema();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MissingEncryptionKeyError);
    const message = (error as Error).message;
    expect(message).toContain("1 workflow connection(s)");
    expect(message).toContain(KEY_FILE_NAME);
    expect(message).toContain("JARVIS_WORKFLOW_ENCRYPTION_KEY");
    // A key it could not read must not be replaced by one it invented.
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
    expect(readdirSync(dataDir).filter((n) => n.includes("encryption"))).toEqual([]);
  });

  test("the refusal never quotes the credential it is protecting", () => {
    seedEncryptedConnection();
    noKeyAnywhere();
    let message: string | null = null;
    try {
      ensureWorkflowSchema();
    } catch (e) {
      message = (e as Error).message;
    }
    // Without this the "no secret in the message" assertions below would hold
    // vacuously for an empty message.
    expect(message).not.toBeNull();
    expect(message).toContain("Refusing to start");
    // Both sentinels are single bare tokens, so an interpolation of either
    // would land in the message whole rather than being truncated.
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(KEY_HEX);
  });

  test("a first boot with no connections at all still comes up", () => {
    // No key, no rows: nothing to lose, so nothing to refuse. Where the key
    // then gets generated is pinned in encryption-key-path.test.ts.
    initWorkflowDb(dbPath);
    noKeyAnywhere();
    expect(() => ensureWorkflowSchema()).not.toThrow();
  });

  test("legacy plaintext rows are not a reason to refuse: they need no key", () => {
    initWorkflowDb(dbPath);
    const now = Date.now();
    getWorkflowDb().run(
      `INSERT INTO app_connection
         (id, external_id, display_name, type, scope, status, piece_name, piece_version,
          project_id, owner_id, value, metadata, pre_select_for_new_projects, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, ?, ?)`,
      [
        "legacy-1", "legacy-ext", "Legacy", "SECRET_TEXT", "PROJECT", "ACTIVE",
        "legacy-piece", "1.0.0", "jrv_proj_default",
        JSON.stringify({ secret: TOKEN }), now, now,
      ],
    );
    noKeyAnywhere();
    expect(() => assertEncryptionKeyForStoredCredentials(getWorkflowDb())).not.toThrow();
  });

  test("an encrypted row with the key present is not a reason to refuse", () => {
    seedEncryptedConnection();
    writeKey(join(dataDir, KEY_FILE_NAME));
    expect(() => ensureWorkflowSchema()).not.toThrow();
  });
});

describe("upgrade path: key in cache/, rows already encrypted", () => {
  test("boot relocates the key and every row still decrypts, with no manual step", () => {
    const id = seedEncryptedConnection();
    // The install as it is today: key under the disposable cache dir.
    const legacy = join(dataDir, "cache", KEY_FILE_NAME);
    writeKey(legacy);
    closeWorkflowDb();

    // Boot, in the daemon's order: relocate, then the schema check.
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(true);
    initWorkflowDb(dbPath);
    expect(() => ensureWorkflowSchema()).not.toThrow();

    const target = join(dataDir, KEY_FILE_NAME);
    expect(readFileSync(target, "utf8").trim()).toBe(KEY_HEX);
    expect(existsSync(legacy)).toBe(false);

    // The point of the whole exercise: the credential is still readable, and
    // through the relocated file rather than an injected key.
    setEncryptionKey(null);
    expect(getConnection(id)?.value).toEqual({ secret: TOKEN });
  });

  test("a data dir carrying only encrypted rows and NO key stops the boot instead of generating one", () => {
    const id = seedEncryptedConnection();
    closeWorkflowDb();

    // A virgin HOME, so the shared ~/.jarvis/cache candidate cannot rescue it
    // and no key exists anywhere this install can see.
    const fakeHome = join(root, "home");
    mkdirSync(fakeHome, { recursive: true });
    const code =
      `const db = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});\n`
      + `db.initWorkflowDb(${JSON.stringify(dbPath)});\n`
      + `let name = "none";\n`
      + `try { db.ensureWorkflowSchema(); } catch (e) { name = e.constructor.name; }\n`
      + `const fs = await import("node:fs");\n`
      + `console.log("__RESULT__" + JSON.stringify({ name, files: fs.readdirSync(${JSON.stringify(dataDir)}).sort() }));\n`;
    const proc = Bun.spawnSync(["bun", "-e", code], {
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome, JARVIS_HOME: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    const marker = stdout.indexOf("__RESULT__");
    expect(marker).toBeGreaterThanOrEqual(0);
    const result = JSON.parse(stdout.slice(marker + "__RESULT__".length).trim()) as {
      name: string;
      files: string[];
    };
    expect(result.name).toBe("MissingEncryptionKeyError");
    expect(result.files).not.toContain(KEY_FILE_NAME);

    // And the ciphertext is untouched, so restoring the real key still works.
    writeKey(join(dataDir, KEY_FILE_NAME));
    initWorkflowDb(dbPath);
    ensureWorkflowSchema();
    setEncryptionKey(null);
    expect(getConnection(id)?.value).toEqual({ secret: TOKEN });
  }, 30_000);
});

describe("the database the assert reads", () => {
  /** A bare table with just the column the predicate looks at. */
  function valueTable(values: string[]): Database {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE app_connection (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    values.forEach((value, i) => {
      db.run("INSERT INTO app_connection (id, value) VALUES (?, ?)", [`row-${i}`, value]);
    });
    return db;
  }

  test("plaintext-only rows need no key", () => {
    noKeyAnywhere();
    const db = valueTable([JSON.stringify({ secret: TOKEN }), "not even json"]);
    try {
      expect(() => assertEncryptionKeyForStoredCredentials(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("BOTH envelopes are counted, so a converted table is not invisible", () => {
    noKeyAnywhere();
    // The row-binding conversion rewrites every `enc1:` row as `enc1a:`. A
    // check written against one prefix literal would see a converted table as
    // empty and happily mint a key over it, which is the exact failure the
    // shared ENCRYPTED_VALUE_SQL predicate exists to prevent.
    for (const envelope of ["enc1:cGF5bG9hZA==", "enc1a:cGF5bG9hZA=="]) {
      const db = valueTable([envelope]);
      try {
        expect(() => assertEncryptionKeyForStoredCredentials(db)).toThrow(MissingEncryptionKeyError);
      } finally {
        db.close();
      }
    }
  });

  test("a real row-bound row is counted", () => {
    setEncryptionKey(KEY);
    const bound = encryptBoundJson(
      { secret: TOKEN },
      { id: "row-0", projectId: "p", pieceName: "piece", externalId: "e" },
    );
    setEncryptionKey(null);
    noKeyAnywhere();
    const db = valueTable([bound]);
    try {
      expect(() => assertEncryptionKeyForStoredCredentials(db)).toThrow(MissingEncryptionKeyError);
    } finally {
      db.close();
    }
  });
});
