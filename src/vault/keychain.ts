/**
 * Encrypted secrets store for JARVIS.
 *
 * Stores secrets in an AES-256-GCM encrypted file (~/.jarvis/.secrets.enc)
 * with a random key stored in ~/.jarvis/.secrets.key (chmod 600).
 *
 * This avoids depending on OS keychain daemons (which are unreliable on WSL2).
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const JARVIS_DIR = join(homedir(), '.jarvis');
const KEY_PATH = join(JARVIS_DIR, '.secrets.key');
const SECRETS_PATH = join(JARVIS_DIR, '.secrets.enc');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function ensureDir(): void {
  if (!existsSync(JARVIS_DIR)) {
    mkdirSync(JARVIS_DIR, { recursive: true });
  }
}

function getOrCreateKey(): Buffer {
  ensureDir();
  if (existsSync(KEY_PATH)) {
    const hex = readFileSync(KEY_PATH, 'utf-8').trim();
    return Buffer.from(hex, 'hex');
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  try { chmodSync(KEY_PATH, 0o600); } catch {}
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
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    const key = getOrCreateKey();
    const raw = readFileSync(SECRETS_PATH);
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
  writeFileSync(SECRETS_PATH, encrypted, { mode: 0o600 });
  try { chmodSync(SECRETS_PATH, 0o600); } catch {}
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

export function deleteSecret(name: string): void {
  const secrets = loadSecrets();
  delete secrets[name];
  saveSecrets(secrets);
}

export function hasSecret(name: string): boolean {
  const secrets = loadSecrets();
  return name in secrets;
}
