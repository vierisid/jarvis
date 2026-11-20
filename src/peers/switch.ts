/**
 * The switch for talking to other people's Jarvises.
 *
 * It ships dark, as the notch does (src/notch/switch.ts). The engine that
 * does the talking is a separate program that is not part of this product
 * yet (docs/peers/README.md). So the switch is the place of that program:
 * with JARVIS_PEERS_ENGINE unset, nothing is started and nothing of this
 * folder runs. Set to the full path of the engine, and with the notch on,
 * the brain starts it.
 *
 * A path that does not begin at the root is not taken: what gets run must
 * not depend on the folder the brain happened to be started in.
 */
import { isAbsolute } from 'node:path';

export const PEERS_ENGINE = 'JARVIS_PEERS_ENGINE';
/**
 * The same switch without a place: JARVIS_PEERS=1 turns this folder on with
 * no engine yet. One is then put in place when the person joins an
 * organisation or makes one (./install.ts).
 */
export const PEERS = 'JARVIS_PEERS';
/**
 * A checkout of the engine's source, for the one who makes an organisation:
 * its server is run from there (./host.ts). Unset, this machine can join an
 * organisation and cannot make one.
 */
export const PEERS_SOURCE = 'JARVIS_PEERS_SOURCE';

export function peersEnginePath(env: Record<string, string | undefined> = process.env): string | null {
  const path = env[PEERS_ENGINE]?.trim();
  return path && isAbsolute(path) ? path : null;
}

/** True when other people's Jarvises are switched on at all. */
export function peersOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[PEERS]?.trim() === '1' || peersEnginePath(env) !== null;
}

export function peersSourcePath(env: Record<string, string | undefined> = process.env): string | null {
  const path = env[PEERS_SOURCE]?.trim();
  return path && isAbsolute(path) ? path : null;
}
