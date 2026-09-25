/**
 * AES-256-GCM at-rest encryption for sensitive `app_connection.value` JSON
 * blobs. Wraps `serialize(value)` so OAuth tokens, API keys, etc. don't sit
 * in the workflow DB as plaintext.
 *
 * Key sourcing, in order:
 *   1. `JARVIS_WORKFLOW_ENCRYPTION_KEY` env var (64-char hex = 32 bytes).
 *   2. `JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE`, an explicit single file.
 *   3. Otherwise `<data dir>/workflow-encryption.key`, where the data dir is
 *      `JARVIS_SECRETS_DIR` or `JARVIS_HOME` when set and `~/.jarvis`
 *      otherwise -- the same resolution `src/vault/keychain.ts` uses for
 *      `.secrets.key`. Generated on first use with 0600 perms and reused on
 *      later boots so existing rows stay decryptable.
 *
 * Why the data-dir ROOT and not `cache/`. Until this moved, the key lived at
 * `~/.jarvis/cache/workflow-encryption.key`: a directory `jarvis export`
 * excludes as ephemeral, that `docs/PIECE_VERIFICATION.md` tells people to
 * delete, and that a plain `rm -rf ~/.jarvis/cache` wipes. A backup of the
 * data dir therefore carried every encrypted credential and nothing that
 * could decrypt them. At the root the key is captured by any data-dir backup
 * as a matter of course, and `jarvis export --full` lists it beside
 * `.secrets.key`. The old path is still READ (see `keyFileCandidates`) and
 * relocated once, at daemon boot, by
 * `migrateWorkflowEncryptionKeyToDataDir()`.
 *
 * Wire formats (stored in `app_connection.value`):
 *   `enc1a:<base64(iv | authTag | ciphertext)>`  -- current. GCM runs with
 *       the row identity as associated data, so the blob only authenticates
 *       against the row it was written for.
 *   `enc1:<base64(iv | authTag | ciphertext)>`   -- readable, no longer
 *       written for credentials. No associated data, so a database writer can
 *       move the blob to another row and it still authenticates. Convert with
 *       `scripts/migrate-native-credentials.ts bind`.
 *
 * Row binding. `enc1:` gave confidentiality but let the storage layer be
 * rearranged: pasting row A's `value` into row B made row B read back as row
 * A's credential, so a writer with no key could point a low-privilege piece
 * at a high-privilege credential. `enc1a:` passes the row's identity tuple
 * (id, project_id, piece_name, external_id) through `setAAD`, which is the
 * primary key plus the `uq_app_connection_external` lookup key. Those four
 * columns are never updated by `upsertConnection`, so binding them costs
 * nothing during normal operation; renaming any of them out of band requires
 * a re-encrypt, which is the intended trade.
 *
 * Backwards-compat: rows written before encryption was added have plain
 * JSON strings (`{...}`). The decrypt helpers pass plain JSON through, so a
 * daemon upgrading in place doesn't lose existing connections. That branch is
 * unauthenticated input, so `setRequireEncryptedCredentials(true)` turns it
 * off once a deployment has converted. It defaults off and must only be
 * enabled through `enableStrictCredentialEncryption`, which refuses while any
 * legacy row is still readable-plaintext.
 *
 * Adding a third envelope means adding its prefix to `ENCRYPTED_PREFIXES` and
 * `ENCRYPTED_VALUE_SQL` below. Callers that ask "is this row encrypted?" must
 * go through `isEncrypted` / `ENCRYPTED_VALUE_SQL` rather than testing one
 * prefix literal, or they go blind to converted rows.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  LEGACY_ENV_KEY_FLAG,
  MODEL_EXEC_ENV_KEY_FLAG,
  hadEnvWorkflowKey,
  matchesParentWorkflowKey,
  parentWorkflowKeyCheck,
} from "../../util/model-exec-marker.ts";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Unbound envelope: still read, never written for credentials. */
const PREFIX = "enc1:";
/** Row-bound envelope: GCM associated data carries the row identity. */
const BOUND_PREFIX = "enc1a:";

/**
 * Every envelope prefix, longest first so prefix tests are unambiguous.
 * `enc1a:` is not an `enc1:` value, so a check written against one literal
 * would miss converted rows.
 */
export const ENCRYPTED_PREFIXES = [BOUND_PREFIX, PREFIX] as const;

/**
 * SQL predicate matching any encrypted envelope in a `value` column. Use this
 * instead of `value LIKE 'enc1:%'` so "does this table hold ciphertext?"
 * questions (missing-key checks, inventories) see both envelopes.
 */
export const ENCRYPTED_VALUE_SQL = "(value LIKE 'enc1:%' OR value LIKE 'enc1a:%')";

/**
 * The four columns an `enc1a:` blob is bound to. `id` is the primary key;
 * `projectId`/`pieceName`/`externalId` are `uq_app_connection_external`, the
 * tuple `getConnectionByExternalId` resolves. None of them are written by
 * `upsertConnection` after insert.
 */
export interface CredentialRowBinding {
  id: string;
  projectId: string;
  pieceName: string;
  externalId: string;
}

/**
 * Canonical associated-data bytes. Length-prefixed per field so no two
 * distinct identity tuples can produce the same buffer (an `externalId` of
 * `"a:b"` must not collide with an `id` boundary).
 */
function associatedData(binding: CredentialRowBinding): Buffer {
  const fields = [binding.id, binding.projectId, binding.pieceName, binding.externalId];
  return Buffer.from(
    "jarvis.app_connection.v1\n"
      + fields.map(field => `${Buffer.byteLength(field, "utf8")}:${field}`).join("\n"),
    "utf8",
  );
}

/**
 * Strict mode. Off by default: releases v0.6.0 through v0.13.7 wrote plaintext
 * rows, so refusing non-prefixed values before a deployment has converted
 * would lock it out of credentials it still needs. Flip it only through
 * `enableStrictCredentialEncryption`, which checks the inventory first.
 */
let strictCredentials = false;

/** Single name at the data-dir root, like `.secrets.key`. */
export const KEY_FILE_NAME = "workflow-encryption.key";

/** Where the key lived before it moved to the data-dir root. */
const LEGACY_SUBDIR = "cache";

let cachedKey: Buffer | null = null;
/** Warn once per process, not once per key resolution. */
let warnedAboutRivalKeys = false;

/** The pre-`JARVIS_HOME` root, used only as the last read fallback. */
function legacyRootDir(): string {
  return join(homedir(), ".jarvis");
}

/**
 * The data dir this install keeps its secrets in, ignoring what is on disk.
 * Deliberately identical to `keychain.ts`'s `configuredDir()`: the workflow
 * key and `.secrets.key` are both local secret material for one install, and
 * two different answers to "which data dir" is how the key ended up outside
 * every backup of the database it protects.
 *
 * `JARVIS_SECRETS_DIR` is honoured as well as `JARVIS_HOME` so a test or an
 * operator has ONE lever that keeps every secret out of the real `~/.jarvis`.
 */
function configuredDir(): string {
  const override = process.env["JARVIS_SECRETS_DIR"] || process.env["JARVIS_HOME"];
  return override ? resolve(override) : legacyRootDir();
}

/**
 * Guard in the spirit of `keychainDir()`'s: under `bun test` (bun sets
 * NODE_ENV=test) with nothing pinned, key resolution lands on the
 * DEVELOPER'S real store. A test file missing its setup would read their real
 * key, or generate one into their live data dir -- where, now that the root
 * takes precedence, it would win over their actual key on the next boot.
 *
 * Scoped to the two operations that touch key MATERIAL (`getKey` and the boot
 * relocation) rather than to path resolution, so computing or reporting a
 * path stays a pure function that never throws. Tests either inject a key
 * with `setEncryptionKey`, or point JARVIS_HOME / JARVIS_SECRETS_DIR at a
 * temp dir.
 */
function assertKeyAccessAllowedUnderTest(): void {
  if (process.env["NODE_ENV"] !== "test") return;
  if (process.env["JARVIS_SECRETS_DIR"] || process.env["JARVIS_HOME"]) return;
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"]) return;
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE"]) return;
  throw new Error(
    "Refusing to touch the real workflow encryption key under test: inject one with "
    + "setEncryptionKey(), or point JARVIS_HOME / JARVIS_SECRETS_DIR at a temp dir in your "
    + "test setup (see src/workflows/db/encryption-key-path.test.ts)",
  );
}

/** Where the key belongs for a given data dir. */
export function workflowKeyTarget(dir: string = configuredDir()): string {
  return join(dir, KEY_FILE_NAME);
}

/**
 * Every path a key may legitimately be found at, most authoritative first:
 *
 *   1. `<dir>/workflow-encryption.key`       -- where it belongs now
 *   2. `<dir>/cache/workflow-encryption.key` -- the old layout, and where
 *      `rotate-encryption-key.ts --data-dir <dir>` used to write
 *   3. `~/.jarvis/cache/workflow-encryption.key` -- the hardcoded pre-
 *      `JARVIS_HOME` path, which is where a `JARVIS_HOME` install's key
 *      actually is today (see #481 item 3)
 */
export function keyFileCandidates(dir: string = configuredDir(), options: { ownOnly?: boolean } = {}): string[] {
  if (options.ownOnly) return ownCandidates(dir);
  return [
    ...ownCandidates(dir),
    join(legacyRootDir(), LEGACY_SUBDIR, KEY_FILE_NAME),
  ].filter((path, index, all) => all.indexOf(path) === index);
}

/**
 * The candidates a key may be USED from: all of them, except under the #514
 * env-key flag, where the shared pre-JARVIS_HOME ~/.jarvis/cache key is
 * another install's, or a leftover, by definition -- this one's key was in an
 * env var. Only getKey and the boot message about where to restore a key use
 * this; export, rotation and restore keep seeing every candidate.
 */
export function usableKeyFileCandidates(dir: string = configuredDir()): string[] {
  return keyFileCandidates(dir, { ownOnly: hadEnvWorkflowKey() });
}

/** The candidates that belong to THIS data dir: the root and its own cache/. */
function ownCandidates(dir: string): string[] {
  return [workflowKeyTarget(dir), join(dir, LEGACY_SUBDIR, KEY_FILE_NAME)];
}

/**
 * The key file actually in use: the explicit override, else the first
 * candidate that exists, else the target (nothing on disk yet -- a first run
 * generates it there).
 *
 * Both paths populated. The target WINS when it exists, because the only
 * thing that ever creates it is a verified migration of the old file or a
 * fresh generation, and the migration refuses to overwrite it. So a target
 * that exists is the newest key this install wrote, and an old file left
 * behind (an interrupted migration, an archive restored in the old layout)
 * is stale by construction. A rival that differs is still worth saying out
 * loud -- picking wrong makes every credential undecryptable, and the
 * operator is the only one who can tell us which database this is. See
 * `rivalKeyWarning`.
 */
export function resolveKeyFile(dir: string = configuredDir(), options: { ownOnly?: boolean } = {}): string {
  const explicit = process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE"];
  if (explicit) return explicit;
  const present = keyFileCandidates(dir, options).filter((path) => existsSync(path));
  if (present.length === 0) return workflowKeyTarget(dir);
  if (!warnedAboutRivalKeys) {
    const warning = rivalKeyWarning(dir);
    if (warning) {
      warnedAboutRivalKeys = true;
      console.warn(warning);
    }
  }
  return present[0]!;
}

/**
 * The warning for "this data dir holds two key files and they are not the
 * same key", or null when there is nothing to say. `resolveKeyFile` emits it
 * once per process; it is a pure function here so the message is testable
 * without depending on whether something earlier already spent that flag.
 *
 * Deliberately scoped to this data dir's OWN two paths. The shared
 * `~/.jarvis/cache` fallback is another install's key by definition once this
 * one has its own, so a difference there is the expected steady state on a
 * multi-instance host, not a problem to report.
 *
 * Says nothing about the key bytes themselves, only which paths disagree.
 */
export function rivalKeyWarning(dir: string = configuredDir()): string | null {
  const [winner, ...rest] = ownCandidates(dir).filter((path) => existsSync(path));
  if (!winner) return null;
  const rivals = rest.filter((path) => readIfKey(path) !== readIfKey(winner));
  if (rivals.length === 0) return null;
  return (
    `[WorkflowEncryption] Using the key at ${winner} and IGNORING a different key at `
    + `${rivals.join(", ")}. If workflow credentials fail to decrypt, the ignored file is `
    + `probably the one that matches this database -- move it to ${winner} (keeping a copy).`
  );
}

/** File contents, or null when unreadable. Never used to make a key. */
function readIfKey(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * True when a key can be produced WITHOUT generating a new one. Pure lookup:
 * it deliberately does not apply the under-test guard, so asking the question
 * is always safe -- only `getKey()` and the boot relocation, which touch key
 * material, refuse.
 */
export function hasResolvableEncryptionKey(): boolean {
  if (cachedKey) return true;
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"]) return true;
  return existsSync(resolveKeyFile());
}

function parseKeyHex(hex: string, path: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Encryption key file ${path} is malformed (expected 64 hex chars; got ${hex.length})`,
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Create `path` holding `hex` with 0600 from the first byte, IF IT IS ABSENT:
 * written to a uniquely named temp sibling, fsynced, then hard-linked into
 * place, and the parent directory fsynced too. A crash can leave a temp file
 * behind but never a truncated or world-readable key, and never a half-written
 * target.
 *
 * Create-if-absent, not rename-over, because two first boots can share a
 * secrets dir (two instances under one JARVIS_SECRETS_DIR, or a restart racing
 * a still-exiting daemon). With a fixed temp name and a rename, both wrote
 * their own key and the last rename won, while the loser had already cached
 * and used its own. `link` fails with EEXIST instead: the loser reads the key
 * on disk and adopts it, so every process ends up on one key. Returns the key
 * actually at `path` and whether this call put it there.
 *
 * Exported for tests.
 */
export function persistKeyFile(
  path: string,
  hex: string,
  /** Test seam: the hard-link call, so a filesystem without links can be simulated. */
  link: (existing: string, created: string) => void = linkSync,
): { created: boolean; hex: string } {
  mkdirSync(dirname(path), { recursive: true });
  removeStaleKeyTemps(path);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeNewKeyFile(tmp, hex);
  try {
    link(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return adoptExistingKey(path);
    // Anything else means no hard link here, and the codes vary by platform
    // (EPERM, ENOTSUP/EOPNOTSUPP, ENOSYS; EISDIR from FAT on Windows): vfat,
    // exFAT, SMB without Unix extensions, ReFS. Create the target itself,
    // exclusively: still create-if-absent, but a crash mid-write can leave a
    // torn key file -- which parseKeyHex rejects loudly on the next read
    // rather than using. A real failure (a read-only or full disk) fails here
    // again, with its own error.
    try {
      writeNewKeyFile(path, hex);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === "EEXIST") return adoptExistingKey(path);
      throw inner;
    }
    fsyncDir(dirname(path));
    return { created: true, hex };
  }
  // A failure here leaves a second link to the key; the next process that
  // reads or writes the key removes it (removeStaleKeyTemps).
  try { unlinkSync(tmp); } catch { /* best effort */ }
  fsyncDir(dirname(path));
  return { created: true, hex };
}

/** Create `path` exclusively with 0600 from the first byte, write `hex`, fsync. */
function writeNewKeyFile(path: string, hex: string): void {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, `${hex}\n`);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* best effort */ }
    throw err;
  }
  closeSync(fd);
  try { chmodSync(path, 0o600); } catch { /* best-effort on Windows / restricted FSes */ }
}

/** Another writer got there first: use its key, never a corrupt one. */
function adoptExistingKey(path: string): { created: false; hex: string } {
  let existing: string;
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch (err) {
    // `existsSync` said no and `link` said EEXIST: a symlink to nothing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(
        `The workflow encryption key path ${path} is a symlink to a missing file (${readlinkSync(path)}). `
        + "Restore the file it points to, or remove the link so a key can be created there.",
      );
    }
    throw err;
  }
  parseKeyHex(existing, path);
  return { created: false, hex: existing };
}

/**
 * Remove `<key>.<pid>.<rand>.tmp` siblings left by a writer that crashed, and
 * an old `<key>.tmp`. Runs before every key write and on the first key read
 * in each process, so a leftover does not outlive the next start.
 * Only those whose pid is gone: a live writer's temp is about to be linked.
 * A crash between link and unlink leaves a second hard link to a key, which a
 * later rotation (a new file renamed over the key) would otherwise keep alive
 * in every data-dir backup. A reused pid only means a leftover stays longer.
 */
function removeStaleKeyTemps(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  // The fixed `<key>.tmp` of releases before #514, left by a crash between
  // write and rename. It never became the key, so nothing was encrypted with
  // it; the age check keeps clear of an older release writing it right now.
  const legacy = join(dir, `${basename(path)}.tmp`);
  try {
    if (Date.now() - statSync(legacy).mtimeMs > 60_000) unlinkSync(legacy);
  } catch { /* absent, or raced */ }
  for (const name of names) {
    const m = name.startsWith(prefix) ? /^(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name.slice(prefix.length)) : null;
    if (!m || isPidAlive(Number(m[1]))) continue;
    try { unlinkSync(join(dir, name)); } catch { /* raced with another cleaner */ }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // alive, not ours
  }
}

/** Make a directory entry (a rename, an unlink) durable. Best-effort. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not every platform allows fsync on a directory handle; the rename is
    // still atomic, so the worst case is losing the ordering guarantee.
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Place one key file at `to` from `from`: copy durably, read the copy back and
 * compare, and only then (unless `keepSource`) remove the original.
 *
 * Crash safety. `to` is created by persistKeyFile (a hard link from a fsynced
 * temp sibling, create-if-absent) and fsynced
 * before `from` is touched, so at every instant a readable key exists at
 * `from`, at `to`, or at both -- never at neither. Both-populated resolves to
 * `to` (same bytes), so an interrupted relocation is indistinguishable from a
 * finished one to the next boot.
 *
 * Refuses when `to` already exists: overwriting it would replace the key this
 * install last wrote with an older one, and every row encrypted since would
 * stop decrypting. Same reasoning as `migrateKeychain`'s `hasKeychain(to)`
 * guard.
 */
export function migrateWorkflowEncryptionKey(
  from: string,
  to: string,
  options: {
    /** Leave the original in place; see the shared-legacy-root case below. */
    keepSource?: boolean;
    /** Test-only fault injection: called after the copy is durable and
     * verified and before the original is removed, so tests can interrupt the
     * one window where two copies exist. Never set in production. */
    _hooks?: { beforeRemovingOld?: () => void; beforeCopy?: () => void };
  } = {},
): boolean {
  if (from === to || !existsSync(from) || existsSync(to)) return false;
  const hex = readFileSync(from, "utf8").trim();
  parseKeyHex(hex, from); // refuse to propagate a corrupt key
  options._hooks?.beforeCopy?.();
  // Lost a race to another writer: `to` is theirs now, so leave `from` alone.
  if (!persistKeyFile(to, hex).created) return false;
  if (readIfKey(to) !== hex) {
    rmSync(to, { force: true });
    throw new Error(`Copying the workflow encryption key to ${to} did not verify; it stays at ${from}`);
  }
  if (options.keepSource) {
    console.log(`[WorkflowEncryption] Copied the workflow encryption key from ${from} to ${to}; backups of the data dir now include it`);
    return true;
  }
  options._hooks?.beforeRemovingOld?.();
  rmSync(from, { force: true });
  fsyncDir(dirname(from));
  console.log(
    `[WorkflowEncryption] Moved the workflow encryption key from ${from} to ${to}; `
    + `backups of the data dir now include it`,
  );
  return true;
}

/**
 * Relocate a key still sitting in `cache/` into the data-dir root.
 *
 * Called once at daemon boot. Deliberately NOT triggered by path resolution,
 * for the same reason `migrateKeychainToDataDir` isn't: a CLI, a test, or any
 * process that merely reads a credential must never move the key out from
 * under the machine it is running on. Resolution reads the old path happily,
 * so nothing depends on this having run.
 *
 * Move within this install's own data dir, COPY out of the shared one. Every
 * `JARVIS_HOME` instance on a host reads the same
 * `~/.jarvis/cache/workflow-encryption.key` today (#481 item 3), so the first
 * instance to boot must not move it: the next instance would come up to a
 * database full of ciphertext and no key. Copying gives each instance its own
 * key at its own root -- backed up with its own data dir -- and leaves the
 * shared file exactly as authoritative as it was for whoever else still
 * reads it.
 */
export function migrateWorkflowEncryptionKeyToDataDir(): boolean {
  // Under the #514 env-key flag, whatever sits in cache/ or the shared
  // ~/.jarvis/cache is not known to be this install's key -- the key was in
  // an env var. Planting it at the root would hand getKey() a key the user's
  // own restart ignores.
  if (hadEnvWorkflowKey()) return false;
  // An explicit key source makes any file on disk irrelevant -- and possibly
  // an unrelated leftover. Moving that to the root would plant a key a later
  // boot (env var gone) would trust.
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"]) return false;
  if (process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE"]) return false;
  assertKeyAccessAllowedUnderTest();
  const dir = configuredDir();
  const target = workflowKeyTarget(dir);
  if (existsSync(target)) return false;
  const own = join(dir, LEGACY_SUBDIR, KEY_FILE_NAME);
  if (existsSync(own)) return migrateWorkflowEncryptionKey(own, target);
  const shared = join(legacyRootDir(), LEGACY_SUBDIR, KEY_FILE_NAME);
  if (shared !== own && existsSync(shared)) {
    return migrateWorkflowEncryptionKey(shared, target, { keepSource: true });
  }
  return false;
}

/**
 * Resolve the encryption key. Cached after first call. If callers want to
 * inject a key (tests, key-rotation tooling), use `setEncryptionKey`.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  assertKeyAccessAllowedUnderTest();
  const env = process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"];
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error(
        "JARVIS_WORKFLOW_ENCRYPTION_KEY must be 64 hex characters (32 bytes); got length " + env.length,
      );
    }
    // A legacy `1` flag cannot vouch for or against an env key; only a check can.
    if (matchesParentWorkflowKey(env) === false) throw parentKeyMismatch("JARVIS_WORKFLOW_ENCRYPTION_KEY here");
    cachedKey = Buffer.from(env, "hex");
    return cachedKey;
  }
  const file = resolveKeyFile(configuredDir(), { ownOnly: hadEnvWorkflowKey() });
  if (existsSync(file)) {
    // Not in an operator's explicitly named directory: not ours to tidy.
    if (!process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE"]) removeStaleKeyTemps(file);
    const hex = readFileSync(file, "utf8").trim();
    const key = parseKeyHex(hex, file);
    // Under the #514 flag an existing file proves nothing -- a leftover,
    // another instance's key -- so it must BE the ancestor's env key.
    if (hadEnvWorkflowKey() && matchesParentWorkflowKey(hex) !== true) throw parentKeyMismatch(`the key file ${file}`);
    cachedKey = key;
    return cachedKey;
  }
  // Nothing anywhere: first run. Generate at the target path with 0600.
  // Callers that must NOT reach this point (a database that already holds
  // `enc1:` rows) assert first -- see `assertEncryptionKeyForStoredCredentials`
  // in src/workflows/db/index.ts.
  //
  // Except where the key was stripped rather than absent (#514): a process
  // descended from a command the assistant ran, whose daemon held
  // JARVIS_WORKFLOW_ENCRYPTION_KEY in its environment (the flag is set by
  // modelExecEnv; see util/model-exec-marker.ts). A key minted here cannot be
  // that key. Installs whose key lives in a file are never flagged and
  // generate as usual.
  if (hadEnvWorkflowKey()) throw parentKeyMismatch(null, file);
  // Adopt whatever is on disk if another first boot got there first.
  const { hex } = persistKeyFile(file, randomBytes(KEY_BYTES).toString("hex"));
  cachedKey = parseKeyHex(hex, file);
  return cachedKey;
}

/**
 * Why a flagged process will not use the key it has (`found`), or has none
 * and will not make one (`found` null). Says what the flag means and the two
 * ways forward, rather than "restart": a second instance or a fresh secrets
 * dir started from the assistant's shell is not fixed by restarting anything.
 */
function parentKeyMismatch(found: string | null, file?: string): Error {
  const legacy = parentWorkflowKeyCheck() === LEGACY_ENV_KEY_FLAG;
  const what = found === null
    ? `this instance has no workflow key (none at ${file}) and will not generate one`
    : legacy
      ? `${found} cannot be checked against it (the flag is an older release's \`1\`, which records no key)`
      : `${found} is a different key`;
  return new Error(
    `Refusing the workflow encryption key: this Jarvis descends from a command the assistant ran, and the `
    + `Jarvis that ran it kept its workflow key in JARVIS_WORKFLOW_ENCRYPTION_KEY (${MODEL_EXEC_ENV_KEY_FLAG} is `
    + `set). ${what[0]!.toUpperCase()}${what.slice(1)}`
    + (found === null ? ": a key made here could not be that key. " : ", so credentials saved with it would not decrypt under that key. ")
    + `Start this Jarvis from your own terminal with JARVIS_WORKFLOW_ENCRYPTION_KEY set to that key, or, if this `
    + `instance is meant to have its own key, unset ${MODEL_EXEC_ENV_KEY_FLAG} deliberately.`,
  );
}

/** Test/tooling override for the cached key. Pass `null` to fall back to env+file resolution. */
export function setEncryptionKey(key: Buffer | null): void {
  cachedKey = key;
}

/**
 * Strict-mode switch. Exported for tests and for the gated enabler in
 * `credential-migration.ts`; production code must go through
 * `enableStrictCredentialEncryption` so the `legacy: 0` check runs.
 */
export function setRequireEncryptedCredentials(required: boolean): void {
  strictCredentials = required;
}

/** Whether non-prefixed (legacy plaintext) values are currently refused. */
export function requireEncryptedCredentials(): boolean {
  return strictCredentials;
}

/**
 * Runs `fn` with the plaintext gate lifted. Offline conversion only: the
 * migration has to read the very plaintext rows strict mode exists to refuse,
 * and it runs with writers stopped.
 */
export function withLegacyPlaintextReads<T>(fn: () => T): T {
  const previous = strictCredentials;
  strictCredentials = false;
  try {
    return fn();
  } finally {
    strictCredentials = previous;
  }
}

function seal(value: unknown, prefix: string, binding: CredentialRowBinding | null): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, getKey(), iv) as CipherGCM;
  if (binding) cipher.setAAD(associatedData(binding));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return prefix + Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Unbound `enc1:` envelope. Not for `app_connection.value` -- use
 * `encryptBoundJson` there. This remains for payloads that have no row
 * identity, i.e. the migration's recovery journal.
 */
export function encryptJson(value: unknown): string {
  return seal(value, PREFIX, null);
}

/**
 * Row-bound `enc1a:` envelope. The blob authenticates only against
 * `binding`, so moving it to another row fails the GCM tag.
 */
export function encryptBoundJson(value: unknown, binding: CredentialRowBinding): string {
  return seal(value, BOUND_PREFIX, binding);
}

/**
 * Decrypts an `enc1:`/`enc1a:` blob, or pass-through for legacy plain JSON.
 * Throws on malformed encrypted blobs (corruption / wrong key / wrong row).
 *
 * `context` is woven into thrown error messages so production debugging
 * (which connection / file is corrupt?) doesn't have to guess. Callers
 * supply the relevant identifier; defaults to a generic "stored value".
 *
 * Error granularity. The thrown messages distinguish four causes so the
 * rotation script + operators can act differently per row:
 *
 *   - "plaintext credential refused (strict encryption is enabled)": the
 *     value carries no envelope prefix and strict mode is on. No crypto ran.
 *   - "malformed ciphertext (likely corrupted row)": wire-format issue --
 *     base64 fails to decode, or the decoded buffer is shorter than
 *     `iv | authTag`. Means the row was truncated / mangled at rest, not
 *     a key mismatch.
 *   - "auth verification failed (likely wrong key, wrong row or tampered
 *     ciphertext)": wire format is valid, but GCM auth refuses the
 *     (key, iv, tag, aad, ct) tuple. Almost always wrong key when seen
 *     across many rows; a single row means tampering, or an `enc1a:` blob
 *     read under an identity it was not written for.
 *   - "decrypted bytes are not valid JSON": auth passed but the plaintext
 *     can't be parsed. Implies the data was encrypted with an out-of-band
 *     producer or the JSON wrapper changed.
 */
export function decryptJson(stored: string, context = "stored value"): unknown {
  if (stored.startsWith(BOUND_PREFIX)) {
    // Refuse rather than fall through to an AAD-less open, which would fail
    // the tag anyway but report it as a key problem.
    throw new Error(`${context}: row-bound ciphertext requires its row identity to decrypt`);
  }
  return open(stored, null, context);
}

/**
 * Decrypts a stored `app_connection.value` under its row identity. Accepts
 * all three shapes a converting table can hold: `enc1a:` (checked against
 * `binding`), `enc1:` (no associated data) and legacy plaintext (unless
 * strict mode refuses it).
 */
export function decryptBoundJson(
  stored: string,
  binding: CredentialRowBinding,
  context = "stored value",
): unknown {
  return open(stored, binding, context);
}

function open(stored: string, binding: CredentialRowBinding | null, context: string): unknown {
  const bound = stored.startsWith(BOUND_PREFIX);
  if (!bound && !stored.startsWith(PREFIX)) {
    if (strictCredentials) {
      // Unauthenticated input is no longer an accepted shape here. Say so
      // without quoting the value.
      throw new Error(`${context}: plaintext credential refused (strict encryption is enabled)`);
    }
    try {
      return JSON.parse(stored);
    } catch {
      // JSON parser messages can contain input snippets, including secrets.
      throw new Error(`${context}: legacy plaintext is not valid JSON`);
    }
  }
  // Sanity-check the wire format before touching crypto. A failure here is
  // unambiguously row corruption, not a wrong-key situation: AES-GCM's auth
  // step never even gets to run.
  const prefix = bound ? BOUND_PREFIX : PREFIX;
  let buf: Buffer;
  try {
    buf = Buffer.from(stored.slice(prefix.length), "base64");
  } catch (e) {
    throw new Error(
      `${context}: malformed ciphertext (likely corrupted row): base64 decode failed: ${(e as Error).message}`,
    );
  }
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `${context}: malformed ciphertext (likely corrupted row): blob is ${buf.length} bytes, need at least ${IV_BYTES + TAG_BYTES} for iv+authTag`,
    );
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, getKey(), iv) as DecipherGCM;
  // An `enc1a:` blob only opens under the identity it was sealed for. An
  // `enc1:` blob has no associated data, whatever row it now sits in.
  if (bound) {
    if (!binding) {
      throw new Error(`${context}: row-bound ciphertext requires its row identity to decrypt`);
    }
    decipher.setAAD(associatedData(binding));
  }
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(
      `${context}: auth verification failed (likely wrong key, wrong row or tampered ciphertext): ${(e as Error).message}`,
    );
  }
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error(`${context}: decrypted bytes are not valid JSON`);
  }
}

/** True for any encrypted envelope. Predicate exposed for tests + scripts. */
export function isEncrypted(stored: string): boolean {
  return ENCRYPTED_PREFIXES.some(prefix => stored.startsWith(prefix));
}

/** True only for the row-bound `enc1a:` envelope. */
export function isRowBound(stored: string): boolean {
  return stored.startsWith(BOUND_PREFIX);
}
