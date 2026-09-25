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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// #514: a daemon started from a command the assistant ran (run_command's
// modelExecEnv marks it JARVIS_MODEL_EXEC=1) has no JARVIS_WORKFLOW_ENCRYPTION_KEY
// even when the user's daemon did. Minting a key there would split
// credentials across two keys. See util/model-exec-marker.ts.
describe("a daemon started from the assistant's shell", () => {
  test("refuses to GENERATE a key, and writes nothing", () => {
    const outcome = inFakeHome<{ error: string | null; wrote: boolean }>(
      `let error = null;
       try { key.encryptJson({ token: "x" }); } catch (e) { error = String(e.message); }
       const fs = await import("node:fs");
       return { error, wrote: fs.existsSync(key.workflowKeyTarget()) };`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1" },
    );
    expect(outcome.error).toContain("Refusing to generate a workflow encryption key");
    expect(outcome.error).toContain("JARVIS_MODEL_EXEC=1");
    expect(outcome.wrote).toBe(false);
    expect(existsSync(join(dataDir, KEY_FILE_NAME))).toBe(false);
  }, SUBPROCESS_TIMEOUT_MS);

  test("still READS an existing key file", () => {
    writeKey(join(dataDir, KEY_FILE_NAME), KEY_NEW);
    const blob = inFakeHome<string>(
      `return key.encryptJson({ token: "SENTINEL_MODEL_EXEC_READ" });`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1" },
    );
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = join(dataDir, KEY_FILE_NAME);
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_MODEL_EXEC_READ" });
  }, SUBPROCESS_TIMEOUT_MS);

  test("still uses an env key it was given", () => {
    const blob = inFakeHome<string>(
      `return key.encryptJson({ token: "SENTINEL_MODEL_EXEC_ENV" });`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1", JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY_OLD },
    );
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY = KEY_OLD;
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_MODEL_EXEC_ENV" });
  }, SUBPROCESS_TIMEOUT_MS);

  test("any other value of the marker is the normal first run: a key is generated", () => {
    const wrote = inFakeHome<boolean>(
      `key.encryptJson({ token: "x" });
       return (await import("node:fs")).existsSync(key.workflowKeyTarget());`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "0" },
    );
    expect(wrote).toBe(true);
  }, SUBPROCESS_TIMEOUT_MS);
});

// #514: the refusal above is only sound if a normally started daemon without
// an env key has already written its key file -- otherwise a fresh install
// that has not saved a credential yet looks exactly like an env-key user.
describe("the key file is created at boot", () => {
  test("by an unmarked daemon with no key anywhere, once", () => {
    const outcome = inFakeHome<{ first: boolean; second: boolean; exists: boolean }>(
      `const first = key.ensureWorkflowEncryptionKeyAtBoot();
       const second = key.ensureWorkflowEncryptionKeyAtBoot();
       return { first, second, exists: (await import("node:fs")).existsSync(key.workflowKeyTarget()) };`,
      { JARVIS_HOME: dataDir },
    );
    expect(outcome).toEqual({ first: true, second: false, exists: true });
  }, SUBPROCESS_TIMEOUT_MS);

  test("then a marked daemon restarted from the assistant's shell reads it and can save", () => {
    inFakeHome<boolean>(`return key.ensureWorkflowEncryptionKeyAtBoot();`, { JARVIS_HOME: dataDir });
    const blob = inFakeHome<string>(
      `return key.encryptJson({ token: "SENTINEL_AFTER_BOOT_KEY" });`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1" },
    );
    process.env.JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE = join(dataDir, KEY_FILE_NAME);
    expect(decryptJson(blob)).toEqual({ token: "SENTINEL_AFTER_BOOT_KEY" });
  }, SUBPROCESS_TIMEOUT_MS);

  test("not when an env key is set: no file the env key would shadow", () => {
    const outcome = inFakeHome<{ created: boolean; exists: boolean }>(
      `const created = key.ensureWorkflowEncryptionKeyAtBoot();
       return { created, exists: (await import("node:fs")).existsSync(key.workflowKeyTarget()) };`,
      { JARVIS_HOME: dataDir, JARVIS_WORKFLOW_ENCRYPTION_KEY: KEY_OLD },
    );
    expect(outcome).toEqual({ created: false, exists: false });
  }, SUBPROCESS_TIMEOUT_MS);

  test("not under the marker", () => {
    const outcome = inFakeHome<{ created: boolean; exists: boolean }>(
      `const created = key.ensureWorkflowEncryptionKeyAtBoot();
       return { created, exists: (await import("node:fs")).existsSync(key.workflowKeyTarget()) };`,
      { JARVIS_HOME: dataDir, JARVIS_MODEL_EXEC: "1" },
    );
    expect(outcome).toEqual({ created: false, exists: false });
  }, SUBPROCESS_TIMEOUT_MS);
});
