/**
 * Encrypted secrets store for JARVIS.
 *
 * Stores secrets in an AES-256-GCM encrypted file (.secrets.enc) with a random
 * key alongside it (.secrets.key, chmod 600), in the daemon's data dir:
 * `JARVIS_HOME` when set, else ~/.jarvis — the same resolution pid.ts and the
 * config loader use. Installs that predate that awareness keep reading their
 * ~/.jarvis pair until migrateKeychainToDataDir() relocates it.
 *
 * This avoids depending on OS keychain daemons (which are unreliable on WSL2).
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { constants as fsConstants, existsSync, readFileSync, mkdirSync, chmodSync, openSync, writeSync, closeSync, fsyncSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const KEY_FILE = '.secrets.key';
const SECRETS_FILE = '.secrets.enc';

/** Where the keychain lived before JARVIS_HOME was honored. */
function legacyDir(): string {
  return join(homedir(), '.jarvis');
}

/** True when a dir holds either half of a keychain pair. */
function hasKeychain(dir: string): boolean {
  return existsSync(join(dir, KEY_FILE)) || existsSync(join(dir, SECRETS_FILE));
}

/**
 * The data dir this install is configured for, ignoring what is on disk.
 *
 * `JARVIS_SECRETS_DIR` is an explicit override that wins over everything and
 * disables the legacy fallback below: tests point it at a throwaway dir so
 * they can never touch the real store, and an operator can point it at a
 * mounted secrets volume. Everything that needs to know where the keychain is
 * (e.g. `jarvis export`) must resolve it through here rather than assume a
 * path, or the two drift apart.
 */
function configuredDir(): string {
  const override = process.env.JARVIS_SECRETS_DIR || process.env.JARVIS_HOME;
  return override ? resolve(override) : legacyDir();
}

/**
 * Which of the two candidate dirs holds the live keychain. An install whose
 * data dir has no keychain yet, but whose ~/.jarvis does, keeps using the
 * legacy pair for BOTH reads and writes — splitting .secrets.key from
 * .secrets.enc across two directories would leave the ciphertext
 * undecryptable. migrateKeychain() ends that state deliberately.
 *
 * Takes its dirs as arguments so the rule is testable without a real home dir.
 */
export function resolveKeychainDir(configured: string, legacy: string): string {
  if (configured === legacy || hasKeychain(configured)) return configured;
  return hasKeychain(legacy) ? legacy : configured;
}

/** Directory actually in use. Resolved per call, never cached. */
export function keychainDir(): string {
  // Guard: under `bun test` (bun sets NODE_ENV=test) with no explicit dir
  // override, this would resolve to the developer's REAL keychain — a test
  // file missing its JARVIS_SECRETS_DIR setup once deleted real keys. Fail
  // loudly instead of touching it.
  if (process.env.NODE_ENV === 'test' && !process.env.JARVIS_SECRETS_DIR && !process.env.JARVIS_HOME) {
    throw new Error('Refusing to touch the real keychain under test: point JARVIS_SECRETS_DIR at a temp dir in your test setup (see user-settings.test.ts)');
  }
  const configured = configuredDir();
  if (process.env.JARVIS_SECRETS_DIR) return configured;
  return resolveKeychainDir(configured, legacyDir());
}

/** Absolute paths of the keychain pair currently in use. */
export function keychainPaths(): { keyPath: string; secretsPath: string } {
  const dir = keychainDir();
  return { keyPath: join(dir, KEY_FILE), secretsPath: join(dir, SECRETS_FILE) };
}

function keyPath(): string {
  return keychainPaths().keyPath;
}

function secretsPath(): string {
  return keychainPaths().secretsPath;
}

function ensureDir(dir = keychainDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Keychain] Failed to chmod ${dir} to 700: ${message}`);
  }
}

/**
 * Write a secret file with O_NOFOLLOW so the call fails (ELOOP) if the path
 * is a symlink, preventing redirection to an attacker-controlled target.
 *
 * The write goes to a temp file that is fsynced and then renamed over the
 * target, so a crash or a short write can never leave a truncated
 * .secrets.enc behind — which loadSecrets would read as "no secrets" and the
 * next save would then make permanent.
 */
function writeSecretFileSync(path: string, data: string | Buffer, mode: number): void {
  const tmp = `${path}.tmp`;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fd = openSync(tmp, flags, mode);
  try {
    writeSync(fd, data as never);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  try { chmodSync(path, mode); } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Keychain] Failed to chmod ${path} to ${mode.toString(8)}: ${message}`);
  }
}

function getOrCreateKey(): Buffer {
  ensureDir();
  const path = keyPath();
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf-8').trim();
    return Buffer.from(hex, 'hex');
  }
  const key = randomBytes(32);
  writeSecretFileSync(path, key.toString('hex'), 0o600);
  return key;
}

function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(key: Buffer, data: Buffer): string {
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

/** Decrypt the pair in `dir`, throwing on any failure. {} when nothing stored. */
function readSecretsAt(dir: string): Record<string, string> {
  const secrets = join(dir, SECRETS_FILE);
  if (!existsSync(secrets)) return {};
  const hex = readFileSync(join(dir, KEY_FILE), 'utf-8').trim();
  return JSON.parse(decrypt(Buffer.from(hex, 'hex'), readFileSync(secrets)));
}

/**
 * The active store, throwing when it exists but cannot be read — a missing key
 * file, a wrong key, a truncated file. Writers use this so a store we could
 * not read is never encrypted over: that would turn a recoverable problem
 * (restore the matching .secrets.key) into the permanent loss of every
 * credential. Readers use loadSecrets() below, which degrades to "no secrets".
 */
function readSecrets(): Record<string, string> {
  const dir = keychainDir();
  try {
    return readSecretsAt(dir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Keychain at ${join(dir, SECRETS_FILE)} could not be read (${reason}). `
      + `Restore the matching ${KEY_FILE}, or move both files aside to start a new store.`,
      { cause: err },
    );
  }
}

/** Read-side view: an unreadable store behaves as empty, loudly, never fatally. */
function loadSecrets(): Record<string, string> {
  try {
    return readSecrets();
  } catch (err) {
    console.error(`[Keychain] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function saveSecrets(secrets: Record<string, string>): void {
  ensureDir();
  const key = getOrCreateKey();
  const json = JSON.stringify(secrets);
  const encrypted = encrypt(key, json);
  writeSecretFileSync(secretsPath(), encrypted, 0o600);
}

/**
 * Move a keychain pair from `from` to `to`: copy, verify the copy decrypts to
 * the same secrets, and only then remove the originals. A failed verification
 * leaves the source untouched and authoritative, so the worst case is "not
 * migrated yet", never "lost". Returns true when the pair moved.
 *
 * No-op when the destination already holds a keychain or the source has none.
 */
export function migrateKeychain(from: string, to: string): boolean {
  if (from === to || hasKeychain(to) || !hasKeychain(from)) return false;

  const expected = readSecretsAt(from); // throws only if the source pair is broken
  ensureDir(to);
  // Any failure past this point must leave the destination EMPTY: one stray
  // file there makes hasKeychain(to) true forever, and resolveKeychainDir
  // would stop falling back to the intact pair still sitting in `from`.
  try {
    for (const name of [KEY_FILE, SECRETS_FILE]) {
      const src = join(from, name);
      if (existsSync(src)) writeSecretFileSync(join(to, name), readFileSync(src), 0o600);
    }
    if (JSON.stringify(readSecretsAt(to)) !== JSON.stringify(expected)) {
      throw new Error('the copy does not match the source');
    }
  } catch (err) {
    for (const name of [KEY_FILE, SECRETS_FILE]) rmSync(join(to, name), { force: true });
    console.error(`[Keychain] Copy to ${to} failed (${err instanceof Error ? err.message : String(err)}); keeping the keychain in ${from}`);
    return false;
  }

  for (const name of [KEY_FILE, SECRETS_FILE]) rmSync(join(from, name), { force: true });
  console.log(`[Keychain] Moved the keychain from ${from} to ${to}; backups of the data dir now include it`);
  return true;
}

/**
 * Relocate a pre-JARVIS_HOME keychain into the configured data dir.
 *
 * Called once at daemon boot. Deliberately NOT triggered by path resolution:
 * a CLI, a test, or any process that merely reads a secret must never move the
 * store out from under the machine it is running on.
 */
export function migrateKeychainToDataDir(): void {
  if (process.env.JARVIS_SECRETS_DIR) return; // explicit override: leave it alone
  migrateKeychain(legacyDir(), configuredDir());
}

export function getSecret(name: string): string | null {
  const secrets = loadSecrets();
  return secrets[name] ?? null;
}

export function setSecret(name: string, value: string): void {
  const secrets = readSecrets();
  secrets[name] = value;
  saveSecrets(secrets);
}

/**
 * Apply several writes in ONE decrypt/encrypt pass; `null` deletes the entry.
 * Callers that persist a group of related credentials (e.g. every key of a
 * config section) should prefer this over N setSecret calls, each of which
 * rewrites the whole file. No-ops when every entry already has the requested
 * value.
 *
 * Throws when the existing store cannot be read, rather than replacing it with
 * one holding only these entries.
 */
export function setSecrets(entries: Record<string, string | null>): void {
  const secrets = readSecrets();
  let changed = false;
  for (const [name, value] of Object.entries(entries)) {
    if (value === null) {
      if (name in secrets) {
        delete secrets[name];
        changed = true;
      }
    } else if (secrets[name] !== value) {
      secrets[name] = value;
      changed = true;
    }
  }
  if (changed) saveSecrets(secrets);
}

export function deleteSecret(name: string): void {
  const secrets = readSecrets();
  delete secrets[name];
  saveSecrets(secrets);
}

export function hasSecret(name: string): boolean {
  const secrets = loadSecrets();
  return name in secrets;
}
