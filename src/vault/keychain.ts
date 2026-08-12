/**
 * Encrypted secrets store for JARVIS.
 *
 * Stores secrets in an AES-256-GCM encrypted file (~/.jarvis/.secrets.enc)
 * with a random key stored in ~/.jarvis/.secrets.key (chmod 600).
 *
 * This avoids depending on OS keychain daemons (which are unreliable on WSL2).
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { constants as fsConstants, existsSync, readFileSync, mkdirSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Directory holding the keychain pair. Resolved per call, not at module load,
 * so `JARVIS_SECRETS_DIR` can redirect it — a seam for tests, which must never
 * write into the developer's real store.
 *
 * Deliberately NOT JARVIS_HOME-aware: hosted deployments set that variable and
 * their existing secrets live in ~/.jarvis, so honoring it here would move the
 * keychain out from under them on upgrade.
 */
function jarvisDir(): string {
  return process.env.JARVIS_SECRETS_DIR || join(homedir(), '.jarvis');
}

function keyPath(): string {
  return join(jarvisDir(), '.secrets.key');
}

function secretsPath(): string {
  return join(jarvisDir(), '.secrets.enc');
}

function ensureDir(): void {
  const dir = jarvisDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Keychain] Failed to chmod ${dir} to 700: ${message}`);
  }
}

/**
 * Write a secret file with O_NOFOLLOW so the call fails (ELOOP) if the path
 * is a symlink, preventing redirection to an attacker-controlled target.
 */
function writeSecretFileSync(path: string, data: string | Buffer, mode: number): void {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fd = openSync(path, flags, mode);
  try {
    writeSync(fd, data as never);
  } finally {
    closeSync(fd);
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

function loadSecrets(): Record<string, string> {
  if (!existsSync(secretsPath())) return {};
  try {
    const key = getOrCreateKey();
    const raw = readFileSync(secretsPath());
    const json = decrypt(key, raw);
    return JSON.parse(json);
  } catch (err) {
    console.warn('[Keychain] Failed to decrypt secrets file, starting fresh:', err);
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

export function getSecret(name: string): string | null {
  const secrets = loadSecrets();
  return secrets[name] ?? null;
}

export function setSecret(name: string, value: string): void {
  const secrets = loadSecrets();
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
 * One file write, not an atomic one: saveSecrets truncates in place, so a
 * crash mid-write still loses the file (and loadSecrets then starts empty).
 * Grouping shrinks that window; it does not close it.
 */
export function setSecrets(entries: Record<string, string | null>): void {
  const secrets = loadSecrets();
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
  const secrets = loadSecrets();
  delete secrets[name];
  saveSecrets(secrets);
}

export function hasSecret(name: string): boolean {
  const secrets = loadSecrets();
  return name in secrets;
}
