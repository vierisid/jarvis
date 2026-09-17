/**
 * AES-256-GCM at-rest encryption for sensitive `app_connection.value` JSON
 * blobs. Wraps `serialize(value)` so OAuth tokens, API keys, etc. don't sit
 * in the workflow DB as plaintext.
 *
 * Key sourcing:
 *   1. `JARVIS_WORKFLOW_ENCRYPTION_KEY` env var (64-char hex = 32 bytes).
 *   2. Otherwise: generate a fresh random key on first call and persist it
 *      to `~/.jarvis/cache/workflow-encryption.key` with 0600 perms. Same
 *      file is reused on subsequent boots so existing rows stay decryptable.
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
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

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

const DEFAULT_KEY_FILE = resolve(homedir(), ".jarvis", "cache", "workflow-encryption.key");

let cachedKey: Buffer | null = null;

/**
 * Resolve the encryption key. Cached after first call. If callers want to
 * inject a key (tests, key-rotation tooling), use `setEncryptionKey`.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY"];
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error(
        "JARVIS_WORKFLOW_ENCRYPTION_KEY must be 64 hex characters (32 bytes); got length " + env.length,
      );
    }
    cachedKey = Buffer.from(env, "hex");
    return cachedKey;
  }
  const file = process.env["JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE"] ?? DEFAULT_KEY_FILE;
  if (existsSync(file)) {
    const hex = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `Encryption key file ${file} is malformed (expected 64 hex chars; got ${hex.length})`,
      );
    }
    cachedKey = Buffer.from(hex, "hex");
    return cachedKey;
  }
  // Generate + persist with 0600 perms.
  const fresh = randomBytes(KEY_BYTES);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fresh.toString("hex") + "\n");
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on Windows / restricted FSes
  }
  cachedKey = fresh;
  return cachedKey;
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
