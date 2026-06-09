import { createHash } from 'node:crypto';
import os from 'node:os';

/**
 * Namespace prefix mixed into the hash so the digest is specific to JARVIS
 * telemetry and can be rotated (bump the version) without colliding with any
 * other hash of the same hostname+username.
 */
const ANON_ID_NAMESPACE = 'jarvis-telemetry-v1';

/**
 * Deterministic, non-reversible anonymous machine id.
 *
 * Derived from the OS hostname + username so the SAME machine produces the
 * SAME id across restarts, reinstalls, and DB wipes -- which is what makes
 * "unique user base" and retention numbers meaningful. We hash with a fixed
 * namespace prefix and only ever transmit the 128-bit hex digest; the raw
 * hostname/username never leave the machine.
 *
 * This is anonymous, not secret: hostname+username is low-entropy, so a
 * party that already knows a specific machine's values could confirm a
 * match. That is acceptable for aggregate usage metrics -- we never store
 * or send the inputs, and we cannot reverse the digest back to them.
 */
export function computeAnonId(input?: { hostname?: string; username?: string }): string {
  const hostname = input?.hostname ?? safeHostname();
  const username = input?.username ?? safeUsername();
  return createHash('sha256')
    .update(`${ANON_ID_NAMESPACE}:${hostname}:${username}`)
    .digest('hex')
    .slice(0, 32);
}

function safeHostname(): string {
  try {
    return os.hostname() || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

function safeUsername(): string {
  try {
    return os.userInfo().username || 'unknown-user';
  } catch {
    return 'unknown-user';
  }
}
