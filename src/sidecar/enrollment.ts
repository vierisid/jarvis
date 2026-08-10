/**
 * Standalone sidecar enrollment: key lifecycle + JWT mint + DB record,
 * shared by the SidecarManager (daemon) and the `jarvis enroll` /
 * `jarvis revoke` / `jarvis sidecars` CLIs.
 *
 * Deliberately free of daemon dependencies (no Service interface, no
 * scheduler/RPC imports) so a provisioning server can mint a device's JWT
 * BEFORE the daemon has ever started: open the vault DB, load or generate
 * the ES256 keypair, sign, upsert the record, print the token. The daemon
 * picks the record up live (validateToken reads the DB per connect and
 * SQLite runs in WAL mode, so a concurrent daemon sees it too).
 */

import {
  generateKeyPair,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
  importSPKI,
  SignJWT,
  type JWK,
} from 'jose';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, generateId } from '../vault/schema.ts';
import type { SidecarRecord, SidecarTokenClaims } from './types.ts';
import { chmodWithWarning, secureDirectory, secureWriteFile } from '../util/fs-secure.ts';
import { computeAnonId } from '../telemetry/anon-id.ts';

// Localhost host check anchored: matches `localhost`, `localhost:PORT`, but
// not e.g. `notlocalhost.example.com`. Used both for enrollment URL scheme
// inference and for startup warnings.
const LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/;

export function isLocalhostBrainUrl(brainBase: string): boolean {
  const normalized = brainBase.trim();
  if (/^(https?|wss?):\/\//.test(normalized)) {
    try {
      return LOCALHOST_HOST_RE.test(new URL(normalized).host);
    } catch {
      return false;
    }
  }
  return LOCALHOST_HOST_RE.test(normalized);
}

// Build the JWT-bound enrollment URLs from a single canonical brain base —
// either a full URL (`https://brain.example.com`, `wss://...`) or a bare
// host[:port] (`brain.example.com`, `10.0.0.5:3142`). Pure function: no
// request input, no env, no class state. The single source of truth is
// whatever the brain operator configured at startup.
export function buildEnrollmentUrls(brainBase: string): { brainWs: string; jwksUrl: string } {
  const normalized = brainBase.trim();

  if (/^(https?|wss?):\/\//.test(normalized)) {
    const parsed = new URL(normalized);
    const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    return {
      brainWs: `${isSecure ? 'wss' : 'ws'}://${parsed.host}/sidecar/connect`,
      jwksUrl: `${isSecure ? 'https' : 'http'}://${parsed.host}/api/sidecars/.well-known/jwks.json`,
    };
  }

  // Bare host: assume insecure only for explicit local hosts. A remote
  // host with an explicit port (`brain.example.com:443`) used to be
  // misclassified as insecure by a `:\d+$` heuristic; require a known
  // local host instead so production deployments default to wss/https.
  const isSecure = !LOCALHOST_HOST_RE.test(normalized);
  return {
    brainWs: `${isSecure ? 'wss' : 'ws'}://${normalized}/sidecar/connect`,
    jwksUrl: `${isSecure ? 'https' : 'http'}://${normalized}/api/sidecars/.well-known/jwks.json`,
  };
}

export const ENROLLMENT_ALG = 'ES256';
const KEY_DIR_NAME = 'sidecar-keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';

export interface SidecarKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
  keyId: string;
}

export function sidecarKeyPaths(dataDir: string): { dir: string; privatePem: string; publicPem: string } {
  const dir = path.join(dataDir, KEY_DIR_NAME);
  return {
    dir,
    privatePem: path.join(dir, PRIVATE_KEY_FILE),
    publicPem: path.join(dir, PUBLIC_KEY_FILE),
  };
}

/**
 * Load the brain's ES256 keypair, generating and persisting one on first
 * use. Safe to call from the CLI while the daemon is stopped OR from the
 * daemon itself - both sides converge on the same key files.
 */
export async function loadOrGenerateSidecarKeys(
  dataDir: string,
  log: (msg: string) => void = () => {},
): Promise<SidecarKeys> {
  const paths = sidecarKeyPaths(dataDir);
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  if (existsSync(paths.privatePem) && existsSync(paths.publicPem)) {
    privateKey = await importPKCS8(await Bun.file(paths.privatePem).text(), ENROLLMENT_ALG, { extractable: true });
    publicKey = await importSPKI(await Bun.file(paths.publicPem).text(), ENROLLMENT_ALG, { extractable: true });
    await secureKeyFilePermissions(dataDir);
    log('Loaded existing ES256 key pair');
  } else {
    await secureDirectory(paths.dir, 0o700);
    ({ privateKey, publicKey } = await generateKeyPair(ENROLLMENT_ALG, { extractable: true }));
    await secureWriteFile(paths.privatePem, await exportPKCS8(privateKey), 0o600, 'SidecarEnrollment');
    // public.pem contains the SPKI public key, so world-readable 0644 is intentional.
    await secureWriteFile(paths.publicPem, await exportSPKI(publicKey), 0o644, 'SidecarEnrollment');
    await secureKeyFilePermissions(dataDir);
    log('Generated new ES256 key pair');
  }

  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicKey,
    publicJwk,
    keyId: publicJwk.x ?? 'default', // x-coordinate as kid (stable, unique)
  };
}

export async function secureKeyFilePermissions(dataDir: string): Promise<void> {
  const paths = sidecarKeyPaths(dataDir);
  await chmodWithWarning(paths.dir, 0o700, 'SidecarEnrollment');
  await chmodWithWarning(paths.privatePem, 0o600, 'SidecarEnrollment');
  await chmodWithWarning(paths.publicPem, 0o644, 'SidecarEnrollment');
}

/** Shared device-name rules (1-64 chars, [a-zA-Z0-9_-]). Returns the trimmed name. */
export function validateSidecarName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) {
    throw new Error('Sidecar name must be 1-64 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error('Sidecar name may only contain letters, numbers, hyphens, and underscores');
  }
  return trimmed;
}

export interface EnrollResult {
  token: string;
  sidecar: SidecarRecord;
  /** false when an enrolled device with this name already existed (re-mint). */
  created: boolean;
}

export interface EnrollOptions {
  /**
   * What to do when an enrolled sidecar with this name already exists:
   * - 'upsert' (CLI/provisioning): keep the sid, mint a fresh JWT, update
   *   token_id. Retried device-adds and host migrations converge on the
   *   same device record instead of erroring or duplicating.
   * - 'reject' (dashboard API): error, preserving the historical behavior.
   */
  onExisting: 'upsert' | 'reject';
  /**
   * With 'upsert': give the device a NEW sid instead of keeping the old one,
   * which invalidates every previously minted JWT for it (validation is by
   * sid; the old row is deleted). Use after a suspected token leak. A live
   * session on the old sid is severed by the daemon's revocation sweep.
   */
  rotate?: boolean;
  keys?: SidecarKeys;
}

/**
 * Enroll (or re-mint for) a device by name. Requires an initialized vault DB
 * (initDatabase) and a configured brain URL (`daemon.brain_domain`).
 */
export async function enrollDevice(
  dataDir: string,
  brainUrl: string,
  name: string,
  options: EnrollOptions,
): Promise<EnrollResult> {
  if (!brainUrl) {
    throw new Error('Brain URL not configured - set daemon.public_url (or JARVIS_PUBLIC_URL)');
  }
  const trimmed = validateSidecarName(name);
  const keys = options.keys ?? (await loadOrGenerateSidecarKeys(dataDir));

  const db = getDb();
  let existing = db
    .query('SELECT id FROM sidecars WHERE name = ? AND status = ?')
    .get(trimmed, 'enrolled') as { id: string } | null;

  if (existing && options.onExisting === 'reject') {
    throw new Error(`Sidecar "${trimmed}" is already enrolled`);
  }

  if (existing && options.rotate) {
    db.run('DELETE FROM sidecars WHERE id = ?', [existing.id]);
    existing = null; // fall through to a brand-new sid
  }

  const id = existing?.id ?? generateId();
  const tokenId = generateId();
  const { brainWs, jwksUrl } = buildEnrollmentUrls(brainUrl);

  // `bid` is the brain's anonymous telemetry id so the sidecar can report
  // which brain it belongs to; never the raw hostname/username.
  const token = await new SignJWT({
    sid: id,
    name: trimmed,
    brain: brainWs,
    jwks: jwksUrl,
    bid: computeAnonId(),
  } satisfies Omit<SidecarTokenClaims, 'sub' | 'jti' | 'iat'>)
    .setProtectedHeader({ alg: ENROLLMENT_ALG, kid: keys.keyId })
    .setSubject(`sidecar:${id}`)
    .setJti(tokenId)
    .setIssuedAt()
    .sign(keys.privateKey);

  if (existing) {
    // Re-mint: same device record, fresh jti. The previous JWT stays valid
    // (validation checks enrollment by sid, not jti) so a retry can never
    // strand a device that already received the earlier token.
    db.run('UPDATE sidecars SET token_id = ? WHERE id = ?', [tokenId, id]);
  } else {
    db.run('INSERT INTO sidecars (id, name, token_id) VALUES (?, ?, ?)', [id, trimmed, tokenId]);
  }

  const sidecar = db.query('SELECT * FROM sidecars WHERE id = ?').get(id) as SidecarRecord;
  return { token, sidecar, created: !existing };
}
