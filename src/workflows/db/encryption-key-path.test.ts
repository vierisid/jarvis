/**
 * Where the workflow encryption key lives, and how it gets there.
 *
 * The key used to be pinned to `~/.jarvis/cache/workflow-encryption.key`: a
 * directory `jarvis export` excludes as ephemeral, that the docs tell people
 * to delete, and that ignored JARVIS_HOME entirely. These tests pin the
 * data-dir-root resolution, the one-time relocation off the old path, and the
 * crash window in the middle of that relocation.
 *
 * Reading the real `~/.jarvis`. One candidate path is derived from
 * `homedir()`, and Bun snapshots `$HOME` at process start -- mutating
 * `process.env.HOME` inside a test does NOT move it. So every scenario that
 * needs a virgin home directory runs in a subprocess with `HOME` set
 * (`inFakeHome` below); the in-process tests always create the file they
 * expect to win, so a key in the developer's real `~/.jarvis/cache` can
 * neither be read nor be relied on being absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KEY_FILE_NAME,
  decryptJson,
  encryptJson,
  hasResolvableEncryptionKey,
  keyFileCandidates,
  migrateWorkflowEncryptionKey,
  migrateWorkflowEncryptionKeyToDataDir,
  persistKeyFile,
  resolveKeyFile,
  rivalKeyWarning,
  setEncryptionKey,
  workflowKeyTarget,
} from "./encryption";

/**
 * The round trips below go through the unbound `encryptJson`/`decryptJson`
 * pair on purpose: these tests are about WHICH key file is in use, and that
 * pair needs no row identity (it is what the migration's recovery journal
 * uses). Credential rows themselves are row-bound; that is
 * encryption.test.ts's subject, not this file's.
 */

/** Obviously-fake 32-byte keys, written out as the file format stores them. */
const KEY_OLD = "a".repeat(64);
const KEY_NEW = "b".repeat(64);

const ENV_KEYS = [
  "JARVIS_HOME",
  "JARVIS_SECRETS_DIR",
  "JARVIS_WORKFLOW_ENCRYPTION_KEY",
  "JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE",
  // #514's markers: a suite run from the assistant's shell inherits them.
  "JARVIS_MODEL_EXEC",
  "JARVIS_MODEL_EXEC_ENV_KEY",
] as const;

const MODULE = join(import.meta.dir, "encryption.ts");

/**
 * The subprocess tests each pay a cold `bun -e` start. That is ~150ms on a dev
 * box but does not reliably fit bun's 5s default on a loaded shared runner,
 * the same reasoning as scripts/rotate-encryption-key.test.ts.
 */
const SUBPROCESS_TIMEOUT_MS = 30_000;

let root: string;
let fakeHome: string;
let dataDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-wf-keypath-"));
  fakeHome = join(root, "home");
  dataDir = join(root, "data");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  setEncryptionKey(null);
});

afterEach(() => {
  setEncryptionKey(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  rmSync(root, { recursive: true, force: true });
});

function legacyCachePath(dir: string): string {
  return join(dir, "cache", KEY_FILE_NAME);
}

function writeKey(path: string, hex: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${hex}\n`, { mode: 0o600 });
}

function readKey(path: string): string {
  return readFileSync(path, "utf8").trim();
}

/**
 * Run `body` in a subprocess whose HOME is `fakeHome`, so `homedir()` -- and
 * therefore the `~/.jarvis/cache` candidate -- points inside the throwaway
 * tree. `body` is a function body with `key` bound to the module namespace;
 * whatever it returns comes back parsed.
 */
function inFakeHome<T>(body: string, env: Record<string, string> = {}): T {
  const code =
    `const key = await import(${JSON.stringify(MODULE)});\n`
    + `const result = await (async () => { ${body} })();\n`
    + `console.log("__RESULT__" + JSON.stringify(result ?? null));\n`;
  const proc = Bun.spawnSync(["bun", "-e", code], {
    env: { PATH: process.env.PATH ?? "", HOME: fakeHome, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const marker = stdout.indexOf("__RESULT__");
  if (proc.exitCode !== 0 || marker === -1) {
    throw new Error(`subprocess failed (${proc.exitCode}):\n${stdout}\n${proc.stderr.toString()}`);
  }
  return JSON.parse(stdout.slice(marker + "__RESULT__".length).trim()) as T;
}

describe("workflow encryption key path", () => {
  test("resolves to the data-dir ROOT under JARVIS_HOME, not to cache/ and not to ~/.jarvis", () => {
    const target = join(dataDir, KEY_FILE_NAME);
    writeKey(target, KEY_NEW);
    writeKey(legacyCachePath(dataDir), KEY_OLD);
    process.env.JARVIS_HOME = dataDir;

    expect(workflowKeyTarget()).toBe(target);
    expect(resolveKeyFile()).toBe(target);
    expect(readKey(resolveKeyFile())).toBe(KEY_NEW);
  });

  test("honours JARVIS_SECRETS_DIR over JARVIS_HOME, the same as .secrets.key", () => {
    const secretsDir = join(root, "secrets");
    writeKey(join(secretsDir, KEY_FILE_NAME), KEY_NEW);
    process.env.JARVIS_HOME = dataDir;
    process.env.JARVIS_SECRETS_DIR = secretsDir;

    expect(workflowKeyTarget()).toBe(join(secretsDir, KEY_FILE_NAME));
    expect(resolveKeyFile()).toBe(join(secretsDir, KEY_FILE_NAME));
  });

  test("falls back to ~/.jarvis when neither dir var is set", () => {
    expect(inFakeHome<string>("return key.workflowKeyTarget();")).toBe(
      join(fakeHome, ".jarvis", KEY_FILE_NAME),
    );
  }, SUBPROCESS_TIMEOUT_MS);

  test("candidate order is root, then own cache/, then the shared ~/.jarvis/cache", () => {
    process.env.JARVIS_HOME = dataDir;
    expect(
      inFakeHome<string[]>("return key.keyFileCandidates();", { JARVIS_HOME: dataDir }),
    ).toEqual([
      join(dataDir, KEY_FILE_NAME),
      legacyCachePath(dataDir),
      legacyCachePath(join(fakeHome, ".jarvis")),
    ]);
    // Same list in-process, modulo the real home in the last slot.
    expect(keyFileCandidates()[0]).toBe(join(dataDir, KEY_FILE_NAME));
    expect(keyFileCandidates()[1]).toBe(legacyCachePath(dataDir));
  }, SUBPROCESS_TIMEOUT_MS);

  test("generating a first key writes the data-dir root at 0600 and creates no cache/", () => {
    const generated = inFakeHome<{ blob: string; file: string; mode: number; cache: boolean }>(
      `const blob = key.encryptJson({ token: "SENTINEL_FIRST_RUN_VALUE" });
       const file = key.resolveKeyFile();
       const fs = await import("node:fs");
       return { blob, file, mode: fs.statSync(file).mode & 0o777, cache: fs.existsSync(${JSON.stringify(join(dataDir, "cache"))}) };`,
      { JARVIS_HOME: dataDir },
    );
    expect(generated.file).toBe(join(dataDir, KEY_FILE_NAME));
    expect(generated.mode).toBe(0o600);
    expect(generated.cache).toBe(false);

    // The generated key is the one actually in use: decrypt the subprocess's
    // blob here, through the file it left behind.
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = generated.file;
    expect(decryptJson(generated.blob)).toEqual({ token: "SENTINEL_FIRST_RUN_VALUE" });
  }, SUBPROCESS_TIMEOUT_MS);

  test("a key still in cache/ is READ, and merely reading it never moves it", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    writeKey(legacy, KEY_OLD);

    expect(resolveKeyFile()).toBe(legacy);
    expect(hasResolvableEncryptionKey()).toBe(true);
    // Round-trip through the resolved key, then assert nothing relocated: a
    // CLI or a script that merely reads a credential must not move the store.
    const blob = encryptJson({ token: "SENTINEL_LEGACY_PATH_VALUE" });
    setEncryptionKey(null);
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_LEGACY_PATH_VALUE" });
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  });

  test("a JARVIS_HOME install finds the pre-JARVIS_HOME key under ~/.jarvis/cache", () => {
    const shared = legacyCachePath(join(fakeHome, ".jarvis"));
    writeKey(shared, KEY_OLD);
    expect(
      inFakeHome<string>("return key.resolveKeyFile();", { JARVIS_HOME: dataDir }),
    ).toBe(shared);
  }, SUBPROCESS_TIMEOUT_MS);

  test("JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE still wins over every candidate", () => {
    const explicit = join(root, "mounted", "key");
    writeKey(explicit, KEY_NEW);
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_OLD);
    process.env.JARVIS_HOME = dataDir;
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = explicit;
    expect(resolveKeyFile()).toBe(explicit);
  });
});

describe("relocating the key into the data dir", () => {
  test("MOVES cache/ -> data-dir root, byte-identical, 0600, old file gone", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    writeKey(legacy, KEY_OLD);

    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(true);

    const target = join(dataDir, KEY_FILE_NAME);
    expect(readKey(target)).toBe(KEY_OLD);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(existsSync(legacy)).toBe(false);
    expect(resolveKeyFile()).toBe(target);
  });

  test("COPIES the shared ~/.jarvis/cache key into a JARVIS_HOME data dir, leaving it for the other instances", () => {
    const shared = legacyCachePath(join(fakeHome, ".jarvis"));
    writeKey(shared, KEY_OLD);
    const other = join(root, "tenant8");

    const first = inFakeHome<boolean>("return key.migrateWorkflowEncryptionKeyToDataDir();", {
      JARVIS_HOME: dataDir,
    });
    expect(first).toBe(true);
    expect(readKey(join(dataDir, KEY_FILE_NAME))).toBe(KEY_OLD);
    // Every JARVIS_HOME instance on a host reads that one shared file today,
    // so moving it would break the next instance to boot.
    expect(readKey(shared)).toBe(KEY_OLD);

    const second = inFakeHome<boolean>("return key.migrateWorkflowEncryptionKeyToDataDir();", {
      JARVIS_HOME: other,
    });
    expect(second).toBe(true);
    expect(readKey(join(other, KEY_FILE_NAME))).toBe(KEY_OLD);
  }, SUBPROCESS_TIMEOUT_MS);

  test("interrupted right before the old file is removed: a readable key at BOTH paths, never neither", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    const target = join(dataDir, KEY_FILE_NAME);
    writeKey(legacy, KEY_OLD);

    expect(() =>
      migrateWorkflowEncryptionKey(legacy, target, {
        _hooks: {
          beforeRemovingOld: () => {
            throw new Error("simulated crash mid-relocation");
          },
        },
      }),
    ).toThrow("simulated crash mid-relocation");

    // The crash window holds two copies of the SAME key, so the next boot
    // cannot tell an interrupted relocation from a finished one.
    expect(readKey(legacy)).toBe(KEY_OLD);
    expect(readKey(target)).toBe(KEY_OLD);
    expect(resolveKeyFile()).toBe(target);
    expect(rivalKeyWarning()).toBeNull();

    // The next boot is a no-op (the target is already in place) and the
    // orphaned old file is harmless: the key in use is still the same one.
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(false);
    expect(readKey(resolveKeyFile())).toBe(KEY_OLD);

    // And with the target lost instead, the relocation still completes.
    rmSync(target, { force: true });
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(true);
    expect(readKey(target)).toBe(KEY_OLD);
    expect(existsSync(legacy)).toBe(false);
  });

  test("leaves no half-written target when the source is not a key", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    writeKey(legacy, "not-a-key");
    expect(() => migrateWorkflowEncryptionKeyToDataDir()).toThrow(/malformed/);
    expect(readKey(legacy)).toBe("not-a-key");
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  });

  test("both paths populated and DIFFERENT: the root wins and relocation refuses to overwrite it", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    const target = join(dataDir, KEY_FILE_NAME);
    writeKey(legacy, KEY_OLD);
    writeKey(target, KEY_NEW);

    expect(resolveKeyFile()).toBe(target);
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(false);
    expect(migrateWorkflowEncryptionKey(legacy, target)).toBe(false);
    expect(readKey(target)).toBe(KEY_NEW);
    expect(readKey(legacy)).toBe(KEY_OLD);

    const warning = rivalKeyWarning();
    expect(warning).toContain(target);
    expect(warning).toContain(legacy);
    // The warning names paths, never key bytes.
    expect(warning).not.toContain(KEY_OLD);
    expect(warning).not.toContain(KEY_NEW);
  });

  test("a different key in the SHARED ~/.jarvis/cache is not reported as a rival", () => {
    // Steady state on a multi-instance host: every instance has its own root
    // key, the shared legacy file is somebody else's. Warning about it every
    // boot would train operators to ignore the one warning that matters.
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_NEW);
    writeKey(legacyCachePath(join(fakeHome, ".jarvis")), KEY_OLD);
    expect(
      inFakeHome<string | null>("return key.rivalKeyWarning();", { JARVIS_HOME: dataDir }),
    ).toBeNull();
  }, SUBPROCESS_TIMEOUT_MS);

  test("no-op when an explicit key source is configured", () => {
    process.env.JARVIS_HOME = dataDir;
    const legacy = legacyCachePath(dataDir);
    writeKey(legacy, KEY_OLD);

    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY = KEY_NEW;
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(false);
    delete process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY;

    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = legacy;
    expect(migrateWorkflowEncryptionKeyToDataDir()).toBe(false);
    delete process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE;

    expect(readKey(legacy)).toBe(KEY_OLD);
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  });

  test("no-op when there is no key anywhere", () => {
    expect(
      inFakeHome<boolean>("return key.migrateWorkflowEncryptionKeyToDataDir();", {
        JARVIS_HOME: dataDir,
      }),
    ).toBe(false);
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  }, SUBPROCESS_TIMEOUT_MS);
});


// #514: a daemon started from a command the assistant ran is marked
// JARVIS_MODEL_EXEC=1 by modelExecEnv, and additionally
// JARVIS_MODEL_EXEC_ENV_KEY=1 when the daemon that ran it held
// JARVIS_WORKFLOW_ENCRYPTION_KEY in its env. Only the second may refuse to
// generate a key: there "no key" means "stripped", and a key minted here would
// split credentials from the env key. See util/model-exec-marker.ts.
describe("a daemon started from the assistant's shell", () => {
  const MARKED = { JARVIS_MODEL_EXEC: "1" };
  const ENV_KEY_FLAGGED = { JARVIS_MODEL_EXEC: "1", JARVIS_MODEL_EXEC_ENV_KEY: "1" };

  /** encryptJson in a fake home; the error text or null, and whether a key file now exists. */
  const firstSave = (env: Record<string, string>) => inFakeHome<{ error: string | null; wrote: boolean }>(
    `let error = null;
     try { key.encryptJson({ token: "x" }); } catch (e) { error = String(e.message); }
     return { error, wrote: (await import("node:fs")).existsSync(key.workflowKeyTarget()) };`,
    env,
  );

  test("whose parent held the key in its env: refuses to GENERATE one, and writes nothing", () => {
    const outcome = firstSave({ JARVIS_HOME: dataDir, ...ENV_KEY_FLAGGED });
    expect(outcome.error).toContain("Refusing to generate a workflow encryption key");
    expect(outcome.error).toContain("JARVIS_MODEL_EXEC_ENV_KEY=1");
    expect(outcome.wrote).toBe(false);
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  }, SUBPROCESS_TIMEOUT_MS);

  test("whose parent held the key in its env: still READS an existing key file", () => {
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_NEW);
    const blob = inFakeHome<string>(
      `return key.encryptJson({ token: "SENTINEL_MODEL_EXEC_READ" });`,
      { JARVIS_HOME: dataDir, ...ENV_KEY_FLAGGED },
    );
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = join(dataDir, KEY_FILE_NAME);
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_MODEL_EXEC_READ" });
  }, SUBPROCESS_TIMEOUT_MS);

  test("whose parent held the key in its env: uses the key when it is passed back in", () => {
    const blob = inFakeHome<string>(
      `return key.encryptJson({ token: "SENTINEL_MODEL_EXEC_ENV" });`,
      { JARVIS_HOME: dataDir, ...ENV_KEY_FLAGGED, JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY_OLD },
    );
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY = KEY_OLD;
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_MODEL_EXEC_ENV" });
  }, SUBPROCESS_TIMEOUT_MS);

  // A file-key install is marked but not flagged, and must keep generating:
  // each of these is something a model may legitimately run.
  test("of a file-key install, after `rm -rf ~/.jarvis && jarvis restart`: generates", () => {
    expect(firstSave({ JARVIS_HOME: dataDir, ...MARKED })).toEqual({ error: null, wrote: true });
  }, SUBPROCESS_TIMEOUT_MS);

  test("of a file-key install, as a second instance under another JARVIS_HOME: generates its own", () => {
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_NEW); // the first instance's
    const second = join(root, "second");
    expect(firstSave({ JARVIS_HOME: second, ...MARKED })).toEqual({ error: null, wrote: true });
    expect(readKey(join(second, KEY_FILE_NAME))).not.toBe(KEY_NEW);
    expect(readKey(join(dataDir, KEY_FILE_NAME))).toBe(KEY_NEW);
  }, SUBPROCESS_TIMEOUT_MS);

  test("of a file-key install, with a fresh JARVIS_SECRETS_DIR: generates there", () => {
    const secrets = join(root, "fresh-secrets");
    expect(firstSave({ JARVIS_HOME: dataDir, JARVIS_SECRETS_DIR: secrets, ...MARKED })).toEqual({ error: null, wrote: true });
    expect(existsSync(join(secrets, KEY_FILE_NAME))).toBe(true);
  }, SUBPROCESS_TIMEOUT_MS);

  test("a flag value other than exactly 1 is not the flag", () => {
    expect(firstSave({ JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1", JARVIS_MODEL_EXEC_ENV_KEY: "0" }))
      .toEqual({ error: null, wrote: true });
  }, SUBPROCESS_TIMEOUT_MS);
});

// The restore flow the boot-time key write of an earlier #514 draft broke:
// `jarvis restore` onto a fresh install whose JARVIS_SECRETS_DIR differs from
// the data dir puts the archive's key in the data dir and moves it to the
// secrets dir -- which only works if booting the fresh install did not already
// put a key there. Boot runs the relocation and the stored-credentials check;
// neither may create a key.
describe("restoring onto a fresh install that has already booted", () => {
  test("the restored key reaches the secrets dir, and restored credentials decrypt", () => {
    const secrets = join(root, "secrets");
    const env = { JARVIS_HOME: dataDir, JARVIS_SECRETS_DIR: secrets };
    // What the archive carried: a credential encrypted under KEY_OLD.
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY = KEY_OLD;
    const restoredBlob = encryptJson({ token: "SENTINEL_RESTORED" });
    delete process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY;
    setEncryptionKey(null);

    const booted = inFakeHome<{ resolvable: boolean; wrote: boolean }>(
      `key.migrateWorkflowEncryptionKeyToDataDir();
       return { resolvable: key.hasResolvableEncryptionKey(), wrote: (await import("node:fs")).existsSync(key.workflowKeyTarget()) };`,
      env,
    );
    expect(booted).toEqual({ resolvable: false, wrote: false });

    // backup.ts: the archive's key lands in the data dir, then moves.
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_OLD);
    const moved = inFakeHome<boolean>(
      `return key.migrateWorkflowEncryptionKey(${JSON.stringify(join(dataDir, KEY_FILE_NAME))}, key.workflowKeyTarget());`,
      env,
    );
    expect(moved).toBe(true);
    const decrypted = inFakeHome<unknown>(`return key.decryptJson(${JSON.stringify(restoredBlob)});`, env);
    expect(decrypted).toEqual({ token: "SENTINEL_RESTORED" });
  }, SUBPROCESS_TIMEOUT_MS);
});

// The test above exercises the encryption module's side; this pins the
// daemon's. Boot takes exactly the relocation from encryption.ts -- nothing
// that reaches getKey() (encryptJson, a boot-time key write) -- so booting a
// fresh install cannot plant a key that a later restore then cannot replace.
// Key generation reached indirectly through another module is not covered.
test("daemon boot imports only the key relocation from encryption.ts", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "daemon", "index.ts"), "utf8");
  const named = [...src.matchAll(/(?:import|const)\s*\{([^}]*)\}\s*(?:from|=\s*await\s+import\()\s*['"][^'"]*workflows\/db\/encryption(?:\.ts)?['"]/g)]
    .flatMap(m => m[1]!.split(",").map(n => n.trim().split(/\s+as\s+/)[0]!).filter(Boolean));
  expect(named).toEqual(["migrateWorkflowEncryptionKeyToDataDir"]);
  // And no namespace, default or whole-module binding that would hide what is used.
  const hidden = [
    /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]*workflows\/db\/encryption/,
    /(?:const|let|var)\s+\w+\s*=\s*await\s+import\(\s*['"][^'"]*workflows\/db\/encryption/,
  ].map(re => re.test(src));
  expect(hidden).toEqual([false, false]);
});

// Two first boots sharing a secrets dir must end up on ONE key. Before, each
// wrote `<key>.tmp` with O_TRUNC and renamed it into place: the last rename
// won on disk while the loser had already cached and used its own key.
describe("creating the key file is create-if-absent", () => {
  test("a fresh path is created with 0600 and no temp file left behind", () => {
    const path = join(dataDir, KEY_FILE_NAME);
    expect(persistKeyFile(path, KEY_NEW)).toEqual({ created: true, hex: KEY_NEW });
    expect(readKey(path)).toBe(KEY_NEW);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDir)).toEqual([KEY_FILE_NAME]);
  });

  test("an existing key is adopted, never overwritten", () => {
    const path = join(dataDir, KEY_FILE_NAME);
    writeKey(path, KEY_OLD);
    expect(persistKeyFile(path, KEY_NEW)).toEqual({ created: false, hex: KEY_OLD });
    expect(readKey(path)).toBe(KEY_OLD);
    expect(readdirSync(dataDir)).toEqual([KEY_FILE_NAME]);
  });

  test("a corrupt existing file is refused, never adopted or overwritten", () => {
    const path = join(dataDir, KEY_FILE_NAME);
    writeFileSync(path, "not-a-key\n", { mode: 0o600 });
    expect(() => persistKeyFile(path, KEY_NEW)).toThrow(/malformed/);
    expect(readFileSync(path, "utf8")).toBe("not-a-key\n");
  });

  test("without hard links (vfat, SMB, ReFS) it creates the target exclusively instead", () => {
    const noLinks = () => { throw Object.assign(new Error("link: not supported"), { code: "ENOTSUP" }); };
    const path = join(dataDir, KEY_FILE_NAME);
    expect(persistKeyFile(path, KEY_NEW, noLinks)).toEqual({ created: true, hex: KEY_NEW });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(persistKeyFile(path, KEY_OLD, noLinks)).toEqual({ created: false, hex: KEY_NEW });
    expect(readdirSync(dataDir)).toEqual([KEY_FILE_NAME]);
  });

  test("temps left by a dead writer are removed; a live writer's are not", () => {
    const dead = Bun.spawnSync(["true"]).pid; // exited, so its pid is free
    const stale = `${KEY_FILE_NAME}.${dead}.0123456789ab.tmp`;
    const live = `${KEY_FILE_NAME}.${process.pid}.ba9876543210.tmp`;
    writeKey(join(dataDir, stale), KEY_OLD);
    writeKey(join(dataDir, live), KEY_OLD);
    persistKeyFile(join(dataDir, KEY_FILE_NAME), KEY_NEW);
    expect(readdirSync(dataDir).sort()).toEqual([KEY_FILE_NAME, live].sort());
  });

  test("a migration that loses the race to another writer leaves both keys alone", () => {
    const from = join(dataDir, "cache", KEY_FILE_NAME);
    const to = join(dataDir, KEY_FILE_NAME);
    writeKey(from, KEY_OLD);
    // `to` appears after migrate's existence check, before its copy.
    const moved = migrateWorkflowEncryptionKey(from, to, { _hooks: { beforeCopy: () => writeKey(to, KEY_NEW) } });
    expect(moved).toBe(false);
    expect(readKey(from)).toBe(KEY_OLD);
    expect(readKey(to)).toBe(KEY_NEW);
  });

  test("concurrent first saves in separate processes all use the key on disk", async () => {
    const env = { PATH: process.env.PATH ?? "", HOME: fakeHome, JARVIS_HOME: dataDir };
    const code =
      `const key = await import(${JSON.stringify(MODULE)});\n`
      + `console.log("__RESULT__" + JSON.stringify(key.encryptJson({ token: "SENTINEL_RACE" })));\n`;
    const procs = Array.from({ length: 6 }, () => Bun.spawn(["bun", "-e", code], { env, stdout: "pipe", stderr: "pipe" }));
    const blobs = await Promise.all(procs.map(async p => {
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return JSON.parse(out.slice(out.indexOf("__RESULT__") + "__RESULT__".length).trim()) as string;
    }));
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = join(dataDir, KEY_FILE_NAME);
    for (const blob of blobs) expect(decryptJson(blob)).toEqual({ token: "SENTINEL_RACE" });
    expect(readdirSync(dataDir).filter(f => f.endsWith(".tmp"))).toEqual([]);
  }, SUBPROCESS_TIMEOUT_MS);
});
