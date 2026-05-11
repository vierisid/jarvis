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
 * Wire format (stored in `app_connection.value`):
 *   `enc1:<base64(iv ‖ authTag ‖ ciphertext)>`
 *
 * Backwards-compat: rows written before encryption was added have plain
 * JSON strings (`{...}`). `decryptJson` recognises the `enc1:` prefix and
 * passes plain JSON through, so a daemon upgrading in place doesn't lose
 * existing connections.
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
const PREFIX = "enc1:";

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

export function encryptJson(value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, getKey(), iv) as CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypts an `enc1:`-prefixed blob, or pass-through for legacy plain JSON.
 * Throws on malformed encrypted blobs (corruption / wrong key).
 *
 * `context` is woven into thrown error messages so production debugging
 * (which connection / file is corrupt?) doesn't have to guess. Callers
 * supply the relevant identifier; defaults to a generic "stored value".
 *
 * Error granularity. The thrown messages distinguish three causes so the
 * rotation script + operators can act differently per row:
 *
 *   - "malformed ciphertext (likely corrupted row)": wire-format issue --
 *     base64 fails to decode, or the decoded buffer is shorter than
 *     `iv ‖ authTag`. Means the row was truncated / mangled at rest, not
 *     a key mismatch.
 *   - "auth verification failed (likely wrong key or tampered ciphertext)":
 *     wire format is valid, but GCM auth refuses the (key, iv, tag, ct)
 *     tuple. Almost always wrong key when seen across many rows; almost
 *     always tampering when seen on a single row.
 *   - "decrypted bytes are not valid JSON": auth passed but the plaintext
 *     can't be parsed. Implies the data was encrypted with an out-of-band
 *     producer or the JSON wrapper changed.
 */
export function decryptJson(stored: string, context = "stored value"): unknown {
  if (!stored.startsWith(PREFIX)) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      throw new Error(
        `${context}: legacy plaintext is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  // Sanity-check the wire format before touching crypto. A failure here is
  // unambiguously row corruption, not a wrong-key situation: AES-GCM's auth
  // step never even gets to run.
  let buf: Buffer;
  try {
    buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  } catch (e) {
    throw new Error(
      `${context}: malformed ciphertext (likely corrupted row): base64 decode failed: ${(e as Error).message}`,
    );
  }
  if (buf.length < IV_BYTES + 16) {
    throw new Error(
      `${context}: malformed ciphertext (likely corrupted row): blob is ${buf.length} bytes, need at least ${IV_BYTES + 16} for iv+authTag`,
    );
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = buf.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv(ALGO, getKey(), iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(
      `${context}: auth verification failed (likely wrong key or tampered ciphertext): ${(e as Error).message}`,
    );
  }
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch (e) {
    throw new Error(
      `${context}: decrypted bytes are not valid JSON: ${(e as Error).message}`,
    );
  }
}

/** Predicate exposed for tests + migration scripts. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
